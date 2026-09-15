import { NextResponse } from "next/server";
import { DASHBOARD, authHeaders } from "@/lib/gateway";

/** Freeze the live posteriors into a versioned policy, or go back to learning. */
export async function POST(req: Request) {
  const { action } = await req.json();
  const url =
    action === "freeze" ? `${DASHBOARD}/admin/policy`
    : action === "shadow-on" ? `${DASHBOARD}/admin/shadow?on=true`
    : action === "shadow-off" ? `${DASHBOARD}/admin/shadow?on=false`
    : `${DASHBOARD}/admin/mode?mode=learn`;
  const res = await fetch(url, { method: "POST", headers: authHeaders(), cache: "no-store" });
  return NextResponse.json(await res.json().catch(() => ({ ok: res.ok })), { status: res.status });
}
