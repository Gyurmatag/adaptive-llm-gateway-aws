"use client";

import { useCallback, useEffect, useState } from "react";
import { Chat } from "@/components/Chat";
import { DemoFanout, DemoCache, DemoKill, DemoBudget } from "@/components/Demos";
import { Decisions } from "@/components/Decisions";
import { Guardrails } from "@/components/Guardrails";
import { Stat } from "@/components/ui";
import { api } from "@/lib/base";

const TABS = [
  { id: "chat", label: "Chat" },
  { id: "d1", label: "Demo 1 · every model" },
  { id: "d2", label: "Demo 2 · cache" },
  { id: "d4", label: "Demo 4 · kill" },
  { id: "d5", label: "Demo 5 · budget" },
  { id: "log", label: "Decisions · live log" },
  { id: "guard", label: "Guardrails" },
] as const;

export default function Page() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("chat");
  const [live, setLive] = useState<{ state: any; spend: any } | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch(api("/api/state"), { cache: "no-store" }).then((x) => x.json()).catch(() => null);
    if (r) setLive(r);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const s = live?.state;
  const sp = live?.spend;
  const offline = !s;
  const broken: string[] = s?.disabled_arms ?? [];
  const withheld: string[] = s?.withheld_arms ?? [];

  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <header className="border-b-2 border-navy pb-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-ink">
          AWS Community Day CEE · live against production
        </p>
        <h1 className="mt-2 font-[family-name:var(--font-bricolage)] text-[clamp(28px,6vw,42px)] font-extrabold leading-none tracking-[-0.02em]">
          One Endpoint, Every Model
        </h1>
      </header>

      {/* Live strip. The same numbers as the projector, so the speaker never
          has to turn around to check the state of the stack. */}
      <div className="mt-5 flex flex-wrap items-center gap-x-10 gap-y-5 rounded-sm border border-rule bg-panel px-5 py-4">
        <Stat value={offline ? "–" : s.total_requests.toLocaleString()} label="Requests" />
        <Stat value={offline ? "–" : s.errors} label="Errors" tone={!offline && s.errors === 0 ? "good" : "red"} />
        <Stat value={sp ? `$${sp.saved_usd.toFixed(2)}` : "–"} label="Saved" tone="red" />
        <Stat value={sp ? `${sp.saved_pct.toFixed(0)}%` : "–"} label="Cheaper" />
        <Stat value={offline ? "–" : (s.leader ?? "–")} label="Taking traffic" />
      </div>

      {(broken.length > 0 || withheld.length > 0 || offline) && (
        <p className="mt-3 border-l-2 border-brand-red bg-[color-mix(in_srgb,var(--sf-red)_8%,transparent)] py-2 pl-3 text-[14px] text-brand-red">
          {offline
            ? "Cannot reach the gateway."
            : broken.length > 0
              ? `Switched off: ${broken.join(", ")} — these take no traffic until you restore them.`
              : `The gateway is withholding ${withheld.join(", ")} after network trouble. It clears itself.`}
        </p>
      )}

      <nav className="mt-7 flex flex-wrap gap-1.5 border-b border-rule pb-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-sm px-3.5 py-2 text-[14px] font-semibold transition-colors ${
              tab === t.id ? "bg-navy text-canvas" : "text-muted-ink hover:text-navy"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="mt-8">
        {tab === "chat" && <Chat />}
        {tab === "d1" && <DemoFanout />}
        {tab === "d2" && <DemoCache />}
        {tab === "d4" && <DemoKill onChange={refresh} />}
        {tab === "d5" && <DemoBudget />}
        {tab === "log" && <Decisions />}
        {tab === "guard" && <Guardrails />}
      </div>
    </main>
  );
}
