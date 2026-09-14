#!/usr/bin/env python3
"""Offline convergence tuning for the stage window.

The highest-risk item in the demo is that the posteriors do NOT visibly
separate in the ~17 minutes of load between stage minute 2 and stage minute 19.
The brief is explicit that this is a tuning problem rather than a pass/fail, so
this harness answers the tuning question offline instead of burning a live
rehearsal on it.

It drives the REAL ThompsonRouter and the REAL RouterState. Only the model
responses are simulated: each arm has a fixed true quality and a fixed cost, and
the judge is modelled as a Bernoulli draw against that true quality.

Usage:
  python3 scripts/simulate_convergence.py --rate 2.0 --minutes 17
  python3 scripts/simulate_convergence.py --sweep
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Arms: (true P(good enough), blended cost per token)
# Deliberately set so the CHEAP arm is genuinely good but not the best, which
# is the interesting case and the one the talk claims.
ARMS = {
    "claude-sonnet":  (0.95, 6.0e-6),
    "gpt-on-bedrock": (0.86, 3.4e-6),
    "ipr-nova":       (0.76, 6.1e-7),
    "nova-lite":      (0.64, 1.05e-7),
}


def deployments():
    out = []
    for name, (_q, cost) in ARMS.items():
        out.append({
            "model_name": name,
            "model_info": {
                "id": name, "arm": True,
                # split the blended cost back out 75/25
                "input_cost_per_token": cost,
                "output_cost_per_token": cost,
            },
        })
    return out


async def run(gamma: float, lam: float, decay_every: int, rate: float,
              minutes: float, judge_rate: float, seed: int,
              verbose: bool = True, min_obs: int = 30,
              explore_p: float = 0.35) -> dict:
    random.seed(seed)
    os.environ["ROUTER_GAMMA"] = str(gamma)
    os.environ["ROUTER_SESSION_AFFINITY"] = "false"
    os.environ["ROUTER_AUDIT_PATH"] = "/dev/null"
    os.environ["ROUTER_MIN_OBS"] = str(min_obs)
    os.environ["ROUTER_EXPLORE_P"] = str(explore_p)

    import importlib

    import router.state as st
    importlib.reload(st)
    import router.thompson_router as tr
    importlib.reload(tr)

    STATE = st.STATE
    STATE.reset()
    deps = deployments()

    class Sim(tr.ThompsonRouter):
        async def _healthy(self, model, rk):
            return deps

    r = Sim(gamma=gamma)
    n = int(rate * minutes * 60)
    trace = []

    for i in range(n):
        d = await r.async_get_available_deployment("demo", messages=[{"content": "q"}])
        name = d["model_name"]
        true_q, cost = ARMS[name]
        # Judge only scores a sampled fraction, exactly as in production.
        if random.random() <= judge_rate:
            good = random.random() < true_q
            STATE.record_outcome(name, good, cost_usd=cost * 400, tokens=400,
                                 max_cost_per_token=6.0e-6)
            STATE.maybe_decay(lam, decay_every)
        if verbose and i % max(1, n // 8) == 0:
            trace.append((round(i / rate), {k: round(STATE.arm(k).mean, 3)
                                            for k in ARMS}))

    means = {k: STATE.arm(k).mean for k in ARMS}
    obs = {k: STATE.arm(k).observations for k in ARMS}
    shares = {k: STATE.arm(k).requests / max(STATE.total_requests, 1) for k in ARMS}
    ordered = sorted(means, key=lambda k: -means[k])
    # "Separated" = the leader's posterior is clear of the runner-up by more
    # than the sum of their standard deviations, i.e. visibly distinct curves.
    sd = {k: STATE.arm(k).variance ** 0.5 for k in ARMS}
    gap = means[ordered[0]] - means[ordered[1]]
    sep = gap > (sd[ordered[0]] + sd[ordered[1]])

    return {
        "gamma": gamma, "lambda": lam, "decay_every": decay_every,
        "rate": rate, "minutes": minutes, "judge_rate": judge_rate,
        "min_obs": min_obs, "explore_p": explore_p,
        "requests": STATE.total_requests,
        "means": {k: round(v, 4) for k, v in means.items()},
        "observations": obs,
        "shares": {k: round(v, 3) for k, v in shares.items()},
        "leader": ordered[0], "runner_up": ordered[1],
        "gap": round(gap, 4),
        "sd_sum": round(sd[ordered[0]] + sd[ordered[1]], 4),
        "separated": bool(sep),
        "min_observations": min(obs.values()),
        "trace": trace,
    }


async def sweep():
    print(f"{'gamma':>6} {'rate':>5} {'judge':>6} {'minobs':>7} | "
          f"{'leader':>14} {'gap':>7} {'sd_sum':>7} {'minobs':>7} {'sep':>4}")
    print("-" * 90)
    best = []
    for gamma in (0.0, 0.10, 0.20, 0.30):
        for rate in (3.0, 4.0):
            for jr in (0.5, 1.0):
                for mo in (60, 120):
                    res = await run(gamma, 0.995, 40, rate, 17.0, jr, seed=7,
                                    verbose=False, min_obs=mo, explore_p=0.40)
                    ok = res["separated"] and res["min_observations"] >= 40
                    print(f"{gamma:>6} {rate:>5} {jr:>6} {mo:>7} | "
                          f"{res['leader']:>14} {res['gap']:>7.3f} "
                          f"{res['sd_sum']:>7.3f} {res['min_observations']:>7} "
                          f"{'YES' if ok else 'no':>4}")
                    if ok:
                        best.append(res)
    print()
    if best:
        # Prefer the configuration with the widest separation that still keeps
        # every arm observed - an unobserved arm draws a flat curve, which
        # looks like a bug from the back of the room.
        # Prefer the LARGEST gamma that still separates: gamma is the cost
        # dial the talk puts on screen, so a config that only works by
        # switching cost off entirely is not usable on stage.
        b = max(best, key=lambda r: (r["gamma"], r["gap"]))
        print("RECOMMENDED:", json.dumps(
            {k: b[k] for k in ("gamma", "lambda", "rate", "judge_rate", "min_obs",
                               "explore_p", "leader", "gap", "sd_sum",
                               "min_observations", "shares", "means")}, indent=2))
    else:
        print("NO CONFIGURATION SEPARATED - widen the quality spread or the window")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gamma", type=float, default=0.35)
    ap.add_argument("--lam", type=float, default=0.985)
    ap.add_argument("--decay-every", type=int, default=25)
    ap.add_argument("--rate", type=float, default=2.0)
    ap.add_argument("--minutes", type=float, default=17.0)
    ap.add_argument("--judge-rate", type=float, default=0.30)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--sweep", action="store_true")
    a = ap.parse_args()

    if a.sweep:
        await sweep()
        return
    res = await run(a.gamma, a.lam, a.decay_every, a.rate, a.minutes,
                    a.judge_rate, a.seed)
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
