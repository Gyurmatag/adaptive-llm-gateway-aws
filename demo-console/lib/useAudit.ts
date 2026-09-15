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
    // Seed from the snapshot so the panel is never empty on first paint.
    fetch(api("/api/audit?limit=40"), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (d?.entries) setRows(d.entries); })
      .catch(() => {});

    const es = new EventSource(api("/api/audit/stream"));
    es.onmessage = (ev) => {
      if (pausedRef.current) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type !== "entries") return;
        setRows((prev) => [...prev, ...msg.entries].slice(-limit));
      } catch { /* a malformed frame is not worth killing the feed for */ }
    };
    return () => es.close();
  }, [limit]);

  return rows;
}
