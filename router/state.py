"""Beta posteriors, decay and persistence for the bandit arms.

One Beta(alpha, beta) belief per arm, optionally stratified by task class.

Stratification is not decoration. A context-free bandit optimises the *traffic
mix*: if 80% of traffic is easy prompts, the posterior converges to whichever
arm wins that 80% and the hard 20% degrades silently. Keeping a separate
posterior per task class is the cheap mitigation. See talk plan section 7
point 6 - and note that LiteLLM's built-in adaptive router does this out of the
box across 7 request types, which is the honest credit given in
handoff/branch-decision.md.
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# Global task class, used when stratification is switched off.
GLOBAL_CLASS = "_all"

# How many recent selections the rolling traffic split covers.
#
# This is a stage-timing decision, not a statistical one. The window has to
# drain before a killed arm shows 0%, so it sets how long Demo 4 takes to
# resolve visually. Measured on the deployed stack at 4 req/s with a window of
# 250: the killed arm reached 0% at t+65s, against a 90s budget for the whole
# beat. 150 brings that to roughly 40s, which leaves room to narrate.
#
# Smaller is snappier but noisier - below about 100 the split visibly jitters
# between polls and looks unstable rather than live.
ROLLING_WINDOW = int(os.environ.get("ROUTER_ROLLING_WINDOW", "150"))

STATE_PATH = Path(os.environ.get("ROUTER_STATE_PATH", "router/state/posteriors.json"))


@dataclass
class ArmState:
    """A single arm's belief about its own probability of a good-enough answer."""

    name: str
    alpha: float = 1.0
    beta: float = 1.0
    # Observations, kept separately from the posterior so the dashboard can
    # show "this arm has actually learned something" rather than inferring it
    # from prior mass. Same distinction the built-in router draws with
    # `samples` excluding cold-start prior mass.
    successes: int = 0
    failures: int = 0
    requests: int = 0
    judged: int = 0
    total_latency_ms: float = 0.0
    total_cost_usd: float = 0.0
    total_tokens: int = 0
    last_chosen_at: float = 0.0

    @property
    def mean(self) -> float:
        return self.alpha / (self.alpha + self.beta)

    @property
    def variance(self) -> float:
        a, b = self.alpha, self.beta
        return (a * b) / ((a + b) ** 2 * (a + b + 1.0))

    @property
    def observations(self) -> int:
        """Real observations that have moved the prior, excluding prior mass."""
        return self.successes + self.failures

    @property
    def avg_latency_ms(self) -> float:
        return self.total_latency_ms / self.requests if self.requests else 0.0

    def sample(self) -> float:
        """Draw theta ~ Beta(alpha, beta). This is the Thompson step."""
        return random.betavariate(self.alpha, self.beta)

    def update(self, success: bool) -> None:
        if success:
            self.alpha += 1.0
            self.successes += 1
        else:
            self.beta += 1.0
            self.failures += 1

    def decay(self, lam: float) -> None:
        """Fade old evidence toward the prior so the router can change its mind.

        alpha = 1 + (alpha - 1) * lambda, same for beta. Without this the
        posteriors harden and Demo 4's re-sort after the kill switch is
        invisible - which is the entire peak of the talk.

        It is also the honest answer to "vanilla Thompson sampling assumes a
        stationary world". It does. This is the patch.
        """
        self.alpha = 1.0 + (self.alpha - 1.0) * lam
        self.beta = 1.0 + (self.beta - 1.0) * lam


