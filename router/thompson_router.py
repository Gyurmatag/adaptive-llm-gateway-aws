"""Thompson sampling routing strategy on LiteLLM's CustomRoutingStrategyBase.

This is a supported extension point, not a fork. Provider adapters, retries,
cooldowns, fallbacks, rate-limit awareness and spend tracking all still come
from LiteLLM. What is here is roughly 150 lines of selection logic.

Selection, per request:
    theta_i ~ Beta(alpha_i, beta_i)          # sample each arm's belief
    score_i = theta_i / (cost_i ** gamma)    # divide by cost, gamma is the dial
    pick argmax(score_i)

Good arms earn traffic. Uncertain arms still get tried, because a wide
posterior sometimes samples high - that is exploration falling out of the
mathematics rather than being bolted on as an epsilon.
"""

from __future__ import annotations

import os
import random
import time
from typing import Any

from router import policy, shadow
from router.rewards import audit, task_class_of
from router.state import STATE

try:  # pragma: no cover - exercised only inside the proxy
    from litellm.types.router import CustomRoutingStrategyBase
except ImportError:  # keeps the module importable for tests without litellm
    class CustomRoutingStrategyBase:  # type: ignore[no-redef]
        pass


GAMMA = float(os.environ.get("ROUTER_GAMMA", "0.35"))
SESSION_TTL = int(os.environ.get("ROUTER_SESSION_TTL", "3600"))
SESSION_AFFINITY = os.environ.get("ROUTER_SESSION_AFFINITY", "true").lower() == "true"
QUALITY_FLOOR = float(os.environ.get("ROUTER_QUALITY_FLOOR", "0.0"))
PINNED_ARM = os.environ.get("ROUTER_PIN_ARM", "").strip()

# Cold-start exploration floor.
#
# Without this the demo does not work, and the reason is worth stating on stage.
# The real Bedrock fleet spans roughly a 50x cost range. With any gamma above
# zero the cost term dominates the Thompson score so consistently that the
# expensive arms are never sampled, never judged, and their posteriors stay at
# the prior - a flat curve, which from the back of a room reads as a bug rather
# than as an unexplored arm.
#
# So: until every arm has MIN_OBS real observations, a fraction of traffic is
# steered to the least-observed arm. Once every arm clears the floor,
# exploration stops entirely and pure Thompson sampling takes over. This is the
# standard cold-start answer and it is honest - the alternative is a dashboard
# that looks converged because most of it was never tried.
MIN_OBS = int(os.environ.get("ROUTER_MIN_OBS", "30"))
EXPLORE_P = float(os.environ.get("ROUTER_EXPLORE_P", "0.35"))


def _cost_per_token(dep: dict) -> float:
    info = dep.get("model_info") or {}
    inp = float(info.get("input_cost_per_token") or 0.0)
    out = float(info.get("output_cost_per_token") or 0.0)
    # Blend assuming a roughly 3:1 input:output mix, which is what the demo
    # prompt pool actually produces. Exact ratio matters less than the
    # relative ordering of the arms.
    blended = (0.75 * inp) + (0.25 * out)
    return max(blended, 1e-9)


def _name(dep: dict) -> str:
    return (dep.get("model_info") or {}).get("id") or dep.get("model_name") or "unknown"


def _is_arm(dep: dict) -> bool:
    """The judge is a deployment but not a bandit arm."""
    return bool((dep.get("model_info") or {}).get("arm", True))


