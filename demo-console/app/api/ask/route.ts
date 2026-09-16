import { NextResponse } from "next/server";
import { GATEWAY, DASHBOARD, authHeaders } from "@/lib/gateway";

export const maxDuration = 120;

async function spend() {
  return fetch(`${DASHBOARD}/spend`, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
}

/** One question, with everything the demo needs to show about it.
 *
 *  The response headers cannot be trusted on a cache hit: LiteLLM replays the
 *  cached answer complete with the ORIGINAL usage and cost, so a free answer
 *  looks billed. The gateway's own spend counters are read either side of the
 *  request instead, and those are the numbers shown.
 */
export async function POST(req: Request) {
  const { prompt, model = "nova-lite" } = await req.json();

  const before = await spend();
  const started = Date.now();
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 120,
    }),
    cache: "no-store",
  });
  const ms = Date.now() - started;
  const body = await res.json().catch(() => ({}));
  // The gateway persists spend on a one-second tick.
  await new Promise((r) => setTimeout(r, 1500));
  const after = await spend();

  const u = body?.usage ?? {};
  return NextResponse.json({
    prompt,
    ok: Boolean(body?.choices),
    ms,
    text: body?.choices?.[0]?.message?.content ?? "",
    model: res.headers.get("x-litellm-model-id"),
    similarity: res.headers.get("x-litellm-semantic-similarity"),
    cached: Boolean(res.headers.get("x-litellm-semantic-similarity")),
    // What the model actually produced, per the response.
    promptTokens: u.prompt_tokens ?? null,
    completionTokens: u.completion_tokens ?? null,
    totalTokens: u.total_tokens ?? null,
    // What the header CLAIMS it cost - replayed, and wrong, on a cache hit.
    headerCostUsd: res.headers.get("x-litellm-response-cost"),
    // What the gateway actually billed. This is the honest number.
    billedUsd: before && after ? +(after.actual_usd - before.actual_usd).toFixed(8) : null,
    billedTokens: before && after ? after.tokens - before.tokens : null,
  });
}
