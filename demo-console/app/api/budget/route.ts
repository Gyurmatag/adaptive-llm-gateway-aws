import { NextResponse } from "next/server";
import { GATEWAY, authHeaders } from "@/lib/gateway";

/** Demo 5: a virtual key with a ceiling of a fraction of a cent, spent live.
 *
 *  The block must be detected from the BODY, not the status code. On the
 *  deployed stack the gateway's middleware passes the error through with
 *  HTTP 200; locally it is a 400. A harness that waits for a non-200 never
 *  terminates, and a speaker who points at the status code points at the
 *  wrong thing. It is never a 429.
 */
export async function POST(req: Request) {
  const { maxBudget = 0.0002 } = await req.json().catch(() => ({}));

  const keyRes = await fetch(`${GATEWAY}/key/generate`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      key_alias: `demo-console-${Date.now()}`,
      max_budget: maxBudget,
      models: ["demo-router"],
    }),
    cache: "no-store",
  });
  const key = (await keyRes.json().catch(() => ({})))?.key;
  if (!key) {
    return NextResponse.json({ error: "could not mint a budget key" }, { status: 502 });
  }

  const attempts: { n: number; ms: number; status: number; blocked: boolean; detail: string }[] = [];
  const started = Date.now();
  for (let n = 1; n <= 12; n++) {
    const t = Date.now();
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "demo-router",
        messages: [{ role: "user", content: "Write three sentences about databases." }],
        max_tokens: 300,
        cache: { "no-cache": true },
      }),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    const blocked = body?.error?.type === "budget_exceeded";
    attempts.push({
      n,
      ms: Date.now() - t,
      status: res.status,
      blocked,
      detail: blocked ? String(body.error.message ?? "").slice(0, 160) : "ok",
    });
    if (blocked) break;
  }

  const last = attempts[attempts.length - 1];
  return NextResponse.json({
    attempts,
    blocked: Boolean(last?.blocked),
    requests: attempts.length,
    totalMs: Date.now() - started,
    transportStatus: last?.status ?? null,
    maxBudget,
  });
}
