"use client";

import { useEffect, useRef } from "react";
import { useAuditStream } from "@/lib/useAudit";
import { describeEntry, kindOf } from "@/lib/describe";

/** Always-on ticker. The full, filterable view is the Decisions tab; this is
 *  here so the log is never more than a glance away, whichever tab is open. */
export function LiveLog() {
  const rows = useAuditStream(60);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [rows]);

  return (
    <div className="rounded-sm border border-rule bg-panel">
      <div className="flex items-center gap-2 border-b border-rule px-4 py-2">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand-red" />
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-ink">
          Live · every routing decision as it happens
        </span>
      </div>
      <div ref={box} className="h-[104px] overflow-y-auto px-4 py-2">
        {rows.length === 0 && (
          <p className="py-2 text-[13px] text-muted-ink">
            Waiting for traffic — press Start traffic above, or ask something on the Chat tab.
          </p>
        )}
        {rows.slice(-40).map((r, i) => {
          const k = kindOf(r.event);
          const t = new Date(r.ts * 1000).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
          return (
            <div key={`${r.ts}-${i}`} className="flex items-baseline gap-3 py-0.5">
              <span className="tabular shrink-0 font-mono text-[11.5px] text-muted-ink">{t}</span>
              <span className={`shrink-0 font-mono text-[10px] font-bold tracking-[0.08em] ${
                k.tone === "alert" ? "text-brand-red" : k.tone === "reward" ? "text-good" : "text-muted-ink"}`}>
                {k.label}
              </span>
              <span className="truncate text-[13px] text-navy">{describeEntry(r)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
