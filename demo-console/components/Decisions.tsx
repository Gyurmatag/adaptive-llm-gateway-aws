"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, Label } from "./ui";
import { api } from "@/lib/base";

type Entry = Record<string, unknown> & { ts: number; event: string };

// Why a request went where it went. These are the strings the router writes,
// spelled out for a room that has never seen them.
const REASON: Record<string, string> = {
  thompson: "sampled the posteriors",
  cold_start_exploration: "exploring — fewest observations",
  session_affinity: "pinned to this conversation",
  operator_pin: "operator pin",
  snapshot: "frozen policy",
  snapshot_degraded: "frozen policy, no artifact",
};

const KIND: Record<string, { label: string; tone: "route" | "reward" | "alert" }> = {
  route: { label: "ROUTE", tone: "route" },
  reward: { label: "REWARD", tone: "reward" },
  breaker_active: { label: "BREAKER", tone: "alert" },
  arm_withheld: { label: "WITHHELD", tone: "alert" },
  arm_restored: { label: "RESTORED", tone: "reward" },
  client_error: { label: "ERROR", tone: "alert" },
  judge_error: { label: "JUDGE", tone: "alert" },
  reward_error: { label: "REWARD", tone: "alert" },
  failure: { label: "FAILURE", tone: "alert" },
};

export function Decisions() {
  const [rows, setRows] = useState<Entry[]>([]);
  const [live, setLive] = useState(true);
  const [only, setOnly] = useState<"all" | "route" | "reward">("all");
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const r = await fetch(api("/api/audit?limit=60"), { cache: "no-store" })
      .then((x) => x.json())
      .catch(() => null);
    if (r?.entries) setRows(r.entries);
  }, []);

  useEffect(() => {
    load();
    if (!live) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load, live]);

  useEffect(() => {
    if (live && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [rows, live]);

  const shown = rows.filter((r) =>
    only === "all" ? true : only === "route" ? r.event === "route" : r.event === "reward",
  );

  return (
    <section className="flex flex-col gap-4">
      <div>
        <Label>Audit log</Label>
        <h2 className="mt-1 font-[family-name:var(--font-bricolage)] text-[26px] font-extrabold leading-tight tracking-[-0.01em]">
          Every decision, and why
        </h2>
        <p className="mt-2 max-w-[62ch] text-[15px] text-muted-ink">
          One line per routing decision, written as it happens. &ldquo;The router changed its
          mind&rdquo; is not an answer for a risk committee — so the reason is recorded, with the
          sampled value and the cost-adjusted score for every arm it considered.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(["all", "route", "reward"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setOnly(k)}
            className={`rounded-sm border px-3 py-1.5 text-[13px] font-semibold capitalize transition-colors ${
              only === k ? "border-navy bg-navy text-canvas" : "border-rule text-muted-ink hover:text-navy"
            }`}
          >
            {k === "all" ? "Everything" : k === "route" ? "Routing" : "Rewards"}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setLive((v) => !v)}
          className={`ml-auto rounded-sm border px-3 py-1.5 text-[13px] font-semibold transition-colors ${
            live ? "border-brand-red text-brand-red" : "border-rule text-muted-ink hover:text-navy"
          }`}
        >
          {live ? "● Live — pause" : "Paused — resume"}
        </button>
      </div>

      <Panel className="overflow-hidden">
        <div ref={box} className="max-h-[440px] overflow-y-auto">
          {shown.length === 0 && (
            <p className="p-5 text-[15px] text-muted-ink">
              Nothing yet. Start the load generator, or send anything from the Chat tab.
            </p>
          )}
          {shown.map((r, i) => {
            const k = KIND[r.event] ?? { label: r.event.toUpperCase(), tone: "route" as const };
            const t = new Date((r.ts as number) * 1000).toLocaleTimeString([], {
              hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
            });
            const tone =
              k.tone === "alert" ? "text-brand-red"
              : k.tone === "reward" ? "text-good"
              : "text-muted-ink";
            return (
              <div
                key={`${r.ts}-${i}`}
                className="grid grid-cols-[76px_92px_1fr] items-baseline gap-3 border-b border-rule px-4 py-2.5 last:border-b-0"
              >
                <span className="tabular font-mono text-[12px] text-muted-ink">{t}</span>
                <span className={`font-mono text-[11px] font-bold tracking-[0.08em] ${tone}`}>
                  {k.label}
                </span>
                <span className="text-[14px] text-navy">{describe(r)}</span>
              </div>
            );
          })}
        </div>
      </Panel>

      <p className="text-[13px] text-muted-ink">
        Same file the gateway writes to disk, tailed live — not a reconstruction.
      </p>
    </section>
  );
}

function describe(r: Entry): string {
  const arm = (r.arm as string) ?? "";
  switch (r.event) {
    case "route": {
      const why = REASON[(r.reason as string) ?? ""] ?? (r.reason as string) ?? "";
      const score = r.score as Record<string, number> | undefined;
      const best = score && Object.keys(score).length
        ? ` · best score ${Math.max(...Object.values(score)).toFixed(2)} of ${Object.keys(score).length} arms`
        : "";
      return `chose ${arm} — ${why}${best}`;
    }
    case "reward": {
      const s = r.judge_score as number | null;
      const okFlag = r.success as boolean | null;
      const ms = Math.round((r.latency_ms as number) ?? 0);
      return `${arm} judged ${s === null || s === undefined ? "—" : s.toFixed(2)} → ${
        okFlag ? "counted as good" : "counted as not good enough"
      } · ${ms} ms`;
    }
    case "arm_withheld":
      return `${arm} removed from routing by the gateway — cooldown or rate limit`;
    case "arm_restored":
      return `${arm} back in routing after ${Math.round((r.withheld_s as number) ?? 0)}s`;
    case "breaker_active":
      return `withholding ${(r.excluded as string[] ?? []).join(", ")} — circuit breaker`;
    case "client_error":
    case "failure":
      return `${arm || "request"} failed — ${String(r.error ?? "").slice(0, 90)}`;
    case "judge_error":
      return `judge unavailable — ${String(r.error ?? "").slice(0, 90)}`;
    default:
      return JSON.stringify(r).slice(0, 120);
  }
}
