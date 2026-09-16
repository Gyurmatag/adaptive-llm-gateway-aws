import { NextResponse } from "next/server";
import { start, stop, status } from "@/lib/traffic";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(status());
}

export async function POST(req: Request) {
  const { action, rate, mode } = await req.json().catch(() => ({ action: "status" }));
  if (action === "start") return NextResponse.json(start(Number(rate) || 3, mode === "both" ? "both" : "gateway"));
  if (action === "stop") return NextResponse.json(stop());
  return NextResponse.json(status());
}
