"use client";

import { useCallback, useEffect, useState } from "react";
import { Chat } from "@/components/Chat";
import { DemoFanout, DemoCache, DemoKill, DemoBudget } from "@/components/Demos";
import { Standings } from "@/components/Standings";
import { Decisions } from "@/components/Decisions";
import { Guardrails } from "@/components/Guardrails";
import { Roster } from "@/components/Roster";
import { HowItDecides } from "@/components/Explain";
import { Stat } from "@/components/ui";
import { ThemeToggle } from "@/components/ThemeToggle";
import { api } from "@/lib/base";

const TABS = [
  { id: "d1", label: "Demo 1 · every model" },
  { id: "d2", label: "Demo 2 · cache" },
  { id: "d3", label: "Demo 3 · what it believes" },
  { id: "d4", label: "Demo 4 · kill" },
  { id: "d5", label: "Demo 5 · budget" },
  { id: "chat", label: "Chat" },
  { id: "guard", label: "Guardrails" },
] as const;

export default function Page() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("d1");
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

  // Traffic starts itself when the page is opened. There is nothing to press
  // and nothing to remember: the curves need a stream of questions to learn
  // from, and asking a speaker to start it is one more thing to forget on
  // stage. It stops itself when nobody has had the page open for a while.
  useEffect(() => {
    fetch(api("/api/traffic"), { cache: "no-store" })
      .then((r) => r.json())
      .then((s) => {
        if (!s?.running) {
          return fetch(api("/api/traffic"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "start", rate: 3 }),
          });
        }
      })
      .catch(() => {});
  }, []);

  const s = live?.state;
  const sp = live?.spend;
  const offline = !s;
  const broken: string[] = s?.disabled_arms ?? [];
  const withheld: string[] = s?.withheld_arms ?? [];

  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-navy pb-4">
        <h1 className="font-[family-name:var(--font-bricolage)] text-[clamp(28px,6vw,40px)] font-extrabold leading-none tracking-[-0.02em]">
          One Endpoint, Every Model
        </h1>
        <ThemeToggle />
      </header>

      {/* Three numbers. Anything else competes with the log. */}
      <div className="mt-5 flex flex-wrap items-center gap-x-12 gap-y-5">
        <Stat value={offline ? "–" : s.total_requests.toLocaleString()} label="Questions asked" />
        <Stat value={offline ? "–" : s.errors} label="Failed answers" tone={!offline && s.errors === 0 ? "good" : "red"} />
        <Stat value={sp ? `$${sp.saved_usd.toFixed(2)}` : "–"} label="Saved" tone="red" />
      </div>

      {(broken.length > 0 || withheld.length > 0 || offline) && (
        <p className="mt-3 border-l-2 border-brand-red py-2 pl-3 text-[14px] text-brand-red">
          {offline
            ? "Cannot reach the gateway."
            : broken.length > 0
              ? `Switched off: ${broken.join(", ")}`
              : `The gateway is resting ${withheld.join(", ")} — it clears itself.`}
        </p>
      )}

      {/* Which models are in play, and what each turned out to be good at. */}
      <div className="mt-6">
        <Roster />
      </div>

      <div className="mt-4">
        <HowItDecides />
      </div>

      {/* The log gets the main position, not a strip at the edge. */}
      <div className="mt-8">
        <Decisions />
      </div>

      <nav className="mt-10 flex flex-wrap gap-1.5 border-b border-rule pb-3">
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
        {tab === "d1" && <DemoFanout />}
        {tab === "d2" && <DemoCache />}
        {tab === "d3" && <Standings />}
        {tab === "d4" && <DemoKill onChange={refresh} />}
        {tab === "d5" && <DemoBudget />}
        {tab === "chat" && <Chat />}
        {tab === "guard" && <Guardrails />}
      </div>
    </main>
  );
}
