"""Shadow mode: log what the router would have chosen, serve with the incumbent.

Slide 19, point 2. You do not promote a learned router because it looked good
on a dashboard; you run it in the dark alongside whatever is serving today,
compare the counterfactual offline, and promote on evidence.

In shadow mode `thompson_router` still computes its full Thompson choice and
records it, but returns the incumbent deployment so live traffic is untouched.
`report()` produces the comparison a promotion decision is actually made on.
"""

from __future__ import annotations

import json
import os
import time
from collections import defaultdict
from pathlib import Path

SHADOW_PATH = Path(os.environ.get("ROUTER_SHADOW_PATH", "router/state/shadow.jsonl"))
INCUMBENT = os.environ.get("ROUTER_INCUMBENT", "claude-sonnet")


def enabled() -> bool:
    return os.environ.get("ROUTER_SHADOW", "false").lower() == "true"


def record_decision(
    would_choose: str, incumbent: str, task_class: str,
    sampled: dict[str, float], scores: dict[str, float],
) -> None:
    """One line per request: what the shadow router wanted, what actually served."""
    _append({
        "kind": "decision",
        "would_choose": would_choose,
        "incumbent": incumbent,
        "task_class": task_class,
        "theta": {k: round(v, 4) for k, v in sampled.items()},
        "score": {k: round(v, 4) for k, v in scores.items()},
        "agreed": would_choose == incumbent,
    })


def record_actual(arm: str, task_class: str, cost_usd: float, latency_ms: float) -> None:
    """The realised outcome of whatever actually served."""
    _append({
        "kind": "actual", "arm": arm, "task_class": task_class,
        "cost_usd": cost_usd, "latency_ms": round(latency_ms, 1),
    })


def _append(row: dict) -> None:
    try:
        SHADOW_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(SHADOW_PATH, "a") as fh:
            fh.write(json.dumps({"ts": time.time(), **row}) + "\n")
    except OSError:
        pass


def report(path: Path | None = None) -> dict:
    """Counterfactual comparison. This is the promotion gate artifact.

    Deliberately reports the cost-matched view as well as the raw one: a router
    that just spent less is not a smart router, and separating those two is the
    whole methodological point of LiteLLM's own cost-matched shuffled control.
    """
    p = Path(path or SHADOW_PATH)
    if not p.exists():
        return {"error": "no shadow log", "path": str(p)}

    decisions, actuals = [], []
    for line in p.read_text().splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        (decisions if row.get("kind") == "decision" else actuals).append(row)

    if not decisions:
        return {"error": "no decisions logged", "path": str(p)}

    agree = sum(1 for d in decisions if d["agreed"])
    would = defaultdict(int)
    did = defaultdict(int)
    for d in decisions:
        would[d["would_choose"]] += 1
        did[d["incumbent"]] += 1

    per_class: dict[str, dict] = defaultdict(lambda: {"n": 0, "agreed": 0})
    for d in decisions:
        c = per_class[d["task_class"]]
        c["n"] += 1
        c["agreed"] += int(d["agreed"])

    # Mean realised cost per arm, from the actuals, used to price the
    # counterfactual choice.
    cost_by_arm: dict[str, list[float]] = defaultdict(list)
    for a in actuals:
        cost_by_arm[a["arm"]].append(a.get("cost_usd", 0.0))
    mean_cost = {k: (sum(v) / len(v) if v else 0.0) for k, v in cost_by_arm.items()}

    actual_total = sum(a.get("cost_usd", 0.0) for a in actuals)
    shadow_total = sum(mean_cost.get(d["would_choose"], 0.0) for d in decisions)

    return {
        "requests": len(decisions),
        "agreement_rate": round(agree / len(decisions), 4),
        "would_choose": dict(would),
        "incumbent_served": dict(did),
        "per_task_class": {
            k: {"n": v["n"], "agreement_rate": round(v["agreed"] / v["n"], 4)}
            for k, v in per_class.items()
        },
        "mean_cost_per_arm_usd": {k: round(v, 8) for k, v in mean_cost.items()},
        "actual_spend_usd": round(actual_total, 6),
        "projected_shadow_spend_usd": round(shadow_total, 6),
        "projected_delta_usd": round(actual_total - shadow_total, 6),
        "projected_delta_pct": (
            round(100 * (actual_total - shadow_total) / actual_total, 2)
            if actual_total else None
        ),
        "note": (
            "Cost delta alone does not justify promotion. A router that only "
            "spent less is not a smarter router - compare against a "
            "cost-matched shuffled control before promoting."
        ),
    }


if __name__ == "__main__":
    print(json.dumps(report(), indent=2))
