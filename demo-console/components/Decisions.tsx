"use client";

import { useEffect, useRef, useState } from "react";
import { Panel } from "./ui";
import { useAuditStream } from "@/lib/useAudit";
import { describeEntry, kindOf } from "@/lib/describe";

export function Decisions() {
  const [live, setLive] = useState(true);
  const [only, setOnly] = useState<"all" | "route" | "reward">("all");
  const rows = useAuditStream(300, !live);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (live && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [rows, live]);

  const shown = rows.filter((r) =>
    only === "all" ? true : only === "route" ? r.event === "route" : r.event === "reward",
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {(["all", "route", "reward"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setOnly(k)}
            className={`rounded-sm border px-3 py-1.5 text-[13px] font-semibold transition-colors ${
              only === k ? "border-navy bg-navy text-canvas" : "border-rule text-muted-ink hover:text-navy"}`}>
            {k === "all" ? "Everything" : k === "route" ? "Routing" : "Rewards"}
          </button>
        ))}
        <button type="button" onClick={() => setLive((v) => !v)}
          className={`ml-auto rounded-sm border px-3 py-1.5 text-[13px] font-semibold transition-colors ${
            live ? "border-brand-red text-brand-red" : "border-rule text-muted-ink hover:text-navy"}`}>
          {live ? "● Live — pause" : "Paused — resume"}
        </button>
      </div>

      <Panel className="overflow-hidden">
        <div ref={box} className="max-h-[440px] overflow-y-auto">
          {shown.length === 0 && (
            <p className="p-5 text-[15px] text-muted-ink">
              Nothing yet. Press <b>Start traffic</b> at the top, or send anything from the Chat tab.
            </p>
          )}
          {shown.map((r, i) => {
            const k = kindOf(r.event);
            const t = new Date(r.ts * 1000).toLocaleTimeString([], {
              hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
            });
            const tone = k.tone === "alert" ? "text-brand-red"
              : k.tone === "reward" ? "text-good" : "text-muted-ink";
            return (
              <div key={`${r.ts}-${i}`}
                   className="grid grid-cols-[76px_92px_1fr] items-baseline gap-3 border-b border-rule px-4 py-2.5 last:border-b-0">
                <span className="tabular font-mono text-[12px] text-muted-ink">{t}</span>
                <span className={`font-mono text-[11px] font-bold tracking-[0.08em] ${tone}`}>{k.label}</span>
                <span className="text-[14px] text-navy">{describeEntry(r)}</span>
              </div>
            );
          })}
        </div>
      </Panel>
    </section>
  );
}
