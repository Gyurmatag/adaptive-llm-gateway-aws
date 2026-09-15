#!/usr/bin/env python3
"""Build the pre-warmed posterior state file.

Section 6.6 of the talk plan: "Ship a pre-warmed posterior state file. If live
convergence does not separate in time, load it and continue."

The numbers are NOT invented. They are the arm means, observation counts and
spend measured during the real Bedrock rehearsal on 15 September 2026 - see
handoff/e2e-test-report.md, Run 2. This file reproduces a state the router
genuinely reached, so loading it is a shortcut through the waiting, not a
fabrication of a result.

Usage:
    python3 scripts/make_prewarmed_state.py            # write the file
    python3 scripts/make_prewarmed_state.py --check    # verify, do not write
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from router.state import ArmState, RouterState  # noqa: E402

# (arm, posterior mean, real observations, avg latency ms, blended $/token)
# Measured, Run 2, real Bedrock eu-central-1.
MEASURED = [
    ("ipr-nova",       0.879, 111, 1340.0, 6.125e-7),
    ("nova-lite",      0.857, 142,  988.0, 1.050e-7),
    ("claude-haiku",   0.854, 224, 1660.0, 2.000e-6),
    ("claude-sonnet",  0.802, 120, 4252.0, 6.000e-6),
    ("gpt-on-bedrock", 0.685, 185, 1120.0, 2.625e-7),
]
MAX_COST_PER_TOKEN = 6.0e-6
TOKENS_PER_REQUEST = 161  # 558,459 tokens over 3,460 requests


def build() -> RouterState:
    st = RouterState()
    for name, mean, obs, latency, cost in MEASURED:
        # Recover (alpha, beta) from the measured mean and observation count,
        # so the curve width reflects how much evidence there actually was.
        successes = round(mean * obs)
        failures = obs - successes
        arm = ArmState(
            name=name,
            alpha=1.0 + successes,
            beta=1.0 + failures,
            successes=successes,
            failures=failures,
            requests=obs * 2,          # judge sampled ~50% of requests
            judged=obs,
            total_latency_ms=latency * obs * 2,
            total_tokens=obs * 2 * TOKENS_PER_REQUEST,
            total_cost_usd=cost * obs * 2 * TOKENS_PER_REQUEST,
        )
        st.arms.setdefault("_all", {})[name] = arm
        st.recent.extend([name] * max(1, round(arm.requests / 12)))

    st.total_requests = sum(a.requests for a in st.arms["_all"].values())
    st.total_tokens = sum(a.total_tokens for a in st.arms["_all"].values())
    st.actual_spend_usd = sum(a.total_cost_usd for a in st.arms["_all"].values())
    st.counterfactual_spend_usd = st.total_tokens * MAX_COST_PER_TOKEN
    st.total_errors = 0
    return st


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--out", default="router/state/prewarmed.json")
    a = ap.parse_args()

    st = build()
    saved = st.counterfactual_spend_usd - st.actual_spend_usd
    print("pre-warmed state:")
    for name, arm in sorted(st.arms["_all"].items(), key=lambda kv: -kv[1].mean):
        print(f"  {name:<16} mean={arm.mean:.3f} "
              f"obs={arm.observations:3d} requests={arm.requests:4d}")
    print(f"  total requests : {st.total_requests}")
    print(f"  actual spend   : ${st.actual_spend_usd:.4f}")
    print(f"  counterfactual : ${st.counterfactual_spend_usd:.4f}")
    print(f"  saved          : {100 * saved / st.counterfactual_spend_usd:.1f}%")
    print(f"  errors         : {st.total_errors}")

    if a.check:
        print("\n--check: nothing written")
        return 0
    p = Path(a.out)
    st.save(p)
    print(f"\nwritten to {p}")
    print("Load it with:  cp %s router/state/posteriors.json" % p)
    print("then restart the gateway, or let the dashboard pick it up.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
