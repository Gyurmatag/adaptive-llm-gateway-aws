import { NextResponse } from "next/server";
import { GATEWAY, DASHBOARD, authHeaders } from "@/lib/gateway";

export const maxDuration = 300;

/** Demo 4, self-contained.
 *
 *  There is no background load generator any more - traffic exists only because
 *  someone did something - so the failover drill makes its own. That turns out
 *  to be better television: a fixed, visible burst of questions with the kill
 *  in the middle of it, rather than pointing at a graph and asking the room to
 *  believe something moved.
 */
const PROMPT = "Explain database indexes briefly.";

async function burst(n: number) {
  const served: string[] = [];
  let failed = 0;
  // Keep one real answer from each burst, so the demo shows what was actually
  // asked and what actually came back rather than only a tally.
  let sample: { model: string; text: string } | null = null;
  for (let i = 0; i < n; i += 4) {
    const batch = Array.from({ length: Math.min(4, n - i) }, async (_, k) => {
      try {
        const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            model: "demo-router",
            messages: [{ role: "user", content: `${PROMPT} #${i + k}-${Date.now()}` }],
            max_tokens: 60,
            cache: { "no-cache": true },
          }),
          cache: "no-store",
        });
        const who = res.headers.get("x-litellm-model-id");
        const body = await res.json().catch(() => null);
        if (!res.ok) { failed++; return; }
        if (who) served.push(who);
        if (!sample && body?.choices?.[0]?.message?.content) {
          sample = { model: who ?? "?", text: body.choices[0].message.content };
        }
      } catch {
        failed++;
      }
    });
    await Promise.all(batch);
  }
  return { served, failed, sample };
}

function tally(served: string[]) {
  const counts: Record<string, number> = {};
  for (const m of served) counts[m] = (counts[m] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

export async function POST(req: Request) {
  const { arm, action } = await req.json();

  if (action === "restore") {
    const r = await fetch(`${DASHBOARD}/admin/enable`, {
      method: "POST", headers: authHeaders(), cache: "no-store",
    });
    return NextResponse.json(await r.json().catch(() => ({ ok: r.ok })));
  }

  const before = await burst(12);
  const killRes = await fetch(`${DASHBOARD}/admin/disable?arm=${encodeURIComponent(arm)}`, {
    method: "POST", headers: authHeaders(), cache: "no-store",
  });
  const killed = await killRes.json().catch(() => ({}));
  const after = await burst(12);

  return NextResponse.json({
    arm,
    prompt: PROMPT,
    killed: killed?.disabled ?? [],
    before: tally(before.served),
    after: tally(after.served),
    beforeSample: before.sample,
    afterSample: after.sample,
    failed: before.failed + after.failed,      // the number the demo turns on
    stillServing: after.served.includes(arm),
  });
}
