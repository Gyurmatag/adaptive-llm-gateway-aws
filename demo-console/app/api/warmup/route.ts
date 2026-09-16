import { NextResponse } from "next/server";
import { GATEWAY, authHeaders } from "@/lib/gateway";

export const maxDuration = 300;

/** Ask a spread of real questions so the curves have something to be built from.
 *
 *  Nothing runs in the background any more, so evidence only exists because
 *  somebody asked for it. This is that button: a bounded, visible burst across
 *  the four kinds of question the router scores separately.
 */
const QUESTIONS = [
  "Write a Python function that reverses a list.",
  "Write a SQL query that finds duplicate rows.",
  "Why do databases use B-trees? Explain briefly.",
  "Why is connection pooling worth it? Explain.",
  "Summarise what a database index is, in one line.",
  "Summarise why caching helps, briefly.",
  "What is the capital of Hungary?",
  "What is the default port for PostgreSQL?",
];

export async function POST(req: Request) {
  const { rounds = 6 } = await req.json().catch(() => ({}));
  let sent = 0, failed = 0;
  for (let r = 0; r < rounds; r++) {
    await Promise.all(
      QUESTIONS.map(async (q) => {
        sent++;
        try {
          const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({
              model: "demo-router",
              messages: [{ role: "user", content: `${q} #${r}-${Date.now()}` }],
              max_tokens: 120,
              cache: { "no-cache": true },
            }),
            cache: "no-store",
          });
          await res.arrayBuffer();
          if (!res.ok) failed++;
        } catch { failed++; }
      }),
    );
  }
  return NextResponse.json({ sent, failed });
}
