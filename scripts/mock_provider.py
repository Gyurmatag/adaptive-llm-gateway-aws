#!/usr/bin/env python3
"""An OpenAI-compatible mock provider.

Exists for two reasons:

1. It lets the whole stack - gateway, custom router, judge loop, dashboard - be
   verified end to end with no cloud credentials and no spend. Every part of the
   demo except the actual model quality is exercised for real.
2. It is the last-resort stage fallback. If Bedrock model access is not enabled
   in time, or the venue network cannot reach AWS at all, pointing the gateway
   at this server keeps every demo beat working. The routing, the failover, the
   budget block and the dashboard are all genuine; only the text is synthetic.

Each mock model has a configured quality and latency so the bandit has
something real to learn, and the judge has something real to score.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="mock provider")

# model -> (P(good answer), mean latency ms, jitter ms)
PROFILES = {
    "mock-premium": (0.93, 900, 300),
    "mock-gpt":     (0.89, 750, 250),
    "mock-mid":     (0.83, 420, 150),
    "mock-cheap":   (0.78, 260, 90),
    "mock-judge":   (0.99, 120, 40),
}
GOOD = ("Yes. The short answer is that it depends on the workload, and the "
        "dominant factor is the ratio of cached prefix to fresh tokens.")
POOR = "Maybe."


def profile(model: str):
    for k, v in PROFILES.items():
        if k in model:
            return v
    return (0.85, 400, 120)


@app.get("/v1/models")
async def models():
    return {"object": "list",
            "data": [{"id": m, "object": "model"} for m in PROFILES]}


@app.post("/v1/chat/completions")
async def completions(req: Request):
    body = await req.json()
    model = body.get("model", "mock-cheap")
    q, lat, jit = profile(model)
    await asyncio.sleep(max(0.02, random.gauss(lat, jit) / 1000.0))

    msgs = body.get("messages") or []
    last = str(msgs[-1].get("content", "")) if msgs else ""

    # If this is the judge scoring something, answer in the judge's format so
    # the reward path is exercised exactly as it will be in production.
    if "Score the answer" in last or "grading an assistant answer" in last:
        text = json.dumps({"score": round(random.uniform(0.55, 0.99), 2)})
    else:
        text = GOOD if random.random() < q else POOR

    ptok = max(1, len(last) // 4)
    ctok = max(1, len(text) // 4)

    if body.get("stream"):
        async def gen():
            for word in text.split():
                chunk = {"id": "mock", "object": "chat.completion.chunk",
                         "model": model,
                         "choices": [{"index": 0, "delta": {"content": word + " "},
                                      "finish_reason": None}]}
                yield f"data: {json.dumps(chunk)}\n\n"
                await asyncio.sleep(0.03)
            yield ('data: ' + json.dumps({"id": "mock", "object": "chat.completion.chunk",
                    "model": model, "choices": [{"index": 0, "delta": {},
                    "finish_reason": "stop"}]}) + "\n\n")
            yield "data: [DONE]\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream")

    return JSONResponse({
        "id": f"mock-{int(time.time()*1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": text}}],
        "usage": {"prompt_tokens": ptok, "completion_tokens": ctok,
                  "total_tokens": ptok + ctok},
    })


if __name__ == "__main__":
    import uvicorn
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9100)
    a = ap.parse_args()
    uvicorn.run(app, host="0.0.0.0", port=a.port, log_level="warning")
