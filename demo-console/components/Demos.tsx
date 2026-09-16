"use client";

import { useState } from "react";
import { Panel, Button, Label, Stat } from "./ui";
import { Explain } from "./Explain";
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
      <Explain title="What you are about to see">
        <p>The same question goes to three companies&rsquo; models — Anthropic, Amazon and OpenAI.</p>
        <p>One address, one request, three vendors. The app never knows which one answered.</p>
      </Explain>
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
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [country, setCountry] = useState("Latvia");

  async function run() {
    setBusy(true); setRes(null);
    const r = await fetch(api("/api/cache"), {
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
      <Explain title="What you are about to see">
        <p>We ask a question, then ask <b>the same thing in different words</b>.</p>
        <p>The second one comes back in a fraction of the time — because the gateway recognised
        it <i>means</i> the same thing and reused the first answer.</p>
        <p>No model was called. Nothing was billed. Watch the two numbers underneath.</p>
      </Explain>
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

          <div className="mt-4 grid gap-5 border-t border-rule pt-4 sm:grid-cols-2">
            <div className="flex flex-col gap-3">
              <Asked text={`What is the capital of ${country}?`} />
              <Answer text={res.cold?.text ?? ""} by={res.cold?.servedBy} />
            </div>
            <div className="flex flex-col gap-3">
              <Asked text={`Which city is the capital of ${country}?`} />
              <Answer text={res.reworded?.text ?? ""} by={res.reworded?.servedBy} />
            </div>
          </div>
          {res.hit && (
            <p className="mt-3 text-[14px] text-navy">
              <b>The two answers are identical</b> — word for word. That is not two models
              agreeing; it is the same answer, handed back without asking anyone.
            </p>
          )}
          {res.hit && (
            <div className="mt-3 rounded-sm bg-warm-gray px-4 py-3">
              <p className="text-[14px] text-navy">
                Billed for that answer:{" "}
                <b className="text-good">${(res.spentUsd ?? 0).toFixed(8)}</b> and{" "}
                <b className="text-good">{res.tokens ?? 0} tokens</b>. No model was called.
              </p>
              {res.headerCost && (
                <p className="mt-1.5 text-[13px] text-muted-ink">
                  The response header says <span className="font-mono">{res.headerCost}</span> — ignore it.
                  LiteLLM replays the cached answer complete with the original usage, so a hit
                  looks billed. The gateway&rsquo;s own counters are the ones that moved, and they didn&rsquo;t.
                </p>
              )}
            </div>
          )}
        </Panel>
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
        blurb="Ask twelve questions, switch a model off mid-flight, ask twelve more. Watch where the answers come from - and watch the failure count." />
      <Explain title="What you are about to see">
        <p>Twelve questions go out. Then we switch a model off. Then twelve more go out.</p>
        <p>The answers simply come from somewhere else — and <b>nothing fails</b>. Nobody using
        the app would notice anything happened.</p>
      </Explain>

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
      <Explain title="What you are about to see">
        <p>We create an API key with a spending limit of two hundredths of a cent, then spend it.</p>
        <p>After a handful of questions the gateway simply refuses it. That is a budget being
        enforced, not an outage — and it is per key, so one team cannot spend another&rsquo;s money.</p>
      </Explain>
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
