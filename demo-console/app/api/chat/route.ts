import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { GATEWAY, KEY } from "@/lib/gateway";

// The gateway speaks the OpenAI wire format, so the OpenAI-compatible provider
// talks to it directly - no adapter, no translation layer. This is the point
// of the talk expressed as three lines of configuration.
const gateway = createOpenAICompatible({
  name: "adaptive-gateway",
  baseURL: `${GATEWAY}/v1`,
  apiKey: KEY,
  // A CONVERSATION MUST NEVER BE SERVED FROM THE SEMANTIC CACHE.
  //
  // This is the trap the production slide names: consecutive turns in one chat
  // look ~99% alike, so a semantic cache happily answers turn five with turn
  // four's answer. It is worse than that in practice - a follow-up carries the
  // previous question AND its answer, which is the exact shape of the judge's
  // grading prompt, so it can match a cached JUDGE response instead.
  //
  // Observed live: "write it in typescript" came back as {"score": 0.8} at
  // similarity 0.89. Demo 2 is where the cache is shown on purpose, with
  // single-turn questions. The chat opts out entirely.
  fetch: async (url, init) => {
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body);
        body.cache = { "no-cache": true, "no-store": true };
        init = { ...init, body: JSON.stringify(body) };
      } catch {
        // Not JSON we understand - send it untouched rather than break the call.
      }
    }
    return fetch(url, init);
  },
});

export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages, model }: { messages: UIMessage[]; model?: string } = await req.json();

  const result = streamText({
    model: gateway(model ?? "demo-router"),
    messages: convertToModelMessages(messages),
    maxOutputTokens: 400,
  });

  return result.toUIMessageStreamResponse({
    // Surface the real error rather than "an error occurred", because on stage
    // a silent failure is indistinguishable from a slow one.
    onError: (e) => (e instanceof Error ? e.message : String(e)),
  });
}
