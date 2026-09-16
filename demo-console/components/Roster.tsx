"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/base";

type ClassScores = Record<string, { mean: number; observations: number }>;
type Arm = { model: string; mean: number; observations: number; share: number; cost_usd: number; requests: number; disabled: boolean; withheld: boolean };

const VENDOR: Record<string, string> = {
  "claude-sonnet": "Anthropic",
  "claude-haiku": "Anthropic",
  "nova-lite": "Amazon",
  "gpt-on-bedrock": "OpenAI",
  "ipr-nova": "Amazon",
};

const NICE_CLASS: Record<string, string> = {
  code: "code",
  factual: "facts",
  reasoning: "reasoning",
  summarization: "summarising",
};

/** The models in play, and what each one has turned out to be good at.
 *
 *  This is the first thing on the screen because it is the first question
 *  anyone has: which models am I looking at, and why would I pick one?
 */
export function Roster() {
  const [arms, setArms] = useState<Arm[]>([]);
  const [perClass, setPerClass] = useState<Record<string, ClassScores>>({});

  const load = useCallback(async () => {
    const [s, g] = await Promise.all([
      fetch(api("/api/state"), { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch(api("/api/guardrails"), { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    ]);
    if (s?.state?.arms) setArms(s.state.arms);
    if (g?.guardrails?.per_class) setPerClass(g.guardrails.per_class);
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  /** What this model is good at *compared with the others*.
   *
   *  Its own highest-scoring class is almost useless: everything scores ~0.98
   *  on easy factual questions, so four cards out of five said "best at facts"
   *  and the row told the audience nothing. What is worth saying is where a
   *  model beats the rest of the field.
   */
  function strengthOf(model: string): { text: string; score: number; top: boolean } | null {
    let best: { text: string; score: number; top: boolean } | null = null;
    for (const [tc, scores] of Object.entries(perClass)) {
      if (tc === "_all") continue;
      const here = scores[model];
      // Fewer than five graded answers is noise, not a strength.
      if (!here || here.observations < 5) continue;
      const field = Object.entries(scores).filter(([, v]) => v.observations >= 5);
      if (field.length < 2) continue;
      const ranked = field.sort((a, b) => b[1].mean - a[1].mean);
      const rank = ranked.findIndex(([n]) => n === model);
      const label = NICE_CLASS[tc] ?? tc;
      if (rank === 0) {
        // Outright best in the field at this kind of question.
        if (!best || !best.top || here.mean > best.score) {
          best = { text: `best at ${label}`, score: here.mean, top: true };
        }
      } else if (!best) {
        best = { text: `strongest at ${label}`, score: here.mean, top: false };
      }
    }
    return best;
  }

  if (arms.length === 0) {
    return (
      <div className="rounded-sm border border-rule bg-panel px-5 py-4 text-[15px] text-muted-ink">
        Waiting for the first answers…
      </div>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      {arms.map((a) => {
        const strength = strengthOf(a.model);
        const perK = a.requests ? (a.cost_usd / a.requests) * 1000 : 0;
        const off = a.disabled || a.withheld;
        return (
          <div
            key={a.model}
            className={`rounded-sm border px-4 py-3 ${off ? "border-brand-red/40 bg-panel opacity-60" : "border-rule bg-panel"}`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className={`font-[family-name:var(--font-bricolage)] text-[15px] font-bold leading-tight ${off ? "line-through" : ""}`}>
                {a.model}
              </span>
              {off && (
                <span className="rounded-[2px] border border-brand-red px-1.5 text-[10px] font-bold uppercase text-brand-red">
                  off
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[12px] uppercase tracking-[0.08em] text-muted-ink">
              {VENDOR[a.model] ?? "—"}
            </div>

            <div className="mt-3 text-[13.5px] leading-snug">
              {strength ? (
                <>
                  <b className={strength.top ? "text-navy" : "text-muted-ink"}>{strength.text}</b>{" "}
                  <span className={`tabular ${strength.top ? "text-good" : "text-muted-ink"}`}>
                    {strength.score.toFixed(2)}
                  </span>
                </>
              ) : (
                <span className="text-muted-ink">still being tried</span>
              )}
            </div>

            <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-rule pt-2 text-[12.5px] text-muted-ink">
              <span className="tabular">${perK.toFixed(2)}/1k</span>
              <span className="tabular">{Math.round(a.share * 100)}% of traffic</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
