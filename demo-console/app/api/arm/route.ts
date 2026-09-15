import { NextResponse } from "next/server";
import { DASHBOARD, authHeaders } from "@/lib/gateway";

/** Demo 4: the kill switch.
 *
 *  The admin endpoint, not kill_primary.sh's DISABLED file - the file lives on
 *  the laptop and the gateway runs on ECS, so writing it locally does nothing
 *  at all while reporting success.
 */
export async function POST(req: Request) {
  const { action, arm } = await req.json();
  const url =
    action === "enable"
      ? `${DASHBOARD}/admin/enable`
      : `${DASHBOARD}/admin/disable?arm=${encodeURIComponent(arm)}`;
  const res = await fetch(url, { method: "POST", headers: authHeaders(), cache: "no-store" });
  return NextResponse.json(await res.json().catch(() => ({ ok: res.ok })), { status: res.status });
}
