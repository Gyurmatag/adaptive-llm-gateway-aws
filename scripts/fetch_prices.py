#!/usr/bin/env python3
"""Fetch REAL per-token prices and check config/config.yaml against them.

Two sources, both authoritative, neither of them a blog post:

  AWS      the Pricing API (us-east-1 endpoint, eu-central-1 rows). Bedrock
           publishes per-1K-token prices per model per region. Batch and
           prompt-cache rows are excluded.
  OpenRouter  /api/v1/models, which carries pricing.prompt and
           pricing.completion per model - and every completion response also
           returns usage.cost, the actual amount billed.

Why this exists: the config was hand-written from US list prices. The eu.
cross-region inference profiles cost more, and gpt-oss-120b in eu-central-1 is
0.20/0.79 rather than the 0.15/0.60 that both our config AND LiteLLM's shipped
price map claimed. Understating a price understates the bill and flatters the
savings counter, which is the one number the talk puts on a slide.

    python3 scripts/fetch_prices.py            # compare, exit 1 on a mismatch
"""
from __future__ import annotations

import json
import subprocess
import sys
import urllib.request
from pathlib import Path

import yaml

# The Pricing API spells models its own way, and does not list Claude 4.x at
# all - only Claude 2.x and 3.x - so those fall back to a stated source.
AWS_NAMES = {
    "nova-lite": "Nova Lite",
    "gpt-on-bedrock": "gpt-oss-120b",
}
# ipr-nova is Bedrock's own router between Nova Lite and Nova Pro. It never
# reports which one served, so its price is a stated midpoint, not a fact.
IPR_ENDPOINTS = ("Nova Lite", "Nova Pro")

OPENROUTER_EQUIV = {
    "claude-sonnet": "anthropic/claude-sonnet-4.5",
    "claude-haiku": "anthropic/claude-haiku-4.5",
    "nova-lite": "amazon/nova-lite-v1",
    "gpt-on-bedrock": "openai/gpt-oss-120b",
}


def aws_price(model: str, region: str = "eu-central-1") -> dict[str, float]:
    """Per-TOKEN input/output price, on demand, excluding batch and cache rows."""
    out = subprocess.run(
        ["aws", "pricing", "get-products", "--region", "us-east-1",
         "--service-code", "AmazonBedrock", "--max-items", "100",
         "--filters", f"Type=TERM_MATCH,Field=model,Value={model}",
         f"Type=TERM_MATCH,Field=regionCode,Value={region}",
         "--query", "PriceList", "--output", "json"],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        return {}
    best: dict[str, float] = {}
    for row in json.loads(out.stdout or "[]"):
        d = json.loads(row) if isinstance(row, str) else row
        a = d["product"]["attributes"]
        kind = a.get("inferenceType") or ""
        usage = (a.get("usagetype") or "").lower()
        if kind not in ("Input tokens", "Output tokens"):
            continue
        if "batch" in usage or "cache" in usage:
            continue
        for term in d.get("terms", {}).get("OnDemand", {}).values():
            for dim in term.get("priceDimensions", {}).values():
                usd = float(dim["pricePerUnit"]["USD"])
                if usd > 0:                       # quoted per 1K tokens
                    key = "in" if kind == "Input tokens" else "out"
                    best[key] = min(best.get(key, 9e9), usd / 1000.0)
    return best


def openrouter_prices() -> dict[str, dict[str, float]]:
    with urllib.request.urlopen("https://openrouter.ai/api/v1/models", timeout=60) as r:
        data = json.load(r)
    out = {}
    for m in data.get("data", []):
        p = m.get("pricing") or {}
        try:
            out[m["id"]] = {"in": float(p.get("prompt", 0)), "out": float(p.get("completion", 0))}
        except (TypeError, ValueError):
            continue
    return out


def configured() -> dict[str, dict[str, float]]:
    cfg = yaml.safe_load((Path(__file__).parent.parent / "config" / "config.yaml").read_text())
    out = {}
    for m in cfg["model_list"]:
        if m["model_name"] != "demo-router":
            continue
        mi = m["model_info"]
        out[mi["id"]] = {"in": mi["input_cost_per_token"], "out": mi["output_cost_per_token"]}
    return out


def per_m(v: float) -> str:
    return f"${v * 1e6:,.4f}"


def main() -> int:
    cfg = configured()
    orp = openrouter_prices()
    bad = 0

    print("arm                config in/out per 1M      AWS API per 1M           OpenRouter per 1M")
    print("-" * 96)
    for arm, c in cfg.items():
        aws = aws_price(AWS_NAMES[arm]) if arm in AWS_NAMES else {}
        if arm == "ipr-nova":
            lo, hi = (aws_price(n) for n in IPR_ENDPOINTS)
            if lo and hi:
                aws = {k: (lo[k] + hi[k]) / 2 for k in ("in", "out")}
        o = orp.get(OPENROUTER_EQUIV.get(arm, ""), {})

        aws_s = f"{per_m(aws['in'])} / {per_m(aws['out'])}" if aws else "not published"
        or_s = f"{per_m(o['in'])} / {per_m(o['out'])}" if o else "n/a"
        flag = ""
        if aws:
            drift = max(abs(c["in"] - aws["in"]) / aws["in"], abs(c["out"] - aws["out"]) / aws["out"])
            if drift > 0.02:
                flag = f"  <-- OFF BY {drift * 100:.0f}%"
                bad += 1
        print(f"{arm:<18} {per_m(c['in'])} / {per_m(c['out'])}".ljust(44)
              + aws_s.ljust(25) + or_s + flag)

    print()
    print("AWS does not publish Claude 4.x through the Pricing API - only Claude 2.x and 3.x -")
    print("so those two rows are checked against OpenRouter's list price for the same model.")
    print("ipr-nova is Bedrock's own Lite/Pro router and never says which one served, so its")
    print("row is the midpoint of the two, stated rather than measured.")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
