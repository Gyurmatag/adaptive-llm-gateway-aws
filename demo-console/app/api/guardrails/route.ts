import { NextResponse } from "next/server";
import { DASHBOARD } from "@/lib/gateway";
export const dynamic = "force-dynamic";
export async function GET() {
  const r = await fetch(`${DASHBOARD}/guardrails`, { cache: "no-store" })
    .then((x) => x.json()).catch(() => null);
  const shadow = await fetch(`${DASHBOARD}/shadow`, { cache: "no-store" })
    .then((x) => x.json()).catch(() => null);
  return NextResponse.json({ guardrails: r, shadow });
}
