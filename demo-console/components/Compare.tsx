"use client";

import { useState } from "react";
import { Panel, Button, Label, Stat } from "./ui";
import { Explain } from "./Explain";
import { api } from "@/lib/base";

const PRESETS = [
  "Write a Python function that reverses a list.",
  "Why do databases use B-trees? Explain briefly.",
  "Summarise what a database index is, in one line.",
  "What is the capital of Hungary?",
];

/** Two adaptive routers, same question.
 *
 *  The comparison the talk needs: ours adapts to THIS traffic, OpenRouter's
 *  adapts to THE MARKET. Not a winner, a distinction.
 */
export function Compare() {
  const [prompt, setPrompt] = useState(PRESETS[0]);
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true); setRes(null);
    const r = await fetch(api("/api/compare"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }).then((x) => x.json()).catch(() => null);
    setRes(r); setBusy(false);
  }

  return (
    <section className="flex flex-col gap-4">
      <div>
        <Label>Head to head</Label>
        <h2 className="mt-1 font-[family-name:var(--font-bricolage)] text-[26px] font-extrabold leading-tight tracking-[-0.01em]">
          Ours, and the one you can buy
        </h2>
      </div>

      <Explain title="They are not the same kind of adaptive">
        <p><b>OpenRouter&rsquo;s Auto Router adapts to the market.</b> It works out what kind of
        question you asked, then picks whatever the community spent the most money on for that
        kind of question in the last seven days.</p>
        <p><b>Ours adapts to you.</b> A grader scores <i>our</i> answers to <i>our</i> traffic,
        and that moves the choice.</p>
        <p>Both are legitimate. The crowd&rsquo;s favourite is a good guess; it is not a
        measurement of whether the answer worked for your users.</p>
      </Explain>

      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button key={p} type="button" onClick={() => setPrompt(p)}
            className={`rounded-sm border px-3 py-1.5 text-left text-[13px] transition-colors ${
              prompt === p ? "border-navy bg-navy text-canvas" : "border-rule text-muted-ink hover:text-navy"}`}>
            {p.length > 42 ? p.slice(0, 40) + "…" : p}
          </button>
        ))}
      </div>

      <input
        id="compare-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)}
        className="w-full rounded-sm border border-rule bg-transparent px-3 py-2.5 text-[15px] text-navy outline-none focus-visible:border-navy"
      />
      <div>
        <Button onClick={run} disabled={busy || !prompt.trim()}>
          {busy ? "Asking both…" : "Ask both routers the same question"}
        </Button>
      </div>

      {res && !res.configured && (
        <p className="border-l-2 border-brand-red pl-3 text-[14px] text-brand-red">
          No OpenRouter key configured on this deployment.
        </p>
      )}

      {res && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Side
            title="This gateway" sub="adapts to your traffic"
            model={res.mine?.model} ms={res.mine?.ms} cost={res.mine?.costUsd}
            text={res.mine?.text} ok={res.mine?.ok} extra={null}
          />
          <Side
            title="OpenRouter Auto" sub="adapts to the market"
            model={res.theirs?.model} ms={res.theirs?.ms} cost={res.theirs?.costUsd}
            text={res.theirs?.text} ok={res.theirs?.ok}
            extra={res.theirs?.ok
              ? `${res.theirs.provider ? `served by ${res.theirs.provider}` : ""}${
                  res.theirs.endpointsAvailable ? ` · chose from ${typeof res.theirs.endpointsAvailable === "number" ? res.theirs.endpointsAvailable : res.theirs.endpointsAvailable}` : ""}`
              : res.theirs?.error ?? null}
          />
        </div>
      )}

      <Panel className="p-5">
        <h3 className="font-[family-name:var(--font-bricolage)] text-[17px] font-bold">
          And the one AWS gives you for free
        </h3>
        <p className="mt-2 max-w-[62ch] text-[14.5px] text-muted-ink">
          Bedrock&rsquo;s own prompt routers are in this demo too — <b>ipr-nova</b> is one of the
          five models. Asked what they can choose between, straight from the API:
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[460px] text-[13.5px]">
            <thead>
              <tr className="text-left font-mono text-[10px] uppercase tracking-[0.1em] text-muted-ink">
                <th className="py-1 pr-4">Router</th><th className="py-1">Models it may pick from</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-rule">
                <td className="py-2 pr-4 font-mono">AWS Nova</td>
                <td className="py-2">nova-lite, nova-pro <span className="text-muted-ink">— two</span></td>
              </tr>
              <tr className="border-t border-rule">
                <td className="py-2 pr-4 font-mono">AWS Anthropic</td>
                <td className="py-2">
                  claude-3-haiku <span className="text-muted-ink">(Mar 2024)</span>, claude-3-5-sonnet{" "}
                  <span className="text-muted-ink">(Jun 2024)</span> <span className="text-brand-red">— two, and old</span>
                </td>
              </tr>
              <tr className="border-t border-rule">
                <td className="py-2 pr-4 font-mono">OpenRouter Auto</td>
                <td className="py-2"><b>58 of 63 endpoints</b>, re-ranked every week</td>
              </tr>
              <tr className="border-t border-rule">
                <td className="py-2 pr-4 font-mono">This gateway</td>
                <td className="py-2">the five above, and whatever you add to a config file</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>
    </section>
  );
}

function Side({ title, sub, model, ms, cost, text, ok, extra }: {
  title: string; sub: string; model?: string | null; ms?: number;
  cost?: number | null; text?: string; ok?: boolean; extra?: string | null;
}) {
  return (
    <Panel className="flex flex-col p-5">
      <div>
        <h3 className="font-[family-name:var(--font-bricolage)] text-[17px] font-bold">{title}</h3>
        <p className="text-[13px] text-muted-ink">{sub}</p>
      </div>
      <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
        <Stat value={model ?? "—"} label="Picked" />
        <Stat value={ms ? `${ms} ms` : "—"} label="Took" />
        <Stat value={cost != null ? `$${cost.toFixed(6)}` : "—"} label="Cost" tone="red" />
      </div>
      {extra && <p className="mt-3 text-[13px] text-muted-ink">{extra}</p>}
      <p className="mt-4 border-t border-rule pt-3 text-[14px] leading-relaxed text-navy">
        {ok ? (text || "—") : "failed"}
      </p>
    </Panel>
  );
}
