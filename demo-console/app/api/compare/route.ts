import { NextResponse } from "next/server";
import { complete } from "@/lib/gateway";

export const maxDuration = 300;

const OR_KEY = process.env.OPENROUTER_API_KEY ?? "";

/** Same question, two adaptive routers, side by side.
 *
 *  Ours adapts to THIS traffic: a judge scores our answers and the bandit
 *  moves. OpenRouter's Auto Router adapts to THE MARKET: it classifies the
 *  prompt into one of ~30 task types and picks whatever the community spent
 *  most on for that task over a trailing 7 days.
 *
 *  Both are legitimate and they answer different questions, which is the whole
 *  point of showing them together rather than declaring a winner.
 */
async function openrouter(prompt: string) {
  const started = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OR_KEY}`,
        "Content-Type": "application/json",
        // Surfaces which task type it decided on and how many endpoints it
        // had to choose between - the "you must be able to see why" point.
        "X-OpenRouter-Metadata": "enabled",
      },
      body: JSON.stringify({
        model: "openrouter/auto",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 160,
      }),
      cache: "no-store",
    });
    const ms = Date.now() - started;
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.choices) {
      return { ok: false, ms, error: String(body?.error?.message ?? res.status).slice(0, 160) };
    }
    const md = body.openrouter_metadata ?? {};
    return {
      ok: true,
      ms,
      model: body.model,
      provider: body.provider ?? null,
      text: body.choices[0]?.message?.content ?? "",
      // OpenRouter bills the real number back to us, so no estimate is needed.
      costUsd: body.usage?.cost ?? null,
      tokens: body.usage?.total_tokens ?? null,
      strategy: md.strategy ?? null,
      endpointsAvailable: md.endpoints?.total ?? md.summary ?? null,
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: String(e).slice(0, 160) };
  }
}

export async function POST(req: Request) {
  const { prompt } = await req.json();

  const [mine, theirs] = await Promise.all([
    complete("demo-router", prompt, { maxTokens: 160, noCache: true }),
    openrouter(prompt),
  ]);

  return NextResponse.json({
    prompt,
    mine: {
      ok: mine.ok,
      ms: mine.ms,
      model: mine.servedBy,
      text: mine.text,
      costUsd: mine.cost ? Number(mine.cost) : null,
    },
    theirs,
    configured: Boolean(OR_KEY),
  });
}
