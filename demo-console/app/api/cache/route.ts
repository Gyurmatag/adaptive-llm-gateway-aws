import { NextResponse } from "next/server";
import { complete } from "@/lib/gateway";

/** Demo 2: ask cold, then ask the SAME THING in different words.
 *
 *  Deliberately sequential - the reworded ask can only hit a cache the first
 *  ask has already populated, and firing both at once is a race that
 *  intermittently shows a miss on stage.
 */
export async function POST(req: Request) {
  const { cold, reworded } = await req.json();
  const first = await complete("nova-lite", cold, { maxTokens: 90 });
  const second = await complete("nova-lite", reworded, { maxTokens: 90 });
  return NextResponse.json({
    cold: first,
    reworded: second,
    hit: Boolean(second.similarity),
    speedup: first.ms > 0 ? +(first.ms / Math.max(second.ms, 1)).toFixed(1) : null,
  });
}
