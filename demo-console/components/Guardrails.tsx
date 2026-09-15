"use client";

import { useCallback, useEffect, useState } from "react";
import { Panel, Button, Label } from "./ui";
import { api } from "@/lib/base";
import { Explain } from "./Explain";

type G = Record<string, any>;

export function Guardrails() {
  const [g, setG] = useState<G | null>(null);
  const [shadow, setShadow] = useState<G | null>(null);
  const [busy, setBusy] = useState(false);
  const [affinity, setAffinity] = useState<G | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(api("/api/guardrails"), { cache: "no-store" })
      .then((x) => x.json()).catch(() => null);
    if (r) { setG(r.guardrails); setShadow(r.shadow); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  async function policy(action: "freeze" | "learn" | "shadow-on" | "shadow-off") {
    setBusy(true);
    await fetch(api("/api/policy"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => null);
    setBusy(false); load();
  }

  async function runAffinity() {
    setBusy(true); setAffinity(null);
    const r = await fetch(api("/api/affinity"), { method: "POST" })
      .then((x) => x.json()).catch(() => null);
    setAffinity(r); setBusy(false);
  }

  if (!g) return <p className="text-[15px] text-muted-ink">Loading guardrails…</p>;

  const frozen = g.mode === "snapshot";

  return (
    <section className="flex flex-col gap-6">
      <div>
        <Label>Production grade</Label>
        <h2 className="mt-1 font-[family-name:var(--font-bricolage)] text-[26px] font-extrabold leading-tight tracking-[-0.01em]">
          What it takes to run this at a bank
        </h2>
        <p className="mt-2 max-w-[62ch] text-[15px] text-muted-ink">
          A thing that learns changes its own behaviour. Three groups of guardrails make that
          acceptable — and every one of them is live, not a slide.
        </p>
      </div>

      <Explain title="Why a bank would ask for all this">
        <p>Something that learns changes its own behaviour — and an auditor cannot sign off on
        &ldquo;it decided differently today&rdquo;.</p>
        <p>So: you can <b>freeze</b> it, so the same question always goes the same way. You can
        <b> switch any model off</b> by hand. Every decision is <b>written down with its reason
        and its cost</b>. And it is never allowed to pick a cheap model that is below the
        quality line you set.</p>
      </Explain>

      {/* 1. take the learning out of production */}
      <Panel className="p-5">
        <h3 className="font-[family-name:var(--font-bricolage)] text-[17px] font-bold">
          Take the learning out of production
        </h3>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span
            className={`rounded-sm px-3 py-1.5 font-mono text-[12px] font-bold uppercase tracking-[0.08em] ${
              frozen ? "bg-navy text-canvas" : "border border-rule text-muted-ink"
            }`}
          >
            {frozen ? "Snapshot — frozen" : "Learning"}
          </span>
          {g.policy_id && (
            <span className="font-mono text-[12.5px] text-muted-ink">
              policy <b className="text-navy">{String(g.policy_id).slice(0, 12)}</b>
            </span>
          )}
          <div className="ml-auto flex gap-2">
            <Button tone={frozen ? "quiet" : "solid"} disabled={busy} onClick={() => policy("freeze")}>
              Freeze the policy
            </Button>
            <Button tone="quiet" disabled={busy || !frozen} onClick={() => policy("learn")}>
              Resume learning
            </Button>
          </div>
        </div>
        <p className="mt-3 max-w-[62ch] text-[14px] text-muted-ink">
          Frozen, the same input takes the same route every time and the version is a content
          hash you can diff against the last one. Nothing learns from the request in front of it.
        </p>
        <div className="mt-4 border-t border-rule pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Row k="Shadow mode" v={g.shadow ? "on — deciding, not serving" : "off"} />
            <Button tone="quiet" disabled={busy}
                    onClick={() => policy(g.shadow ? "shadow-off" : "shadow-on")}>
              {g.shadow ? "Stop shadowing" : "Run in shadow"}
            </Button>
          </div>
          <p className="mt-1 text-[13.5px] text-muted-ink">
            {shadow && !shadow.error
              ? `Counterfactual log: ${shadow.decisions ?? "?"} decisions, ${
                  typeof shadow.agreement === "number" ? Math.round(shadow.agreement * 100) + "% agreement with the incumbent" : "see /dash/shadow"
                }`
              : "No shadow log yet — a new policy runs here first, recording what it would have picked without serving it."}
          </p>
        </div>
      </Panel>

      {/* 2. keep a person above it */}
      <Panel className="p-5">
        <h3 className="font-[family-name:var(--font-bricolage)] text-[17px] font-bold">
          Keep a person above it
        </h3>
        <div className="mt-3">
          <Row k="Pinned to one model" v={g.pinned_arm ?? "not pinned"} />
          <Row k="Switched off (your breaker)" v={(g.disabled_arms ?? []).join(", ") || "none"}
               alert={(g.disabled_arms ?? []).length > 0} />
          <Row k="Withheld by the gateway" v={(g.withheld_arms ?? []).join(", ") || "none"}
               alert={(g.withheld_arms ?? []).length > 0} />
          <Row k="Every decision logged" v="reason + cost, on the Decisions tab" />
        </div>
      </Panel>

      {/* 3. stop it optimising the wrong thing */}
      <Panel className="p-5">
        <h3 className="font-[family-name:var(--font-bricolage)] text-[17px] font-bold">
          Stop it optimising the wrong thing
        </h3>
        <div className="mt-3">
          <Row k="Quality floor" v={g.quality_floor > 0
            ? `${g.quality_floor} — an arm below this is excluded outright`
            : "not set"} />
          <Row k="Scored separately by task type" v={g.stratified
            ? `on — ${(g.task_classes ?? []).filter((c: string) => c !== "_all").join(", ") || "warming up"}`
            : "off — one pooled score"} />
        </div>
        {g.stratified && g.per_class && (
          <div className="mt-4 border-t border-rule pt-4">
            <Explain title="The most important table on this screen">
              <p>The same model can be the <b>best</b> at one kind of question and the <b>worst</b> at
              another.</p>
              <p>Average them together and that disappears — you get one mediocre-looking number, and
              the router quietly gets worse at the hard questions while winning the easy ones.</p>
            </Explain>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[520px] text-[13.5px]">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase tracking-[0.1em] text-muted-ink">
                    <th className="py-1 pr-4">Kind of question</th>
                    <th className="py-1 pr-4">Best at it</th>
                    <th className="py-1">Worst at it</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(g.per_class as Record<string, Record<string, any>>)
                    .filter(([tc]) => tc !== "_all")
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([tc, arms]) => {
                      const ranked = Object.entries(arms)
                        .filter(([, v]) => v.observations > 0)
                        .sort((a, b) => b[1].mean - a[1].mean);
                      const top = ranked[0];
                      const bot = ranked[ranked.length - 1];
                      return (
                        <tr key={tc} className="border-t border-rule">
                          <td className="py-2 pr-4 font-mono">{tc}</td>
                          <td className="py-2 pr-4">
                            {top ? <><b>{top[0]}</b> <span className="tabular text-good">{top[1].mean.toFixed(2)}</span></> : "—"}
                          </td>
                          <td className="py-2">
                            {bot && bot !== top ? <>{bot[0]} <span className="tabular text-brand-red">{bot[1].mean.toFixed(2)}</span></> : "—"}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[14px] text-navy">
              Look for a model that appears in both columns. That is the one a single pooled score
              would have hidden.
            </p>
          </div>
        )}
      </Panel>

      {/* the second trap */}
      <Panel className="p-5">
        <h3 className="font-[family-name:var(--font-bricolage)] text-[17px] font-bold">
          Route between conversations, never inside one
        </h3>
        <p className="mt-2 max-w-[62ch] text-[14px] text-muted-ink">
          The cache wants you to stay put; the router wants you to move. Switch mid-conversation
          and the warm prefix is gone. So a conversation picks a model on its first turn and stays.
        </p>
        <div className="mt-3">
          <Row k="Session affinity" v={g.session_affinity
            ? `on — a conversation sticks for ${Math.round((g.session_ttl_s ?? 0) / 60)} min`
            : "off"} />
        </div>
        <div className="mt-4"><Button disabled={busy} onClick={runAffinity}>
          {busy ? "Running…" : "Prove it — 6 turns in one conversation, 6 loose"}
        </Button></div>
        {affinity && (
          <div className="mt-4 grid gap-4 border-t border-rule pt-4 sm:grid-cols-2">
            <div>
              <Label>One conversation</Label>
              <p className="mt-1 font-mono text-[13px]">{affinity.pinned.join(" → ")}</p>
              <p className="mt-1 text-[13.5px] text-muted-ink">
                {affinity.pinnedDistinct === 1 ? "one model throughout — cache stays warm" : `${affinity.pinnedDistinct} models`}
              </p>
            </div>
            <div>
              <Label>Unrelated requests</Label>
              <p className="mt-1 font-mono text-[13px]">{affinity.loose.join(" → ")}</p>
              <p className="mt-1 text-[13.5px] text-muted-ink">
                {affinity.looseDistinct > 1 ? `${affinity.looseDistinct} models — free to route` : "one model"}
              </p>
            </div>
          </div>
        )}
      </Panel>

      <p className="text-[13px] text-muted-ink">
        gamma {g.gamma} · explore {g.explore_p} · min observations {g.min_observations} · judge
        samples {Math.round(g.judge_sample_rate * 100)}% at threshold {g.judge_threshold} · decay {g.decay_lambda}
      </p>
    </section>
  );
}

function Row({ k, v, alert }: { k: string; v: string; alert?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-rule py-2 last:border-b-0">
      <span className="text-[14.5px] text-muted-ink">{k}</span>
      <span className={`text-[14.5px] font-semibold ${alert ? "text-brand-red" : "text-navy"}`}>{v}</span>
    </div>
  );
}
