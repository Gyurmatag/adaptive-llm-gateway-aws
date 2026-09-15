import { NextResponse } from "next/server";
import { GATEWAY, authHeaders } from "@/lib/gateway";

/** Demo the second trap: route BETWEEN conversations, never inside one.
 *
 *  Sends the same prompt N times with one conversation id, then N times with
 *  no id at all, and reports which model served each. Pinned should be one
 *  model throughout; unpinned should scatter.
 */
async function ask(content: string, session: string | null) {
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "demo-router",
      messages: [{ role: "user", content }],
      max_tokens: 40,
      cache: { "no-cache": true },
      ...(session ? { user: session } : {}),
    }),
    cache: "no-store",
  });
  await res.json().catch(() => ({}));
  return res.headers.get("x-litellm-model-id") ?? "unknown";
}

export async function POST() {
  const id = `conv-${Date.now()}`;
  const pinned: string[] = [];
  const loose: string[] = [];
  for (let i = 0; i < 6; i++) pinned.push(await ask(`Turn ${i} of one conversation.`, id));
  for (let i = 0; i < 6; i++) loose.push(await ask(`Unrelated request ${i}.`, null));
  return NextResponse.json({
    conversationId: id,
    pinned,
    loose,
    pinnedDistinct: [...new Set(pinned)].length,
    looseDistinct: [...new Set(loose)].length,
  });
}
