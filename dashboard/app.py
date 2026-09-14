"""Dashboard data plane. Runs on ECS beside the gateway.

Serves /state, /spend and an SSE stream. The Next.js UI on Amplify is a pure
consumer of these shapes - see dashboard-brief.md section 5.

Why the browser talks to THIS service directly rather than through Next.js:
Amplify Hosting runs Next.js on its compute provider but Next.js streaming is
on its unsupported features list. So the SSE connection goes browser -> ALB ->
here, and Amplify only ever serves static UI.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import sys
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from router.state import STATE, GLOBAL_CLASS  # noqa: E402
from router import policy  # noqa: E402

app = FastAPI(title="Adaptive LLM Gateway - dashboard data plane")

# Pin the exact Amplify origin, never '*'. Comma-separated for the local
# standby plus the deployed UI.
_origins = [o.strip() for o in os.environ.get(
    "DASHBOARD_CORS_ORIGIN", "http://localhost:3000").split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
    # The browser needs to read these on the semantic-cache demo.
    expose_headers=["x-litellm-semantic-similarity", "x-litellm-cache-hit"],
)

CURVE_POINTS = int(os.environ.get("DASHBOARD_CURVE_POINTS", "80"))
STREAM_INTERVAL = float(os.environ.get("DASHBOARD_STREAM_INTERVAL", "1.0"))

# Colour assignment follows the MODEL, never its rank, so an arm that loses
# traffic keeps its colour. dashboard-brief.md section 4.2.
PALETTE_ORDER = ["claude-sonnet", "nova-lite", "gpt-on-bedrock", "ipr-claude", "ipr-nova"]


def _log_beta(a: float, b: float) -> float:
    return math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b)


def beta_pdf(x: float, a: float, b: float) -> float:
    """Beta density, computed in log space so large alpha/beta do not overflow.

    After 20 minutes of load alpha can reach several hundred; the naive form
    overflows and the curve panel goes blank at exactly the moment it matters.
    """
    if x <= 0.0 or x >= 1.0:
        return 0.0
    try:
        return math.exp((a - 1.0) * math.log(x) + (b - 1.0) * math.log1p(-x) - _log_beta(a, b))
    except (ValueError, OverflowError):
        return 0.0


def curve(a: float, b: float, n: int = CURVE_POINTS) -> list[list[float]]:
    """Sample the density on a grid concentrated where the mass actually is.

    A uniform 0..1 grid wastes most of its points on empty space once the
    posterior is narrow, and the peak lands between grid points and flickers.
    """
    mean = a / (a + b)
    sd = math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1.0)))
    lo = max(1e-4, mean - 5 * sd)
    hi = min(1.0 - 1e-4, mean + 5 * sd)
    if hi <= lo:
        lo, hi = 1e-4, 1.0 - 1e-4
    step = (hi - lo) / (n - 1)
    return [[round(lo + i * step, 5), round(beta_pdf(lo + i * step, a, b), 5)]
            for i in range(n)]


def snapshot() -> dict:
    """The /state payload. Also what the SSE stream pushes."""
    tc = GLOBAL_CLASS
    bucket = STATE.arms.get(tc, {})
    total_reqs = sum(a.requests for a in bucket.values()) or 1

    arms = []
    for name in sorted(bucket, key=lambda n: (PALETTE_ORDER.index(n)
                                              if n in PALETTE_ORDER else 99, n)):
        a = bucket[name]
        arms.append({
            "model": name,
            "alpha": round(a.alpha, 4),
            "beta": round(a.beta, 4),
            "mean": round(a.mean, 4),
            "variance": round(a.variance, 8),
            # Real observations only, excluding cold-start prior mass, so
            # "this arm has actually learned something" is directly readable.
            "observations": a.observations,
            "requests": a.requests,
            "share": round(a.requests / total_reqs, 4),
            "avg_latency_ms": round(a.avg_latency_ms, 1),
            "cost_usd": round(a.total_cost_usd, 6),
            "curve": curve(a.alpha, a.beta),
        })

    pol = policy.load()
    return {
        "ts": time.time(),
        "mode": policy.mode(),
        "policy_id": pol.policy_id if pol else None,
        "gamma": float(os.environ.get("ROUTER_GAMMA", "0.35")),
        "shadow": os.environ.get("ROUTER_SHADOW", "false").lower() == "true",
        "leader": STATE.leader(tc),
        "total_requests": STATE.total_requests,
        "errors": STATE.total_errors,
        "uptime_s": round(time.time() - STATE.started_at, 1),
        "arms": arms,
    }


def spend() -> dict:
    saved = STATE.counterfactual_spend_usd - STATE.actual_spend_usd
    return {
        "ts": time.time(),
        "actual_usd": round(STATE.actual_spend_usd, 6),
        "counterfactual_usd": round(STATE.counterfactual_spend_usd, 6),
        "saved_usd": round(saved, 6),
        "saved_pct": (round(100 * saved / STATE.counterfactual_spend_usd, 2)
                      if STATE.counterfactual_spend_usd > 0 else 0.0),
        "tokens": STATE.total_tokens,
        "errors": STATE.total_errors,
    }


@app.get("/health")
async def health():
    return {"ok": True, "ts": time.time()}


@app.get("/state")
async def get_state():
    return JSONResponse(snapshot())


@app.get("/spend")
async def get_spend():
    return JSONResponse(spend())


@app.get("/shadow")
async def get_shadow():
    from router import shadow as sh
    return JSONResponse(sh.report())


@app.get("/stream")
async def stream():
    """SSE. Pushes state+spend on a fixed tick.

    A comment heartbeat goes out every tick regardless of change, because the
    ALB idle timeout counts silence and a dashboard that has been quiet through
    a slow slide must not be reaped mid-talk.
    """
    async def gen():
        last = ""
        while True:
            payload = json.dumps({"state": snapshot(), "spend": spend()})
            if payload != last:
                yield f"event: update\ndata: {payload}\n\n"
                last = payload
            else:
                yield ": heartbeat\n\n"
            await asyncio.sleep(STREAM_INTERVAL)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # Required when anything nginx-shaped sits in front, harmless here.
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/")
async def standby():
    """The unbranded standby dashboard, served by the local FastAPI.

    An https Amplify page cannot reliably fetch an http localhost gateway, so
    this is the fallback for the local standby stack - not the Amplify UI.
    """
    p = Path(__file__).parent / "static" / "index.html"
    return FileResponse(p) if p.exists() else JSONResponse({"error": "no standby page"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("DASHBOARD_PORT", "8080")))
