import { NextResponse } from "next/server";

export const maxDuration = 300;

const OR_KEY = process.env.OPENROUTER_API_KEY ?? "";

/** "Can we just give OpenRouter the same models?"
 *
 *  Run live, because the answer is no and that is worth proving rather than
 *  asserting. openrouter/auto ignores the `models` list completely: ask it
 *  five times with a list of exactly one model and it serves something else
 *  every time. The same list WITHOUT auto is honoured, which rules out the
 *  list being malformed.
 *
 *  So the adaptive router cannot be pointed at your fleet. You can pin one
 *  model, or give a fallback chain of at most three - but routing that adapts
 *  over models YOU chose is the thing you have to build.
 */
const ONE = ["amazon/nova-lite-v1"];

async function call(body: Record<string, unknown>) {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const j = await res.json().catch(() => ({}));
    if (j?.error) return { error: String(j.error.message ?? j.error).slice(0, 120) };
    return { model: j?.model ?? null, costUsd: j?.usage?.cost ?? null };
  } catch (e) {
    return { error: String(e).slice(0, 120) };
  }
}

export async function POST() {
  if (!OR_KEY) return NextResponse.json({ configured: false });

  const msg = (v: string) => [{ role: "user", content: `Explain database indexes briefly. ${v}` }];

  // The experiment: auto, with a one-model list.
  const auto = await Promise.all(
    [1, 2, 3, 4, 5].map((i) =>
      call({ model: "openrouter/auto", models: ONE, messages: msg(`a${i}-${Date.now()}`), max_tokens: 60 }),
    ),
  );
  // Control 1: the same list, no auto. Proves the list is well formed.
  const list = await Promise.all(
    [1, 2].map((i) => call({ models: ONE, messages: msg(`c${i}-${Date.now()}`), max_tokens: 60 })),
  );
  // Control 2: naming the model outright.
  const pinned = await call({ model: ONE[0], messages: msg(`p-${Date.now()}`), max_tokens: 60 });

  const asked = ONE[0];
  return NextResponse.json({
    configured: true,
    asked,
    auto,
    list,
    pinned,
    honoured: auto.filter((r) => r.model === asked).length,
    samples: auto.length,
    // Four is our fleet; the list parameter caps at three, so we cannot even
    // express it as a fallback chain.
    fleetSize: 4,
    listCap: 3,
  });
}