@dataclass
class RouterState:
    """All posteriors, plus the counters the dashboard reads."""

    # task_class -> arm_name -> ArmState
    arms: dict[str, dict[str, ArmState]] = field(default_factory=dict)
    total_requests: int = 0
    total_errors: int = 0
    actual_spend_usd: float = 0.0
    # What the same token volume would have cost on the most expensive arm.
    counterfactual_spend_usd: float = 0.0
    total_tokens: int = 0
    since_decay: int = 0
    started_at: float = field(default_factory=time.time)
    version: int = 1
    # Rolling window of recent arm selections.
    #
    # dashboard-brief.md section 4.2 asks for a ROLLING traffic split and the
    # distinction is not cosmetic. A cumulative share is a lifetime ratio: it
    # barely moves when a model stops being routed to, so after the Demo 4 kill
    # switch the killed arm still showed 63% of traffic. The panel that is
    # supposed to make the failover visible showed nothing at all.
    recent: list = field(default_factory=list)

    _lock: Any = field(default=None, repr=False, compare=False)

    def __post_init__(self) -> None:
        if self._lock is None:
            self._lock = asyncio.Lock()

    # ---------------------------------------------------------------- accessors
    def arm(self, name: str, task_class: str = GLOBAL_CLASS) -> ArmState:
        bucket = self.arms.setdefault(task_class, {})
        if name not in bucket:
            bucket[name] = ArmState(name=name)
        return bucket[name]

    def ensure_arms(self, names: list[str], task_class: str = GLOBAL_CLASS) -> None:
        for n in names:
            self.arm(n, task_class)

    def leader(self, task_class: str = GLOBAL_CLASS) -> str | None:
        bucket = self.arms.get(task_class, {})
        if not bucket:
            return None
        return max(bucket.values(), key=lambda a: a.mean).name

    # ----------------------------------------------------------------- mutation
    def record_choice(self, name: str, task_class: str = GLOBAL_CLASS) -> None:
        a = self.arm(name, task_class)
        a.requests += 1
        a.last_chosen_at = time.time()
        self.total_requests += 1
        self.recent.append(name)
        if len(self.recent) > ROLLING_WINDOW:
            del self.recent[:-ROLLING_WINDOW]

    def rolling_share(self) -> dict[str, float]:
        """Share of the last ROLLING_WINDOW selections, per arm."""
        if not self.recent:
            return {}
        n = len(self.recent)
        out: dict[str, float] = {}
        for name in self.recent:
            out[name] = out.get(name, 0.0) + 1.0 / n
        return out

    def record_outcome(
        self,
        name: str,
        success: bool,
        task_class: str = GLOBAL_CLASS,
        latency_ms: float = 0.0,
        cost_usd: float = 0.0,
        tokens: int = 0,
        max_cost_per_token: float = 0.0,
    ) -> None:
        a = self.arm(name, task_class)
        a.update(success)
        a.judged += 1
        a.total_latency_ms += latency_ms
        a.total_cost_usd += cost_usd
        a.total_tokens += tokens

        self.actual_spend_usd += cost_usd
        self.total_tokens += tokens
        # Counterfactual: the same tokens, all sent to the priciest arm.
        self.counterfactual_spend_usd += tokens * max_cost_per_token

        self.since_decay += 1

    def maybe_decay(self, lam: float, every: int) -> bool:
        if every <= 0 or self.since_decay < every:
            return False
        for bucket in self.arms.values():
            for a in bucket.values():
                a.decay(lam)
        self.since_decay = 0
        return True

    def reset(self, keep_arm_names: bool = False) -> None:
        """Back to priors. Used by scripts/reset_demo.sh between rehearsals.

        By default the arm dictionary is emptied rather than re-primed. Arms
        re-register themselves on the next request, and clearing them is what
        removes arms that should not be there at all - a mis-keyed deployment
        leaves a junk posterior behind that would otherwise survive every reset
        and draw a permanent flat curve on the dashboard.
        """
        if keep_arm_names:
            for bucket in self.arms.values():
                for a in list(bucket.values()):
                    bucket[a.name] = ArmState(name=a.name)
        else:
            self.arms = {}
        self.total_requests = 0
        self.total_errors = 0
        self.actual_spend_usd = 0.0
        self.counterfactual_spend_usd = 0.0
        self.total_tokens = 0
        self.since_decay = 0
        self.recent = []
        self.started_at = time.time()
        self.version += 1

    # -------------------------------------------------------------- serialising
    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "started_at": self.started_at,
            "total_requests": self.total_requests,
            "total_errors": self.total_errors,
            "actual_spend_usd": self.actual_spend_usd,
            "counterfactual_spend_usd": self.counterfactual_spend_usd,
            "total_tokens": self.total_tokens,
            "since_decay": self.since_decay,
            "recent": self.recent[-ROLLING_WINDOW:],
            "arms": {
                tc: {n: asdict(a) for n, a in bucket.items()}
                for tc, bucket in self.arms.items()
            },
        }

    @classmethod
    def from_dict(cls, d: dict) -> RouterState:
        st = cls(
            total_requests=d.get("total_requests", 0),
            total_errors=d.get("total_errors", 0),
            actual_spend_usd=d.get("actual_spend_usd", 0.0),
            counterfactual_spend_usd=d.get("counterfactual_spend_usd", 0.0),
            total_tokens=d.get("total_tokens", 0),
            since_decay=d.get("since_decay", 0),
            recent=list(d.get("recent") or []),
            started_at=d.get("started_at", time.time()),
            version=d.get("version", 1),
        )
        for tc, bucket in (d.get("arms") or {}).items():
            for n, raw in bucket.items():
                raw.pop("name", None)
                st.arms.setdefault(tc, {})[n] = ArmState(name=n, **raw)
        return st

    def save(self, path: Path | None = None) -> Path:
        p = Path(path or STATE_PATH)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.to_dict(), indent=2))
        tmp.replace(p)  # atomic, so a mid-write crash cannot corrupt state
        return p

    @classmethod
    def load(cls, path: Path | None = None) -> RouterState:
        p = Path(path or STATE_PATH)
        if not p.exists():
            return cls()
        try:
            return cls.from_dict(json.loads(p.read_text()))
        except (json.JSONDecodeError, TypeError, ValueError):
            # A corrupt state file must never take the gateway down mid-talk.
            return cls()


# Process-wide singleton the router, dashboard and reward callbacks share.
STATE = RouterState.load()
