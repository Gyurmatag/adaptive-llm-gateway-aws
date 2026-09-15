/** Server-side gateway access. Never import this from a client component. */

export const GATEWAY = process.env.GATEWAY_BASE_URL ?? "";
export const DASHBOARD = process.env.DASHBOARD_BASE_URL ?? "";
export const KEY = process.env.LITELLM_MASTER_KEY ?? "";

/** The five bandit arms, plus the router group that picks between them. */
export const ARMS = [
  { id: "demo-router", label: "Adaptive router", note: "picks an arm per request" },
  { id: "claude-sonnet", label: "Claude Sonnet 4.5", note: "Anthropic" },
  { id: "claude-haiku", label: "Claude Haiku 4.5", note: "Anthropic" },
  { id: "nova-lite", label: "Nova Lite", note: "Amazon" },
  { id: "gpt-on-bedrock", label: "GPT OSS 120B", note: "OpenAI on Bedrock" },
  { id: "ipr-nova", label: "Nova prompt router", note: "Bedrock IPR" },
] as const;

export function authHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...extra };
}

/** One non-streaming completion. Returns the text, the wall time and the
 *  headers the demos actually point at. */
export async function complete(model: string, content: string, opts: {
  maxTokens?: number; noCache?: boolean;
} = {}) {
  const started = Date.now();
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      max_tokens: opts.maxTokens ?? 120,
      ...(opts.noCache ? { cache: { "no-cache": true } } : {}),
    }),
    cache: "no-store",
  });
  const ms = Date.now() - started;
  const body = await res.json().catch(() => ({}));
  return {
    ok: res.ok && Boolean(body?.choices),
    ms,
    status: res.status,
    text: body?.choices?.[0]?.message?.content ?? "",
    servedBy: res.headers.get("x-litellm-model-id"),
    // The number Demo 2 turns on. Absent means the cache missed.
    similarity: res.headers.get("x-litellm-semantic-similarity"),
    cacheKey: res.headers.get("x-litellm-cache-key"),
    error: body?.error ?? null,
  };
}
