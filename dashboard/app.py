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

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import router.state as router_state  # noqa: E402
from router import policy  # noqa: E402
from router.state import GLOBAL_CLASS, STATE_PATH, RouterState  # noqa: E402

# The posteriors are owned by the GATEWAY process. This service is a separate
# ECS task beside it, so it re-reads the state file whenever the gateway writes
# it, rather than trusting the copy loaded at import - which never changes and
# would leave the dashboard frozen at the priors for the whole talk.
_mtime = 0.0


def STATE() -> RouterState:  # noqa: N802 - reads as a value at every call site
    global _mtime
    try:
        m = STATE_PATH.stat().st_mtime
    except OSError:
        return router_state.STATE
    if m != _mtime:
        _mtime = m
        # Adopt whatever parsed, INCLUDING an empty state. An earlier version
        # guarded with `if loaded.total_requests or loaded.arms`, meaning a
        # legitimate reset - which is exactly an empty state - was rejected and
        # the dashboard kept showing the previous run's numbers. Between two
        # rehearsals that silently invalidates the second one.
        try:
            loaded = RouterState.from_dict(json.loads(STATE_PATH.read_text()))
        except (OSError, ValueError, TypeError, KeyError):
            return router_state.STATE  # corrupt mid-write; keep what we have
        router_state.STATE = loaded
    return router_state.STATE

app = FastAPI(title="Adaptive LLM Gateway - dashboard data plane")

# Pin the exact Amplify origin, never '*'. Comma-separated for the local
# standby plus the deployed UI.
_origins = [o.strip() for o in os.environ.get(
    "DASHBOARD_CORS_ORIGIN", "http://localhost:3000").split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
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
    bucket = STATE().arms.get(tc, {})
    total_reqs = sum(a.requests for a in bucket.values()) or 1
    rolling = STATE().rolling_share()

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
            # Rolling, not cumulative. A lifetime ratio barely moves when an
            # arm stops being routed to, so the Demo 4 failover would be
            # invisible in the panel whose job is to show it.
            "share": round(rolling.get(name, 0.0), 4),
            "share_cumulative": round(a.requests / total_reqs, 4),
            "avg_latency_ms": round(a.avg_latency_ms, 1),
            "cost_usd": round(a.total_cost_usd, 6),
            "curve": curve(a.alpha, a.beta),
        })

    # The red series follows the model currently TAKING the most traffic, not
    # the one with the highest posterior mean. Those differ whenever the cost
    # dial is doing its job, and "red is where the traffic goes" is the version
    # that reads from the back of a room in one glance. It also makes Demo 4
    # unmistakable: kill the red model and the red visibly moves.
    traffic_leader = (max(rolling, key=lambda n: rolling[n])
                      if rolling else
                      (max(bucket, key=lambda n: bucket[n].requests) if bucket else None))

    pol = policy.load()
    return {
        "ts": time.time(),
        "mode": policy.mode(),
        "policy_id": pol.policy_id if pol else None,
        "gamma": float(os.environ.get("ROUTER_GAMMA", "0.35")),
        "shadow": os.environ.get("ROUTER_SHADOW", "false").lower() == "true",
        "leader": traffic_leader,
        "quality_leader": STATE().leader(tc),
        "total_requests": STATE().total_requests,
        "errors": STATE().total_errors,
        "uptime_s": round(time.time() - STATE().started_at, 1),
        "arms": arms,
    }


def spend() -> dict:
    saved = STATE().counterfactual_spend_usd - STATE().actual_spend_usd
    return {
        "ts": time.time(),
        "actual_usd": round(STATE().actual_spend_usd, 6),
        "counterfactual_usd": round(STATE().counterfactual_spend_usd, 6),
        "saved_usd": round(saved, 6),
        "saved_pct": (round(100 * saved / STATE().counterfactual_spend_usd, 2)
                      if STATE().counterfactual_spend_usd > 0 else 0.0),
        "tokens": STATE().total_tokens,
        "errors": STATE().total_errors,
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


# --------------------------------------------------------------- admin control
#
# The kill switch and the reset are FILES in the gateway's state directory.
# That works locally, where the directory is a bind mount, and cannot work on
# ECS, where the task shares no filesystem with the laptop - so Demo 4 silently
# did nothing against the deployed stack: the arm was written to the local
# DISABLED file and kept taking 26% of traffic on ECS.
#
# These endpoints are mounted INSIDE the gateway process (see
# router/proxy_hook.py::_mount_dashboard), so they reach the router that is
# actually serving. They are the remote equivalent of touching the file.

def _require_admin(auth: str | None) -> None:
    """Master key required. These endpoints change live routing behaviour."""
    expected = os.environ.get("LITELLM_MASTER_KEY", "")
    token = (auth or "").removeprefix("Bearer ").strip()
    if not expected or token != expected:
        raise HTTPException(status_code=401, detail="master key required")


@app.post("/admin/disable")
async def admin_disable(arm: str, authorization: str | None = Header(default=None)):
    """Break an arm out of the circuit. The Demo 4 kill switch."""
    _require_admin(authorization)
    path = STATE_PATH.parent / "DISABLED"
    current = set()
    if path.exists():
        current = {x.strip() for x in path.read_text().split() if x.strip()}
    current.add(arm)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(sorted(current)) + "\n")
    return {"disabled": sorted(current)}


@app.post("/admin/enable")
async def admin_enable(authorization: str | None = Header(default=None)):
    """Close the circuit breaker again."""
    _require_admin(authorization)
    path = STATE_PATH.parent / "DISABLED"
    was = []
    if path.exists():
        was = sorted({x.strip() for x in path.read_text().split() if x.strip()})
        path.unlink()
    return {"restored": was}


@app.post("/admin/reset")
async def admin_reset(authorization: str | None = Header(default=None)):
    """Reset posteriors to priors without replacing the task.

    Far faster than forcing a new ECS deployment (seconds rather than minutes),
    and it does not risk the draining-task race that silently discarded the
    first three minutes of a soak.
    """
    _require_admin(authorization)
    st = STATE()
    st.reset()
    try:
        st.save()
        for stale in ("audit.jsonl", "shadow.jsonl", "DISABLED"):
            (STATE_PATH.parent / stale).unlink(missing_ok=True)
    except OSError:
        pass
    return {"ok": True, "total_requests": st.total_requests}


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
