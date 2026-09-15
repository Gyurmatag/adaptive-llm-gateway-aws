import { NextResponse } from "next/server";
import { DASHBOARD } from "@/lib/gateway";

export const dynamic = "force-dynamic";

/** Live posteriors, spend and breaker state, proxied so the browser never
 *  needs to know where the gateway is. */
export async function GET() {
  const [state, spend] = await Promise.all([
    fetch(`${DASHBOARD}/state`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    fetch(`${DASHBOARD}/spend`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
  ]);
  return NextResponse.json({ state, spend });
}
