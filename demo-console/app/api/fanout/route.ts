import { NextResponse } from "next/server";
import { complete } from "@/lib/gateway";

/** Demo 1: one prompt, every model, in parallel. */
export async function POST(req: Request) {
  const { prompt, models } = await req.json();
  const list: string[] = models?.length
    ? models
    : ["claude-sonnet", "nova-lite", "gpt-on-bedrock"];

  const results = await Promise.all(
    list.map(async (m) => ({ model: m, ...(await complete(m, prompt, { maxTokens: 90, noCache: true })) })),
  );
  return NextResponse.json({ results });
}
