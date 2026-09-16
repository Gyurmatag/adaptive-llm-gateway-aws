"use client";

import { useState } from "react";
import { Panel, Button, Label, Stat } from "./ui";
import { api } from "@/lib/base";

type Fan = { model: string; ok: boolean; ms: number; text: string; servedBy: string | null };

/** What was asked. Shown verbatim, because "trust me, I asked something" is
 *  not a demo. */
function Asked({ text }: { text: string }) {
  return (
    <div>
      <Label>Asked</Label>
      <p className="mt-1.5 rounded-sm border border-rule bg-warm-gray px-4 py-2.5 font-mono text-[13px] text-navy">
        {text}
      </p>
    </div>
  );
}

/** What came back. */
function Answer({ text, by }: { text: string; by?: string | null }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <Label>Answer</Label>
        {by && <span className="font-mono text-[11.5px] text-muted-ink">from {by}</span>}
      </div>
      <p className="mt-1.5 rounded-sm border border-rule px-4 py-2.5 text-[14px] leading-relaxed text-navy">
        {text || "—"}
      </p>
    </div>
  );
}

export function DemoFanout() {
  const [rows, setRows] = useState<Fan[] | null>(null);
  const [busy, setBusy] = useState(false);
  const prompt = "What is the capital of Hungary? Answer in one short sentence.";

  async function run() {
    setBusy(true); setRows(null);
    const r = await fetch(api("/api/fanout"), {
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
              {r.servedBy && (
                <p className="mt-2 border-t border-rule pt-2 font-mono text-[11.5px] text-muted-ink">
                  served by {r.servedBy}
                </p>
              )}
            </Panel>
          ))}
        </div>
      )}
    </section>
  );
}

export function DemoCache() {
  const [input, setInput] = useState("What is the capital of Latvia?");
  const [asks, setAsks] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  async function ask(e?: React.FormEvent) {
    e?.preventDefault();
    const q = input.trim();
    if (!q || busy) return;
    setBusy(true);
    const r = await fetch(api("/api/ask"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: q }),
    }).then((x) => x.json()).catch(() => null);
    if (r) setAsks((prev) => [...prev, r]);
    setBusy(false);
    setInput("");
  }

  const first = asks[0];
  const hit = asks.find((a) => a.cached);

  return (
    <section className="flex flex-col gap-4">
      <Header n="Demo 2" title="The semantic cache"
        blurb="Ask something. Then ask the same thing in different words." />

      <form onSubmit={ask} className="flex flex-wrap gap-2">
        <input
          id="cache-q" value={input} onChange={(e) => setInput(e.target.value)}
          placeholder={asks.length ? "Now ask the same thing in different words…" : "Ask anything…"}
          autoFocus
          className="min-w-0 flex-1 rounded-sm border border-rule bg-transparent px-4 py-2.5 text-[15px] text-navy outline-none placeholder:text-muted-ink focus-visible:border-navy"
        />
        <Button type="submit" disabled={busy || !input.trim()}>
          {busy ? "Asking…" : asks.length ? "Ask again" : "Ask"}
        </Button>
        {asks.length > 0 && (
          <Button tone="quiet" disabled={busy} onClick={() => setAsks([])}>Clear</Button>
        )}
      </form>

      {asks.length === 1 && !busy && (
        <p className="text-[14px] text-muted-ink">
          Now reword it — same meaning, different words — and ask again.
        </p>
      )}

      {asks.map((a, i) => (
        <Panel key={i} className="p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <p className="font-mono text-[13.5px] text-navy">{a.prompt}</p>
            <span className={`rounded-[2px] px-2 py-0.5 font-mono text-[11px] font-bold uppercase ${
              a.cached ? "bg-good/15 text-good" : "border border-rule text-muted-ink"}`}>
              {a.cached ? "from cache" : "asked a model"}
            </span>
          </div>

          <div className="mt-4 flex flex-wrap gap-x-10 gap-y-4">
            <Stat value={`${a.ms} ms`} label="Time" tone={a.cached ? "good" : "ink"} />
            <Stat value={a.model ?? "—"} label="Answered by" />
            <Stat value={a.totalTokens ?? "—"} label="Tokens in the reply" />
            <Stat value={`$${Number(a.billedUsd ?? 0).toFixed(8)}`} label="Actually billed"
                  tone={Number(a.billedUsd ?? 0) === 0 ? "good" : "red"} />
            <Stat value={a.billedTokens ?? "—"} label="Tokens billed"
                  tone={a.billedTokens === 0 ? "good" : "ink"} />
            {a.cached && <Stat value={Number(a.similarity).toFixed(3)} label="Similarity" tone="red" />}
          </div>

          <p className="mt-4 border-t border-rule pt-3 text-[14px] leading-relaxed text-navy">
            {a.ok ? a.text : "failed"}
          </p>

          {a.cached && a.headerCostUsd && (
            <p className="mt-3 text-[12.5px] text-muted-ink">
              The response header claims <span className="font-mono">{a.headerCostUsd}</span>. Ignore
              it — LiteLLM replays the cached answer with its original usage attached. The
              gateway&rsquo;s own counters are what moved, and they didn&rsquo;t.
            </p>
          )}
        </Panel>
      ))}

      {first && hit && (
        <p className="text-[15px] text-navy">
          <b>{(first.ms / Math.max(hit.ms, 1)).toFixed(1)}x faster</b>, {hit.billedTokens ?? 0} tokens
          and ${Number(hit.billedUsd ?? 0).toFixed(8)} billed — different words, same meaning, same
          answer handed straight back.
        </p>
      )}
    </section>
  );
}

