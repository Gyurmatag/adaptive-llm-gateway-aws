import { DASHBOARD } from "@/lib/gateway";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

/** Real-time decision feed, relayed straight from the gateway.
 *
 *  The gateway pushes each decision to open connections at the moment it makes
 *  it - see dashboard/app.py _publish_audit - so this is a pipe, not a poller.
 *  Nothing here re-reads a file or runs on an interval; a decision reaches the
 *  browser in the same breath the router takes it.
 *
 *  It exists at all only because the master key must not reach the browser:
 *  the gateway stream needs no auth, but keeping every gateway call on one
 *  origin means the client never learns where the gateway is.
 */
export async function GET(req: Request) {
  const upstream = await fetch(`${DASHBOARD}/audit/stream`, {
    headers: { Accept: "text/event-stream" },
    cache: "no-store",
    // Abort the upstream stream when the browser goes away, instead of
    // leaving a connection open for the rest of the conference.
    signal: req.signal,
  }).catch(() => null);

  if (!upstream?.ok || !upstream.body) {
    return new Response(`data: ${JSON.stringify({ type: "error" })}\n\n`, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
