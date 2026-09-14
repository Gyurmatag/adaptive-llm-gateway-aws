"""Policy snapshot: export, import, and deterministic serving.

Slide 19, point 1. The demo runs in learn mode because watching the posteriors
separate is the entire visual argument. Nothing that learns in the request path
survives a bank's model risk review, so the production path is the other mode:

  learn    - posteriors update live in the request path (the demo)
  snapshot - a frozen, versioned, hash-identified artifact is loaded from disk,
             serving is deterministic, learning happens offline from logs

Promotion is a config change and rollback is a config revert. The request path
stops being non-deterministic, and every decision becomes reconstructable after
the fact, which is what "the router changed its mind" has to be replaced with.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

from router.state import GLOBAL_CLASS, RouterState

SCHEMA_VERSION = 1


def snapshot_path() -> Path:
    """Resolved at call time, not import time.

    Captured at import, a later ROUTER_POLICY_PATH silently has no effect - so
    a promotion that points the gateway at a new policy artifact would load the
    old one and nothing would say so.
    """
    return Path(os.environ.get("ROUTER_POLICY_PATH", "router/state/policy.json"))


def mode() -> str:
    m = os.environ.get("ROUTER_MODE", "learn").lower()
    return m if m in ("learn", "snapshot") else "learn"


@dataclass
class Policy:
    """A frozen routing policy. Deterministic given (task_class)."""

    weights: dict[str, dict[str, float]]  # task_class -> arm -> weight
    best: dict[str, str]                  # task_class -> argmax arm
    created_at: float
    gamma: float
    source_requests: int
    schema_version: int = SCHEMA_VERSION
    policy_id: str = ""

    def choose(self, task_class: str = GLOBAL_CLASS) -> str | None:
        """Deterministic serving. Same input, same arm, every time, forever."""
        return self.best.get(task_class) or self.best.get(GLOBAL_CLASS)

    def to_dict(self) -> dict:
        return {
            "schema_version": self.schema_version,
            "policy_id": self.policy_id,
            "created_at": self.created_at,
            "gamma": self.gamma,
            "source_requests": self.source_requests,
            "best": self.best,
            "weights": self.weights,
        }

    @classmethod
    def from_dict(cls, d: dict) -> Policy:
        return cls(
            weights=d["weights"], best=d["best"], created_at=d["created_at"],
            gamma=d["gamma"], source_requests=d.get("source_requests", 0),
            schema_version=d.get("schema_version", SCHEMA_VERSION),
            policy_id=d.get("policy_id", ""),
        )


def _policy_id(weights: dict, gamma: float) -> str:
    """Content hash. Two identical policies get the same id; any change moves it.

    This is what makes a policy a reviewable artifact rather than a mood.
    """
    blob = json.dumps({"w": weights, "g": gamma}, sort_keys=True).encode()
    return "pol_" + hashlib.sha256(blob).hexdigest()[:16]


def export(state: RouterState, gamma: float | None = None,
           path: Path | None = None) -> Policy:
    """Freeze the current posteriors into a deployable policy artifact."""
    g = float(gamma if gamma is not None else os.environ.get("ROUTER_GAMMA", "0.35"))

    weights: dict[str, dict[str, float]] = {}
    best: dict[str, str] = {}

    for tc, bucket in state.arms.items():
        scored: dict[str, float] = {}
        for name, arm in bucket.items():
            cost = _arm_cost(arm)
            # Posterior MEAN, not a sample. Freezing is the point: no
            # exploration in the served path.
            scored[name] = arm.mean / (cost ** g) if cost > 0 else arm.mean
        total = sum(scored.values()) or 1.0
        weights[tc] = {k: round(v / total, 6) for k, v in scored.items()}
        if scored:
            best[tc] = max(scored, key=lambda k: scored[k])

    pol = Policy(
        weights=weights, best=best, created_at=time.time(), gamma=g,
        source_requests=state.total_requests,
    )
    pol.policy_id = _policy_id(weights, g)

    p = Path(path or snapshot_path())
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(pol.to_dict(), indent=2))
    tmp.replace(p)
    return pol


def _arm_cost(arm) -> float:
    """Realised blended cost per token for this arm, with a floor."""
    if arm.total_tokens > 0 and arm.total_cost_usd > 0:
        return max(arm.total_cost_usd / arm.total_tokens, 1e-9)
    return 1e-6


def load(path: Path | None = None) -> Policy | None:
    p = Path(path or snapshot_path())
    if not p.exists():
        return None
    try:
        d = json.loads(p.read_text())
    except (json.JSONDecodeError, ValueError):
        return None
    if d.get("schema_version") != SCHEMA_VERSION:
        return None
    try:
        return Policy.from_dict(d)
    except KeyError:
        return None


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "export":
        st = RouterState.load()
        pol = export(st)
        print(json.dumps(pol.to_dict(), indent=2))
        print(f"\npolicy_id={pol.policy_id} from {pol.source_requests} requests",
              file=sys.stderr)
    else:
        pol = load()
        print(json.dumps(pol.to_dict(), indent=2) if pol else "no policy snapshot")
