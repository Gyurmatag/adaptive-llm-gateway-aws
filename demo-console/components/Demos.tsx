"use client";

import { useState } from "react";
import { Panel, Button, Label, Stat } from "./ui";

type Fan = { model: string; ok: boolean; ms: number; text: string; servedBy: string | null };

export function DemoFanout() {
  const [rows, setRows] = useState<Fan[] | null>(null);
  const [busy, setBusy] = useState(false);
  const prompt = "What is the capital of Hungary? Answer in one short sentence.";

  async function run() {
    setBusy(true); setRows(null);
    const r = await fetch("/api/fanout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }).then((x) => x.json()).catch(() => ({ results: [] }));
    setRows(r.results); setBusy(false);
  }

  return (
    <section className="flex flex-col gap-4">
      <Header n="Demo 1" title="One endpoint, every model"
        blurb="The same request, the same shape, three different vendors. Nothing in the application code knows which one answered." />
      <p className="rounded-sm border border-rule bg-warm-gray px-4 py-3 font-mono text-[13px] text-navy">{prompt}</p>
      <div><Button onClick={run} disabled={busy}>{busy ? "Asking all three…" : "Ask all three"}</Button></div>
      {rows && (
        <div className="grid gap-3 sm:grid-cols-3">
          {rows.map((r) => (
            <Panel key={r.model} className="p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-[family-name:var(--font-bricolage)] text-[15px] font-bold">{r.model}</span>
                <span className="tabular text-[13px] text-muted-ink">{r.ms} ms</span>
              </div>
              <p className="mt-2 text-[14px] leading-relaxed text-navy">{r.ok ? r.text : "failed"}</p>
            </Panel>
          ))}
        </div>
      )}
    </section>
  );
}

export function DemoCache() {
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [country, setCountry] = useState("Latvia");

  async function run() {
    setBusy(true); setRes(null);
    const r = await fetch("/api/cache", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cold: `What is the capital of ${country}?`,
        reworded: `Which city is the capital of ${country}?`,
      }),
    }).then((x) => x.json()).catch(() => null);
    setRes(r); setBusy(false);
  }

  return (
    <section className="flex flex-col gap-4">
      <Header n="Demo 2" title="The semantic cache"
        blurb="Ask it cold, then ask the same thing in different words. A meaning match, not a string match - no tokens, no routing decision, no spend." />
      <div className="flex flex-wrap items-center gap-2">
        <Label>Country</Label>
        <input
          id="cache-country" value={country} onChange={(e) => setCountry(e.target.value)}
          className="w-44 rounded-sm border border-rule bg-transparent px-3 py-2 text-[15px] text-navy outline-none focus-visible:border-navy"
        />
        <Button onClick={run} disabled={busy || !country.trim()}>{busy ? "Asking twice…" : "Ask, then reword"}</Button>
      </div>
      <p className="text-[13px] text-muted-ink">
        Use a country you have not asked today — anything already cached shows no contrast.
      </p>
      {res && (
        <Panel className="p-5">
          <div className="grid gap-5 sm:grid-cols-3">
            <Stat value={`${res.cold?.ms ?? "–"} ms`} label="Cold ask" />
            <Stat value={`${res.reworded?.ms ?? "–"} ms`} label="Reworded" tone={res.hit ? "good" : "ink"} />
            <Stat
              value={res.hit ? Number(res.reworded.similarity).toFixed(3) : "miss"}
              label="Similarity" tone={res.hit ? "red" : "ink"}
            />
          </div>
          <p className="mt-4 border-t border-rule pt-4 text-[14px] text-navy">
            {res.hit
              ? `Different words, same meaning — served from cache, ${res.speedup}x faster.`
              : "No semantic hit. Either this question is already cached from a previous ask, or the semantic cache sidecar is missing."}
          </p>
        </Panel>
      )}
    </section>
  );
}

export function DemoKill({ onChange }: { onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [disabled, setDisabled] = useState<string[]>([]);
  const arms = ["claude-haiku", "claude-sonnet", "nova-lite", "gpt-on-bedrock", "ipr-nova"];

  async function act(action: "disable" | "enable", arm?: string) {
    setBusy(true);
    const r = await fetch("/api/arm", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, arm }),
    }).then((x) => x.json()).catch(() => null);
    setDisabled(r?.disabled ?? []);
    setBusy(false); onChange();
  }

  return (
    <section className="flex flex-col gap-4">
      <Header n="Demo 4" title="Kill the primary"
        blurb="Take out the model taking most of the traffic, then say nothing for thirty seconds and let them watch the error counter refuse to move." />
      <div className="flex flex-wrap gap-2">
        {arms.map((a) => (
          <Button key={a} tone="danger" disabled={busy} onClick={() => act("disable", a)}>Kill {a}</Button>
        ))}
      </div>
      <div><Button tone="quiet" disabled={busy} onClick={() => act("enable")}>Restore everything</Button></div>
      {disabled.length > 0 && (
        <p className="border-l-2 border-brand-red pl-3 text-[14px] text-brand-red">
          Broken out of the circuit: {disabled.join(", ")} — restore before Demo 5.
        </p>
      )}
    </section>
  );
}

export function DemoBudget() {
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true); setRes(null);
    const r = await fetch("/api/budget", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxBudget: 0.0002 }),
    }).then((x) => x.json()).catch(() => null);
    setRes(r); setBusy(false);
  }

  return (
    <section className="flex flex-col gap-4">
      <Header n="Demo 5" title="The budget key"
        blurb="A virtual key with a ceiling of a fraction of a cent, spent live until the gateway refuses it." />
      <div><Button onClick={run} disabled={busy}>{busy ? "Spending it…" : "Mint a $0.0002 key and spend it"}</Button></div>
      {res && (
        <Panel className="p-5">
          <div className="grid gap-5 sm:grid-cols-3">
            <Stat value={res.requests} label="Requests" />
            <Stat value={`${(res.totalMs / 1000).toFixed(1)} s`} label="Time to block" />
            <Stat value={res.blocked ? "Blocked" : "Not blocked"} label="Outcome" tone={res.blocked ? "red" : "ink"} />
          </div>
          <div className="mt-4 border-t border-rule pt-4">
            <p className="text-[14px] text-navy">
              Transport status <b className="tabular">HTTP {res.transportStatus}</b> — the block is in the
              body, not the status code. <b className="text-brand-red">Never call it a 429.</b>
            </p>
            <p className="mt-2 font-mono text-[12.5px] text-muted-ink">
              {res.attempts?.[res.attempts.length - 1]?.detail}
            </p>
          </div>
        </Panel>
      )}
    </section>
  );
}

function Header({ n, title, blurb }: { n: string; title: string; blurb: string }) {
  return (
    <div>
      <Label>{n}</Label>
      <h2 className="mt-1 font-[family-name:var(--font-bricolage)] text-[26px] font-extrabold leading-tight tracking-[-0.01em]">
        {title}
      </h2>
      <p className="mt-2 max-w-[62ch] text-[15px] text-muted-ink">{blurb}</p>
    </div>
  );
}
