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
from pathlib import Path
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
# The model_name of the group the bandit routes within.
ROUTER_GROUP = os.environ.get("ROUTER_GROUP", "demo-router")

# Circuit breaker: arms listed here are excluded from routing entirely.
#
# This is slide 19 point 3 - "deterministic overrides and a circuit breaker" -
# and it is also the Demo 4 kill switch, because LiteLLM's admin API cannot
# disable a CONFIG-FILE deployment at runtime:
#
#   POST /model/update {"litellm_params":{"rpm":0}}  -> silently does nothing
#                                                       (rpm reads back as None)
#   POST /model/delete {"id":"..."}                  -> 400, "not found in db"
#
# Config-defined deployments are not in the database, so the management API has
# no handle on them. Both calls return success-shaped responses and the model
# keeps taking traffic: measured 68 of the last 75 routing decisions going to a
# model that had just been "killed", with the error counter correctly at zero.
#
# A file is used rather than an env var so the switch can be thrown against a
# running process from a second terminal, which is the stage requirement.
DISABLED_FILE = Path(os.environ.get(
    "ROUTER_DISABLED_PATH",
    str(Path(os.environ.get("ROUTER_STATE_PATH", "router/state/posteriors.json")).parent
        / "DISABLED")))
_disabled_cache: tuple[float, frozenset[str]] = (0.0, frozenset())


def disabled_arms() -> frozenset[str]:
    """Arms currently broken out of the circuit. Re-read at most once a second."""
    global _disabled_cache
    now = time.time()
    if now - _disabled_cache[0] < 1.0:
        return _disabled_cache[1]
    try:
        names = frozenset(
            n.strip() for n in DISABLED_FILE.read_text().split() if n.strip())
    except OSError:
        names = frozenset()
    _disabled_cache = (now, names)
    return names

_breaker_warned: tuple[float, frozenset] = (0.0, frozenset())


def _warn_breaker(excluded: list[str]) -> None:
    """Say out loud that an arm is being withheld. Throttled to once a minute."""
    global _breaker_warned
    now = time.time()
    ex = frozenset(excluded)
    if not ex:
        return
    if ex == _breaker_warned[1] and now - _breaker_warned[0] < 60.0:
        return
    _breaker_warned = (now, ex)
    print(f"[thompson] CIRCUIT BREAKER: withholding {sorted(ex)} from routing. "
          f"These arms will not be sampled and their posteriors will freeze. "
          f"Clear with POST /dash/admin/enable.", flush=True)
    audit({"event": "breaker_active", "excluded": sorted(ex)})


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


def _name_set(deps) -> set[str]:
    return {_name(d) for d in (deps or []) if _is_arm(d)}


# Arms LiteLLM is currently withholding, and since when. Read by the dashboard.
EXCLUDED: dict[str, float] = {}


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
        self._snapshot_mode = policy.mode() == "snapshot"
        self._policy = policy.load() if self._snapshot_mode else None
        if self._snapshot_mode and self._policy is None:
            # Snapshot mode with no loadable artifact used to fall through to
            # the live bandit in silence: you asked for deterministic serving,
            # you got a self-modifying policy in the request path, and nothing
            # said so. That is the exact failure a model risk review exists to
            # catch. Serve deterministically anyway and be loud about it.
            print("[thompson] WARNING: ROUTER_MODE=snapshot but no policy "
                  f"artifact at {policy.snapshot_path()} - serving the "
                  "posterior argmax deterministically, NOT sampling. Export "
                  "one with: python -m router.policy export", flush=True)

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

    def _note_excluded(self, missing: set[str]) -> None:
        """Record and announce arms LiteLLM removed from the healthy list.

        Cooldowns are LiteLLM's job and that is the right division of labour -
        but an arm disappearing from routing has to be SAYABLE, or it looks
        like the bandit's fault for an entire rehearsal.
        """
        now = time.time()
        for name in missing:
            if name not in EXCLUDED:
                print(f"[thompson] LiteLLM is withholding '{name}' from the "
                      f"healthy list (cooldown or rate limit). It will not be "
                      f"sampled and its posterior will freeze.", flush=True)
                audit({"event": "arm_withheld", "arm": name})
            EXCLUDED[name] = now
        for name in [n for n in EXCLUDED if n not in missing]:
            dur = now - EXCLUDED.pop(name)
            print(f"[thompson] '{name}' is back in the healthy list after "
                  f"{dur:.0f}s", flush=True)
            audit({"event": "arm_restored", "arm": name, "withheld_s": round(dur, 1)})
        try:
            path = DISABLED_FILE.parent / "WITHHELD"
            if EXCLUDED:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("\n".join(sorted(EXCLUDED)) + "\n")
            else:
                path.unlink(missing_ok=True)
        except OSError:
            pass

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

        # Circuit breaker. LiteLLM's own fallbacks still apply to whatever is
        # left, so a request never fails because an arm was broken out.
        broken = disabled_arms()
        if broken:
            remaining = {k: v for k, v in healthy.items() if k not in broken}
            if remaining:
                # A broken-out arm used to vanish from routing in total silence.
                # The dashboard still drew it, with the posterior it had when it
                # was switched off, so it read as "under-observed" rather than
                # "disabled" - and a kill drill that was never reversed starved
                # ipr-nova for a whole rehearsal while every panel looked fine.
                # Observed: 0 selections out of 99, minobs stuck at 36, and a
                # convergence check that reported separated=False for a reason
                # that had nothing to do with the bandit.
                _warn_breaker(sorted(set(healthy) - set(remaining)))
                healthy = remaining
        if not healthy:
            # No arms left. Hand back whatever LiteLLM has so fallbacks and
            # retries still run rather than raising out of the strategy.
            return healthy_list[0] if healthy_list else {}

        # Only the bandit's own group registers arms. Demo 1 addresses
        # deployments directly by name, and LiteLLM still calls the strategy
        # for those - which created posteriors keyed by auto-generated uuids
        # and drew permanent flat curves labelled with 64-char hashes.
        if model != ROUTER_GROUP:
            return next(iter(healthy.values()))

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

        # --- snapshot mode with no artifact: deterministic, never sampled ------
        if self._snapshot_mode and self._policy is None:
            winner = max(healthy, key=lambda n: STATE.arm(n, task_class).mean)
            STATE.record_choice(winner, task_class)
            audit({"event": "route", "arm": winner, "reason": "snapshot_degraded",
                   "task_class": task_class})
            return healthy[winner]

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
                # LiteLLM can drop a deployment from this list - cooldowns after
                # allowed_fails, rate-limit state, health checks - and when it
                # does, the arm simply stops being offered to the bandit. From
                # the dashboard that is indistinguishable from an arm the
                # bandit chose not to sample: the curve just stops moving.
                #
                # Observed twice, both times on a phone hotspot: ipr-nova took 0
                # selections for an entire rehearsal and sat frozen at 19
                # observations while every other arm climbed past 60. Nothing
                # anywhere said the deployment had been withheld.
                self._note_excluded(_name_set(_all) - _name_set(healthy))
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
