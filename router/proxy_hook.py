"""Installs the Thompson strategy into a running LiteLLM **proxy**.

Why this file exists, and it is worth a line on slide 19.

`Router.set_custom_routing_strategy()` is an SDK call. The proxy never calls it,
and `routing_strategy: custom` is rejected at config validation - the proxy only
accepts the built-in strategy names:

    ValueError: Invalid routing_strategy: 'custom'. Valid options:
    ['simple-shuffle', 'least-busy', 'latency-based-routing',
     'cost-based-routing', 'usage-based-routing-v2', 'usage-based-routing',
     'provider-budget-routing']

So the documented custom-routing extension point is reachable from the SDK but
not from proxy YAML, and the official AWS guidance deploys the proxy. This shim
is the bridge: it is loaded as an ordinary LiteLLM callback, waits for the proxy
to finish building its Router, and then installs the strategy onto it.

Note the irony worth naming out loud: the brief expected "SDK-only" to be the
*built-in adaptive router's* limitation. It is not - that one configures fine
from YAML. It is the **custom** extension point that is SDK-only.

Config:
    litellm_settings:
      callbacks: ["router.proxy_hook.instance"]
"""

from __future__ import annotations

import os
import threading
import time

try:
    from litellm.integrations.custom_logger import CustomLogger
except ImportError:  # tests without litellm installed
    class CustomLogger:  # type: ignore[no-redef]
        pass

from router.thompson_router import ThompsonRouter

_INSTALL_TIMEOUT_S = float(os.environ.get("ROUTER_INSTALL_TIMEOUT", "120"))
# Must be well under the gap between the kill switch and the audience noticing.
_WATCH_INTERVAL_S = float(os.environ.get("ROUTER_WATCH_INTERVAL", "2.0"))
# The model_name of the group the bandit routes within. Only this group's
# traffic moves the posteriors.
ROUTER_GROUP = os.environ.get("ROUTER_GROUP", "demo-router")


