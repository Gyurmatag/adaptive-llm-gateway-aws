import { NextResponse } from "next/server";
import { complete, DASHBOARD } from "@/lib/gateway";

async function spend() {
  return fetch(`${DASHBOARD}/spend`, { cache: "no-store" })
    .then((r) => r.json())
    .catch(() => null);
}

/** Demo 2: ask cold, then ask the SAME THING in different words.
 *
 *  Sequential on purpose - the reworded ask can only hit a cache the first ask
 *  has populated, and firing both at once is a race that intermittently shows a
 *  miss on stage.
 *
 *  The spend counters are read either side of the reworded ask because the
 *  response headers LIE about this: LiteLLM replays the cached response object
 *  complete with its original usage and x-litellm-response-cost, so a cache hit
 *  *looks* billed. The gateway's own counters are the truth, and they do not
 *  move. That is the slide's claim - no tokens billed, no model called - and it
 *  is worth proving rather than asserting.
 */
export async function POST(req: Request) {
  const { cold, reworded } = await req.json();
  const first = await complete("nova-lite", cold, { maxTokens: 90 });

  const before = await spend();
  const second = await complete("nova-lite", reworded, { maxTokens: 90 });
  await new Promise((r) => setTimeout(r, 2500));   // the gateway persists on a tick
  const after = await spend();

  const spentUsd = before && after ? +(after.actual_usd - before.actual_usd).toFixed(8) : null;
  const tokens = before && after ? after.tokens - before.tokens : null;

  return NextResponse.json({
    cold: first,
    reworded: second,
    hit: Boolean(second.similarity),
    speedup: first.ms > 0 ? +(first.ms / Math.max(second.ms, 1)).toFixed(1) : null,
    // What the gateway actually billed for the reworded ask.
    spentUsd,
    tokens,
    // What the response header claimed, so the difference can be shown.
    headerCost: second.cost ?? null,
  });
}
