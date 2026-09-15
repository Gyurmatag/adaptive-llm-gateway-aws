"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/base";

type S = { running: boolean; rate: number; sent: number; ok: number; failed: number; elapsedS: number; stopsInS: number };

/** Start and stop the load generator without a terminal. */
export function TrafficControl({ onChange }: { onChange?: () => void }) {
  const [s, setS] = useState<S | null>(null);
  const [busy, setBusy] = useState(false);

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
      body: JSON.stringify({ action: s?.running ? "stop" : "start", rate: 3 }),
    }).catch(() => null);
    setBusy(false); poll(); onChange?.();
  }

  const running = s?.running ?? false;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button" onClick={toggle} disabled={busy}
        className={`inline-flex items-center gap-2 rounded-sm px-4 py-2 text-[14px] font-semibold transition-colors disabled:opacity-40 ${
          running ? "border border-brand-red text-brand-red hover:bg-brand-red/5" : "bg-navy text-canvas hover:opacity-90"
        }`}
      >
        <span className={running ? "inline-block h-2 w-2 rounded-full bg-brand-red" : "inline-block h-2 w-2 rounded-full bg-current"} />
        {busy ? "…" : running ? "Stop traffic" : "Start traffic"}
      </button>
      {s && running && (
        <span className="tabular text-[13px] text-muted-ink">
          {s.rate}/s · {s.sent} sent · {s.failed} failed · {Math.floor(s.elapsedS / 60)}m{s.elapsedS % 60}s
          {s.stopsInS > 0 && <> · auto-stops in {Math.round(s.stopsInS / 60)}m</>}
        </span>
      )}
      {s && !running && (
        <span className="text-[13px] text-muted-ink">
          {s.sent > 0 ? `stopped after ${s.sent} requests` : "the curves need traffic to learn from"}
        </span>
      )}
    </div>
  );
}