class ThompsonInstaller(CustomLogger):
    """Waits for the proxy's Router, then swaps in the Thompson strategy."""

    def __init__(self) -> None:
        super().__init__()
        self.installed = False
        self.strategy: ThompsonRouter | None = None
        self._thread: threading.Thread | None = None
        self._start()

    def _start(self) -> None:
        """Run the watchdog on a daemon THREAD, not an asyncio task.

        An asyncio task created at import time dies when the loop it was
        created on closes, and LiteLLM's proxy does its config loading on a
        temporary loop. The symptom was subtle: the strategy installed
        correctly at startup (proving the task ran once), and then the watchdog
        was simply gone - so the reset sentinel was never consumed and a
        rebuilt Router would never have been re-patched.

        Both install_now() and _check_reset() are synchronous, so a plain
        thread is the simpler and more durable home for them.
        """
        self._thread = threading.Thread(
            target=self._watch_forever, name="thompson-installer", daemon=True)
        self._thread.start()

    def _watch_forever(self) -> None:
        waited = 0.0
        while True:
            try:
                self._check_reset()
                if not self.install_now():
                    waited += _WATCH_INTERVAL_S
                    if waited >= _INSTALL_TIMEOUT_S:
                        print("[thompson] ERROR: proxy Router never appeared; "
                              "the gateway is serving with its DEFAULT strategy",
                              flush=True)
                        waited = 0.0
            except Exception as e:  # noqa: BLE001 - the watchdog must not die
                print(f"[thompson] watchdog error: {type(e).__name__}: {e}",
                      flush=True)
            time.sleep(_WATCH_INTERVAL_S)

    @staticmethod
    def _check_reset() -> None:
        """Honour the reset sentinel dropped by scripts/reset_demo.sh.

        The posteriors live in THIS process's memory. Deleting the state file
        from outside does nothing - the gateway simply rewrites it a second
        later from memory, which is why the first rehearsal started with 864
        requests and 10 errors already on the board. A sentinel file is the
        one signal that reaches in here without adding an admin endpoint to
        someone else's proxy.
        """
        from router.state import STATE, STATE_PATH

        sentinel = STATE_PATH.parent / "RESET"
        if not sentinel.exists():
            return
        STATE.reset()
        try:
            STATE.save()
            sentinel.unlink()
            for stale in ("audit.jsonl", "shadow.jsonl"):
                (STATE_PATH.parent / stale).unlink(missing_ok=True)
        except OSError:
            pass
        print("[thompson] state reset to priors", flush=True)

    def install_now(self) -> bool:
        """Idempotent, and re-arms itself if the proxy swapped the Router out."""
        try:
            from litellm.proxy import proxy_server
        except ImportError:
            return False
        router = getattr(proxy_server, "llm_router", None)
        if router is None:
            return False

        # Identity check, not a boolean flag: a rebuilt Router is a different
        # object and arrives unpatched.
        if getattr(router, "_thompson_wrapped", False) and self.installed:
            return True

        reinstall = self.installed
        self.strategy = ThompsonRouter(llm_router=router)
        router.set_custom_routing_strategy(self.strategy)
        self.installed = True

        # Price the counterfactual off the real fleet rather than a constant.
        try:
            from router import rewards
            costs = []
            for d in router.model_list or []:
                info = d.get("model_info") or {}
                if info.get("arm", True):
                    costs.append(float(info.get("output_cost_per_token") or 0.0))
            if costs:
                rewards.MAX_COST_PER_TOKEN = max(costs)
        except (AttributeError, TypeError, ValueError):
            pass

        # The judge is a Router deployment, so the reward path needs the Router.
        try:
            from router import rewards as _rw
            _rw.ROUTER = router
        except ImportError:
            pass

        self._wrap_completion(router)

        print(f"[thompson] {'re-installed (router was rebuilt)' if reinstall else 'installed'}: "
              f"gamma={self.strategy.gamma} arms={len(router.model_list or [])}",
              flush=True)
        return True

    def _wrap_completion(self, router) -> None:
        """Wrap Router.acompletion so every answer feeds the reward loop.

        Why not a LiteLLM callback: `litellm_settings.callbacks` and
        `success_callback` both register cleanly at startup - the proxy even
        logs "Initialized Success Callbacks" - but neither hook is actually
        invoked on the proxy's routed request path in this build. Verified by
        auditing on hook entry: 585 routing decisions, zero hook firings.

        Wrapping the coroutine we already own is deterministic and has no
        dependency on that plumbing. It also keeps the reward strictly off the
        hot path: the response is returned first, the judge runs after.
        """
        if getattr(router, "_thompson_wrapped", False):
            return
        original = router.acompletion
        # The judge calls through this, so it never re-enters the wrapper.
        router._thompson_original_acompletion = original

        async def wrapped(*args, **kwargs):
            start = time.perf_counter()
            try:
                response = await original(*args, **kwargs)
            except Exception:
                from router.rewards import audit as _audit
                from router.state import STATE as _S
                _S.total_errors += 1
                _audit({"event": "failure", "arm": kwargs.get("model", "?")})
                raise

            try:
                # Streaming responses cannot be judged without consuming the
                # iterator, so they contribute cost but no quality signal.
                if kwargs.get("stream"):
                    return response
                # Only learn from traffic the bandit actually routed.
                #
                # Demo 1 addresses deployments directly by name ("same curl,
                # three model strings"). Those requests bypass the router, and
                # LiteLLM assigns them auto-generated uuid deployment ids - so
                # observing them created junk arms named after 64-char hashes
                # and drew meaningless curves on the dashboard.
                if kwargs.get("model") != ROUTER_GROUP:
                    return response
                self._observe(kwargs, response,
                              (time.perf_counter() - start) * 1000.0)
            except Exception as e:  # noqa: BLE001 - never break the response
                from router.rewards import audit as _audit
                _audit({"event": "reward_error",
                        "error": f"{type(e).__name__}: {e}"})
            return response

        router.acompletion = wrapped
        router._thompson_wrapped = True

    def _observe(self, kwargs, response, latency_ms: float) -> None:
        from router import rewards

        arm = self._arm_of(response, kwargs)
        messages = kwargs.get("messages") or []
        question = str(messages[-1].get("content", "")) if messages else ""
        try:
            answer = response.choices[0].message.content or ""
        except (AttributeError, IndexError, KeyError, TypeError):
            answer = ""

        tokens, cost = rewards._usage(response)
        tc = rewards.task_class_of(messages)
        rewards.spawn(rewards.score_and_update(
            arm, question, answer, latency_ms, cost, tokens, tc))

    @staticmethod
    def _arm_of(response, kwargs) -> str:
        """Which deployment served this. model_info.id is set per arm in the
        config precisely so this is a readable name and not a generated uuid.

        kwargs["model"] is NOT a valid fallback for a grouped router: it is the
        GROUP name, so every posterior would collapse onto one fictional arm.
        """
        hidden = getattr(response, "_hidden_params", None) or {}
        for candidate in (hidden.get("model_id"),
                          hidden.get("deployment_model_name"),
                          getattr(response, "model", None)):
            if candidate and isinstance(candidate, str):
                return candidate
        return "unknown"

    # Belt and braces: if the background task never ran (no loop at import),
    # the first request through any logging hook installs the strategy.
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        self.install_now()

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self.install_now()

    def log_pre_api_call(self, model, messages, kwargs):
        self.install_now()


instance = ThompsonInstaller()