class ThompsonRouter(CustomRoutingStrategyBase):
    """Cost-aware Thompson sampling with session affinity and a snapshot mode."""

    def __init__(self, llm_router: Any = None, gamma: float | None = None) -> None:
        # Router.set_custom_routing_strategy() rebinds OUR bound method onto the
        # LiteLLM Router, so inside async_get_available_deployment `self` is
        # this object and not the Router. The Router therefore has to be held
        # explicitly - there is no self.router to reach for.
        self.llm_router = llm_router
        self.gamma = GAMMA if gamma is None else gamma
        # conversation id -> (arm_name, pinned_at)
        self._sessions: dict[str, tuple[str, float]] = {}
        self._policy = policy.load() if policy.mode() == "snapshot" else None

    # ------------------------------------------------------------------ helpers
    def _session_id(self, request_kwargs: dict | None) -> str | None:
        if not SESSION_AFFINITY or not request_kwargs:
            return None
        meta = request_kwargs.get("metadata") or {}
        return (meta.get("session_id") or meta.get("conversation_id")
                or request_kwargs.get("user"))

    def _pinned(self, sid: str | None, healthy: dict[str, dict]) -> dict | None:
        """Session affinity: keep a conversation on one arm.

        Every time the router switches model mid-session it throws away the
        warm prefix cache and pays the cache write again on the new model. On
        agent workloads where the cached prefix is most of the request, that
        can erase the entire routing gain. Slide 18.
        """
        if not sid:
            return None
        entry = self._sessions.get(sid)
        if not entry:
            return None
        arm, pinned_at = entry
        if time.time() - pinned_at > SESSION_TTL:
            self._sessions.pop(sid, None)
            return None
        # A pin to a dead arm is worse than no pin - Demo 4 depends on this.
        return healthy.get(arm)

    def _select(self, healthy: dict[str, dict], task_class: str
                ) -> tuple[str, dict[str, float], dict[str, float], str]:
        """The Thompson step. Returns (winner, thetas, scores, reason)."""
        # Cold-start exploration: steer to the least-observed arm until every
        # arm has enough evidence for its curve to mean something.
        under = [n for n in healthy
                 if STATE.arm(n, task_class).observations < MIN_OBS]
        if under and random.random() < EXPLORE_P:
            winner = min(under, key=lambda n: STATE.arm(n, task_class).observations)
            return winner, {}, {}, "cold_start_exploration"

        thetas: dict[str, float] = {}
        scores: dict[str, float] = {}
        for name, dep in healthy.items():
            arm = STATE.arm(name, task_class)
            theta = arm.sample()
            thetas[name] = theta
            # A quality floor the router may never route below. Arms whose
            # posterior mean sits under the floor are excluded outright, so
            # cost optimisation can never trade away below the minimum.
            if QUALITY_FLOOR > 0 and arm.observations >= 10 and arm.mean < QUALITY_FLOOR:
                scores[name] = float("-inf")
                continue
            scores[name] = theta / (_cost_per_token(dep) ** self.gamma)

        if not scores or all(v == float("-inf") for v in scores.values()):
            # Everything is below the floor. Serve the best available rather
            # than failing the request; a circuit breaker, not a cliff.
            winner = max(thetas, key=lambda k: thetas[k]) if thetas else next(iter(healthy))
        else:
            winner = max(scores, key=lambda k: scores[k])
        return winner, thetas, scores, "thompson"

    # --------------------------------------------------------- LiteLLM contract
    async def async_get_available_deployment(
        self,
        model: str,
        messages: list[dict] | None = None,
        input: Any = None,
        specific_deployment: bool | None = False,
        request_kwargs: dict | None = None,
    ) -> dict:
        healthy_list = await self._healthy(model, request_kwargs)
        healthy = {_name(d): d for d in healthy_list if _is_arm(d)}
        if not healthy:
            # No arms left. Hand back whatever LiteLLM has so fallbacks and
            # retries still run rather than raising out of the strategy.
            return healthy_list[0] if healthy_list else {}

        task_class = task_class_of(messages)
        STATE.ensure_arms(list(healthy), task_class)
        if os.environ.get("ROUTER_DEBUG"):
            r = self.llm_router
            print(f"[dbg] acompletion={getattr(r.acompletion, '__name__', '?')} "
                  f"wrapped={getattr(r, '_thompson_wrapped', None)} "
                  f"arms={len(healthy)}", flush=True)

        # --- deterministic overrides and the circuit breaker ------------------
        if PINNED_ARM and PINNED_ARM in healthy:
            audit({"event": "route", "arm": PINNED_ARM, "reason": "operator_pin",
                   "task_class": task_class})
            return healthy[PINNED_ARM]

        # --- snapshot mode: frozen policy, deterministic serving ---------------
        if self._policy is not None:
            choice = self._policy.choose(task_class)
            if choice in healthy:
                STATE.record_choice(choice, task_class)
                audit({"event": "route", "arm": choice, "reason": "snapshot",
                       "policy_id": self._policy.policy_id, "task_class": task_class})
                return healthy[choice]

        # --- session affinity --------------------------------------------------
        sid = self._session_id(request_kwargs)
        pin = self._pinned(sid, healthy)
        if pin is not None:
            name = _name(pin)
            STATE.record_choice(name, task_class)
            audit({"event": "route", "arm": name, "reason": "session_affinity",
                   "session": str(sid)[:24], "task_class": task_class})
            return pin

        # --- the bandit --------------------------------------------------------
        winner, thetas, scores, reason = self._select(healthy, task_class)

        # --- shadow mode: compute the choice, do not serve it -------------------
        if shadow.enabled():
            incumbent = os.environ.get("ROUTER_INCUMBENT", "claude-sonnet")
            served = healthy.get(incumbent) or healthy[winner]
            shadow.record_decision(winner, _name(served), task_class, thetas, scores)
            STATE.record_choice(_name(served), task_class)
            return served

        if sid:
            self._sessions[sid] = (winner, time.time())
        STATE.record_choice(winner, task_class)
        audit({
            "event": "route", "arm": winner, "reason": reason,
            "task_class": task_class, "gamma": self.gamma,
            "theta": {k: round(v, 4) for k, v in thetas.items()},
            "score": {k: round(v, 4) for k, v in scores.items()},
        })
        return healthy[winner]

    async def _healthy(self, model: str, request_kwargs: dict | None) -> list[dict]:
        """Ask LiteLLM which deployments are actually available right now.

        This is what makes Demo 4 work without any custom failure handling:
        when kill_primary.sh zeroes the primary's rpm, LiteLLM drops it from
        this list and the bandit simply never samples it again. Cooldowns,
        rate-limit state and health checks all stay LiteLLM's job.
        """
        r = self.llm_router
        if r is None:
            return []
        try:
            healthy, _all = await r._async_get_healthy_deployments(
                model=model, parent_otel_span=None)
            if healthy:
                return list(healthy)
        except (AttributeError, TypeError, ValueError):
            pass
        try:
            return list(r.get_model_list(model_name=model) or [])
        except (AttributeError, TypeError):
            return []

    # Sync path. LiteLLM calls this when a caller uses the blocking API.
    def get_available_deployment(self, model: str, messages=None, input=None,
                                 specific_deployment=None, request_kwargs=None):
        raise NotImplementedError(
            "ThompsonRouter is async-only. Use acompletion / the proxy.")
