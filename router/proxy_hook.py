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
        # Deployment ids that belong to the bandit's own group.
        self.group_arms: frozenset[str] = frozenset()
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

        # Which deployment ids are actually arms of the bandit's group.
        #
        # A fallback re-enters the router with the SUCCESSOR's model_name, and
        # the response then reports the direct deployment that served it - so
        # "demo-router falls back to claude-haiku" produced a posterior called
        # `direct-claude-haiku` that never received a reward and drew a
        # permanent flat curve on the dashboard. Only group members learn.
        try:
            self.group_arms = frozenset(
                (d.get("model_info") or {}).get("id")
                for d in (router.model_list or [])
                if d.get("model_name") == ROUTER_GROUP
                and (d.get("model_info") or {}).get("id"))
        except (AttributeError, TypeError):
            self.group_arms = frozenset()

        # The judge is a Router deployment, so the reward path needs the Router.
        try:
            from router import rewards as _rw
            _rw.ROUTER = router
        except ImportError:
            pass

        self._wrap_completion(router)
        self._mount_dashboard()

        print(f"[thompson] {'re-installed (router was rebuilt)' if reinstall else 'installed'}: "
              f"gamma={self.strategy.gamma} arms={len(router.model_list or [])}",
              flush=True)
        return True

    @staticmethod
    def _mount_dashboard() -> None:
        """Serve the dashboard's data endpoints from the gateway itself.

        The posteriors are in-process state inside THIS container. A separate
        ECS service cannot read them - there is no shared filesystem between
        Fargate tasks - so the local architecture (gateway + a sidecar FastAPI
        reading the same state file) does not survive the move to ECS.

        Mounting the routes onto LiteLLM's own FastAPI app solves it outright:
        the dashboard data comes from the process that owns the state, over the
        same ALB and the same CloudFront distribution as the gateway. Same
        origin, so the CORS pinning that dashboard-brief.md section 2 requires
        becomes unnecessary in the deployed topology rather than fragile.

        Local docker-compose keeps the standalone dashboard service, because
        there the state file IS shared and it is useful to run the UI without
        the gateway.
        """
        try:
            from litellm.proxy import proxy_server
        except ImportError:
            return
        app = getattr(proxy_server, "app", None)
        if app is None or getattr(app, "_thompson_dashboard", False):
            return
        try:
            import sys
            from pathlib import Path
            sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
            from dashboard.app import app as dash_app

            # Mount rather than copy routes: the dashboard app keeps its own
            # CORS middleware and its own static files.
            app.mount("/dash", dash_app)
            app._thompson_dashboard = True
            print("[thompson] dashboard mounted at /dash "
                  "(/dash/state, /dash/spend, /dash/stream)", flush=True)
        except Exception as e:  # noqa: BLE001 - never block gateway startup
            print(f"[thompson] dashboard mount failed: {type(e).__name__}: {e}",
                  flush=True)

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
            except Exception as exc:
                # CLIENT-VISIBLE errors only.
                #
                # Router.acompletion handles retries, cooldowns and the whole
                # fallback chain internally, so an exception escaping HERE is
                # one the caller actually saw. Bedrock throttles that were
                # absorbed by a fallback never reach this point, and counting
                # them would be wrong: a 52%-throttled run where every client
                # request succeeded is a working gateway, not a broken one.
                from router.rewards import audit as _audit
                from router.state import STATE as _S
                _S.total_errors += 1
                _audit({"event": "client_error",
                        "model": kwargs.get("model", "?"),
                        "error": f"{type(exc).__name__}: {exc}"[:200]})
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
        # A fallback may have served this from a deployment outside the group.
        # The request still succeeded - it just teaches the bandit nothing.
        if self.group_arms and arm not in self.group_arms:
            return
        messages = kwargs.get("messages") or []
        question = str(messages[-1].get("content", "")) if messages else ""
        try:
            answer = response.choices[0].message.content or ""
        except (AttributeError, IndexError, KeyError, TypeError):
            answer = ""

        tokens, cost = rewards._usage(response)
        # litellm.completion_cost() returns 0 for any deployment whose pricing
        # it cannot look up in its own model cost map - which is every custom
        # or proxied model. The visible symptom is a savings counter reading
        # "$0.00 actual / 100% saved", i.e. a fabricated headline number on the
        # largest element on screen. Price it from the configured per-token
        # costs instead, which are declared per arm in config.yaml anyway.
        if not cost:
            cost = self._price(response, arm)
        tc = rewards.task_class_of(messages)
        rewards.spawn(rewards.score_and_update(
            arm, question, answer, latency_ms, cost, tokens, tc))

    def _price(self, response, arm: str) -> float:
        """Cost from the arm's configured per-token prices."""
        router = getattr(self.strategy, "llm_router", None)
        if router is None:
            return 0.0
        info = {}
        for d in (router.model_list or []):
            if ((d.get("model_info") or {}).get("id")) == arm:
                info = d.get("model_info") or {}
                break
        if not info:
            return 0.0
        try:
            usage = response.usage
            pt = int(getattr(usage, "prompt_tokens", 0) or 0)
            ct = int(getattr(usage, "completion_tokens", 0) or 0)
        except (AttributeError, TypeError, ValueError):
            return 0.0
        return (pt * float(info.get("input_cost_per_token") or 0.0)
                + ct * float(info.get("output_cost_per_token") or 0.0))

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
