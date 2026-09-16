"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/base";

type Side = { sent: number; ok: number; failed: number; costUsd: number };
type S = {
  running: boolean; mode: "gateway" | "both"; rate: number; elapsedS: number;
  stopsInS: number; openrouterConfigured: boolean; mine: Side; theirs: Side;
};

/** Start real traffic, optionally against both routers so the bill is a race
 *  rather than an anecdote. */
export function TrafficControl({ onChange }: { onChange?: () => void }) {
  const [s, setS] = useState<S | null>(null);
  const [busy, setBusy] = useState(false);
  const [both, setBoth] = useState(true);

  const poll = useCallback(async () => {
    const r = await fetch(api("/api/traffic"), { cache: "no-store" })
      .then((x) => x.json()).catch(() => null);
    if (r) setS(r);
  }, []);
  useEffect(() => { poll(); const t = setInterval(poll, 2000); return () => clearInterval(t); }, [poll]);

  async function toggle() {
    setBusy(true);
    await fetch(api("/api/traffic"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: s?.running ? "stop" : "start",
        rate: 3,
        mode: both ? "both" : "gateway",
      }),
    }).catch(() => null);
    setBusy(false); poll(); onChange?.();
  }

  const running = s?.running ?? false;
  const racing = running && s?.mode === "both";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button" onClick={toggle} disabled={busy}
          className={`inline-flex items-center gap-2 rounded-sm px-4 py-2 text-[14px] font-semibold transition-colors disabled:opacity-40 ${
            running ? "border border-brand-red text-brand-red" : "bg-navy text-canvas hover:opacity-90"}`}
        >
          <span className={`inline-block h-2 w-2 rounded-full ${running ? "animate-pulse bg-brand-red" : "bg-current"}`} />
          {busy ? "…" : running ? "Stop traffic" : "Start real traffic"}
        </button>

        {!running && s?.openrouterConfigured && (
          <label className="flex cursor-pointer items-center gap-2 text-[13.5px] text-muted-ink">
            <input type="checkbox" id="race-both" checked={both} onChange={(e) => setBoth(e.target.checked)}
                   className="h-4 w-4 accent-[var(--sf-red)]" />
            send every question to OpenRouter too, and race the bill
          </label>
        )}

        {running && (
          <span className="tabular text-[13px] text-muted-ink">
            {s?.rate}/s · {Math.floor((s?.elapsedS ?? 0) / 60)}m{(s?.elapsedS ?? 0) % 60}s
            {s?.stopsInS ? ` · stops in ${Math.round(s.stopsInS / 60)}m` : ""}
          </span>
        )}
      </div>

      {racing && s && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Bill title="This gateway" sub="adapts to your traffic" side={s.mine} />
          <Bill title="OpenRouter Auto" sub="adapts to the market" side={s.theirs} />
        </div>
      )}
    </div>
  );
}

function Bill({ title, sub, side }: { title: string; sub: string; side: Side }) {
  const each = side.ok ? side.costUsd / side.ok : 0;
  return (
    <div className="rounded-sm border border-rule bg-panel px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-[family-name:var(--font-bricolage)] text-[14px] font-bold">{title}</span>
        <span className="tabular font-[family-name:var(--font-bricolage)] text-[20px] font-extrabold text-brand-red">
          ${side.costUsd.toFixed(4)}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[12.5px] text-muted-ink">
        <span>{sub}</span>
        <span className="tabular">{side.ok} answers · ${each.toFixed(6)} each</span>
      </div>
    </div>
  );
}
