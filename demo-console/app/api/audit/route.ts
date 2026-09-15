import { NextResponse } from "next/server";
import { DASHBOARD } from "@/lib/gateway";

export const dynamic = "force-dynamic";

/** Every routing decision and the reason for it, newest last. */
export async function GET(req: Request) {
  const limit = new URL(req.url).searchParams.get("limit") ?? "40";
  const r = await fetch(`${DASHBOARD}/audit?limit=${encodeURIComponent(limit)}`, {
    cache: "no-store",
  })
    .then((x) => x.json())
    .catch(() => ({ entries: [] }));
  return NextResponse.json(r);
}
