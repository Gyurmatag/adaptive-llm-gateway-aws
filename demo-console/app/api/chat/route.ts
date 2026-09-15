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
