"""Async load generator. Runs on the laptop, talks to whatever
GATEWAY_BASE_URL points at - the deployed stack or the local standby.

Started at stage minute 2 and left running. By minute 19 it has several hundred
requests behind it and the posteriors have separated on their own, which is why
Demo 3 costs zero extra stage time.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import random
import signal
import sys
import time
from pathlib import Path

import httpx
import yaml

BASE_URL = os.environ.get("GATEWAY_BASE_URL", "http://localhost:4000").rstrip("/")
API_KEY = os.environ.get("LITELLM_DEMO_KEY") or os.environ.get("LITELLM_MASTER_KEY", "")
MODEL = os.environ.get("LOADGEN_MODEL", "demo-router")

_stop = False


def _handle_stop(*_a):
    global _stop
    _stop = True
    print("\n[loadgen] stopping after in-flight requests...", file=sys.stderr)


class Stats:
    def __init__(self) -> None:
        self.sent = 0
        self.ok = 0
        self.err = 0
        self.by_model: dict[str, int] = {}
        self.errors_by_kind: dict[str, int] = {}
        self.latencies: list[float] = []
        self.started = time.time()

    def line(self) -> str:
        el = time.time() - self.started
        rate = self.sent / el if el > 0 else 0
        lat = sorted(self.latencies[-200:])
        p50 = lat[len(lat) // 2] if lat else 0
        split = " ".join(f"{k}={v}" for k, v in sorted(
            self.by_model.items(), key=lambda kv: -kv[1]))
        return (f"[{el:6.1f}s] sent={self.sent:4d} ok={self.ok:4d} err={self.err:3d} "
                f"{rate:4.1f}/s p50={p50:5.0f}ms | {split}")


async def one(client: httpx.AsyncClient, prompt: str, stats: Stats,
              session_id: str | None, allow_cache: bool = True) -> None:
    stats.sent += 1
    t0 = time.perf_counter()
    headers = {"Authorization": f"Bearer {API_KEY}"}
    body: dict = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 300,
    }
    if session_id:
        body["metadata"] = {"session_id": session_id}
    if not allow_cache:
        # Explicit bypass rather than mangling the prompt.
        #
        # The pool is 23 prompts. Sent verbatim they all hit the semantic cache
        # after the first pass - no model call, no routing decision, no reward -
        # so the bandit starves while the dashboard shows healthy traffic.
        # Perturbing the text does not fix it either: a suffix is MORE similar
        # to the original than a genuine paraphrase is, so any threshold loose
        # enough for Demo 2 to hit is loose enough for the perturbed prompt to
        # hit too. Saying "do not cache this one" is the honest control.
        body["cache"] = {"no-cache": True}
    try:
        r = await client.post("/v1/chat/completions", json=body, headers=headers)
        dt = (time.perf_counter() - t0) * 1000
        stats.latencies.append(dt)
        if r.status_code == 200:
            stats.ok += 1
            data = r.json()
            # Which deployment actually answered. Under the custom router this
            # is the model field; under the built-in adaptive router it also
            # comes back as x-litellm-adaptive-router-model.
            m = (r.headers.get("x-litellm-adaptive-router-model")
                 or data.get("model") or "unknown")
            stats.by_model[m] = stats.by_model.get(m, 0) + 1
        else:
            stats.err += 1
            kind = f"http_{r.status_code}"
            stats.errors_by_kind[kind] = stats.errors_by_kind.get(kind, 0) + 1
    except (httpx.HTTPError, ValueError) as e:
        stats.err += 1
        kind = type(e).__name__
        stats.errors_by_kind[kind] = stats.errors_by_kind.get(kind, 0) + 1


def load_pool(path: Path) -> list[tuple[str, float]]:
    data = yaml.safe_load(path.read_text())
    pool: list[tuple[str, float]] = []
    for bucket in data.values():
        w = float(bucket.get("weight", 0.5))
        prompts = bucket.get("prompts", [])
        per = w / len(prompts) if prompts else 0
        pool.extend((p, per) for p in prompts)
    return pool


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rate", type=float, default=float(os.environ.get("LOADGEN_RATE", "2.0")),
                    help="requests per second")
    ap.add_argument("--duration", type=float, default=0, help="seconds, 0 = forever")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--sessions", type=int, default=0,
                    help="if >0, spread traffic over N session ids to exercise affinity")
    ap.add_argument("--prompts", type=Path,
                    default=Path(__file__).parent / "prompts.yaml")
    ap.add_argument("--cache-hit-rate", type=float,
                    default=float(os.environ.get("LOADGEN_CACHE_HIT_RATE", "0.15")),
                    help="fraction of requests allowed to use the response "
                         "cache. The rest send cache.no-cache so the bandit "
                         "sees real model calls.")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    signal.signal(signal.SIGINT, _handle_stop)
    signal.signal(signal.SIGTERM, _handle_stop)

    pool = load_pool(args.prompts)
    prompts = [p for p, _ in pool]
    weights = [w for _, w in pool]
    stats = Stats()
    sem = asyncio.Semaphore(args.concurrency)

    print(f"[loadgen] -> {BASE_URL}  model={MODEL}  rate={args.rate}/s", file=sys.stderr)

    async with httpx.AsyncClient(base_url=BASE_URL, timeout=60.0) as client:
        tasks: set[asyncio.Task] = set()
        interval = 1.0 / args.rate if args.rate > 0 else 0.5
        last_print = time.time()

        while not _stop:
            if args.duration and (time.time() - stats.started) >= args.duration:
                break
            prompt = random.choices(prompts, weights=weights, k=1)[0]
            sid = f"sess-{random.randint(1, args.sessions)}" if args.sessions else None

            allow_cache = random.random() < args.cache_hit_rate

            async def guarded(p=prompt, s=sid, c=allow_cache):
                async with sem:
                    await one(client, p, stats, s, allow_cache=c)

            t = asyncio.create_task(guarded())
            tasks.add(t)
            t.add_done_callback(tasks.discard)

            if not args.quiet and time.time() - last_print >= 5:
                print(stats.line(), file=sys.stderr)
                last_print = time.time()
            await asyncio.sleep(interval)

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    print("\n" + stats.line(), file=sys.stderr)
    if stats.errors_by_kind:
        print(f"[loadgen] errors: {stats.errors_by_kind}", file=sys.stderr)
    return 0 if stats.err == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
