"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "./base";

export type Entry = Record<string, unknown> & { ts: number; event: string };

/** Live decision feed over SSE, newest last, capped so a long talk cannot
 *  grow the tab's memory without bound. */
export function useAuditStream(limit = 200, paused = false) {
  const [rows, setRows] = useState<Entry[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    // No separate seed fetch: the stream sends recent history on connect, and
    // doing both printed every line twice.
    const es = new EventSource(api("/api/audit/stream"));
    es.onmessage = (ev) => {
      if (pausedRef.current) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type !== "entries") return;
        setRows((prev) => {
          // Belt and braces: a reconnect replays the seed, so drop anything
          // already on screen. ts alone is not unique - a route and its reward
          // can land in the same millisecond.
          const seen = new Set(prev.map((r) => `${r.ts}|${r.event}|${r.arm ?? ""}`));
          const fresh = (msg.entries as Entry[]).filter(
            (e) => !seen.has(`${e.ts}|${e.event}|${(e as any).arm ?? ""}`),
          );
          return fresh.length ? [...prev, ...fresh].slice(-limit) : prev;
        });
      } catch { /* a malformed frame is not worth killing the feed for */ }
    };
    return () => es.close();
  }, [limit]);

  return rows;
}
