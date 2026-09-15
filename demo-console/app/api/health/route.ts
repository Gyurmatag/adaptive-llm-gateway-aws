import { NextResponse } from "next/server";

/** The ALB target group health check. Deliberately does not touch the gateway:
 *  a slow upstream must not make the console look unhealthy and get killed. */
export function GET() {
  return NextResponse.json({ ok: true });
}