export function DemoKill({ onChange }: { onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [arm, setArm] = useState("claude-haiku");
  const arms = ["claude-haiku", "claude-sonnet", "nova-lite", "gpt-on-bedrock", "ipr-nova"];

  async function drill() {
    setBusy(true); setRes(null);
    const r = await fetch(api("/api/failover"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arm }),
    }).then((x) => x.json()).catch(() => null);
    setRes(r); setBusy(false); onChange();
  }

  async function restore() {
    setBusy(true);
    await fetch(api("/api/failover"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore" }),
    }).catch(() => null);
    setRes(null); setBusy(false); onChange();
  }

  return (
    <section className="flex flex-col gap-4">
      <Header n="Demo 4" title="Kill the primary"
        blurb="Twelve questions, switch a model off mid-flight, twelve more. The answers come from somewhere else and nothing fails." />
      <div className="flex flex-wrap items-center gap-2">
        <Label>Switch off</Label>
        <div className="flex flex-wrap gap-1.5">
          {arms.map((a) => (
            <button key={a} type="button" onClick={() => setArm(a)}
              className={`rounded-sm border px-3 py-1.5 text-[13px] font-semibold transition-colors ${
                arm === a ? "border-navy bg-navy text-canvas" : "border-rule text-muted-ink hover:text-navy"}`}>
              {a}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button tone="danger" disabled={busy} onClick={drill}>
          {busy ? "Running the drill…" : `Run it — 12 questions, kill ${arm}, 12 more`}
        </Button>
        <Button tone="quiet" disabled={busy} onClick={restore}>Restore everything</Button>
      </div>

      {res && (
        <Panel className="p-5">
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <Label>Before — who answered</Label>
              <ul className="mt-2 space-y-1">
                {res.before?.map(([m, n]: [string, number]) => (
                  <li key={m} className="flex justify-between text-[14px]">
                    <span className={m === res.arm ? "font-bold text-navy" : "text-muted-ink"}>{m}</span>
                    <span className="tabular text-muted-ink">{n}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <Label>After — who answered</Label>
              <ul className="mt-2 space-y-1">
                {res.after?.map(([m, n]: [string, number]) => (
                  <li key={m} className="flex justify-between text-[14px]">
                    <span className="text-muted-ink">{m}</span>
                    <span className="tabular text-muted-ink">{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {res.prompt && (
            <div className="mt-5 border-t border-rule pt-4">
              <Asked text={res.prompt} />
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                {res.beforeSample && <Answer text={res.beforeSample.text} by={`${res.beforeSample.model} · before`} />}
                {res.afterSample && <Answer text={res.afterSample.text} by={`${res.afterSample.model} · after`} />}
              </div>
            </div>
          )}
          <div className="mt-5 flex flex-wrap items-baseline gap-x-8 gap-y-2 border-t border-rule pt-4">
            <Stat value={res.failed} label="Failed answers" tone={res.failed === 0 ? "good" : "red"} />
            <p className="text-[15px] text-navy">
              {res.stillServing
                ? `${res.arm} is still answering — give the breaker a moment and run it again.`
                : `${res.arm} answered ${res.before?.find(([m]: [string, number]) => m === res.arm)?.[1] ?? 0} of the first twelve and none of the last twelve.`}
            </p>
          </div>
          <p className="mt-3 text-[14px] text-muted-ink">
            Click <b>Restore everything</b> before the next demo.
          </p>
        </Panel>
      )}
    </section>
  );
}

export function DemoBudget() {
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true); setRes(null);
    const r = await fetch(api("/api/budget"), {
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
          {res.prompt && (
            <div className="mt-5 flex flex-col gap-3 border-t border-rule pt-4">
              <Asked text={res.prompt} />
              {res.sample && <Answer text={res.sample} by="while the key still had budget" />}
            </div>
          )}
          <div className="mt-4 border-t border-rule pt-4">
            <p className="text-[14px] text-navy">
              Then the same question, once the money ran out:
            </p>
            <p className="mt-2 rounded-sm border border-brand-red/40 px-4 py-2.5 font-mono text-[12.5px] text-brand-red">
              {res.attempts?.[res.attempts.length - 1]?.detail}
            </p>
            <p className="mt-3 text-[14px] text-navy">
              Transport status <b className="tabular">HTTP {res.transportStatus}</b> — the refusal is in
              the body, not the status code. <b className="text-brand-red">Never call it a 429.</b>
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
