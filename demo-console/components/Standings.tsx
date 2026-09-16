"use client";

import { useCallback, useEffect, useState } from "react";
import { Explain } from "./Explain";
import { api } from "@/lib/base";

type Arm = { model: string; mean: number; observations: number; share: number; requests: number; cost_usd: number };

/** Demo 3 - what the router believes, as a bar per model.
 *
 *  The projector shows the same thing as probability curves; this is the
 *  speaker's copy, in numbers, so a question can be answered without turning
 *  round to read the screen behind them.
 */
export function Standings() {
  const [arms, setArms] = useState<Arm[]>([]);
  const [total, setTotal] = useState(0);

  const load = useCallback(async () => {
    const r = await fetch(api("/api/state"), { cache: "no-store" }).then((x) => x.json()).catch(() => null);
    if (r?.state?.arms) { setArms(r.state.arms); setTotal(r.state.total_requests ?? 0); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [load]);

  const ranked = [...arms].sort((a, b) => b.mean - a.mean);
  const graded = arms.reduce((s, a) => s + a.observations, 0);

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="font-[family-name:var(--font-bricolage)] text-[26px] font-extrabold leading-tight tracking-[-0.01em]">
          What the router believes
        </h2>
        <p className="mt-2 max-w-[62ch] text-[15px] text-muted-ink">
          Built from {graded.toLocaleString()} graded answers across {total.toLocaleString()} questions.
          The big curves on the projector are this same data.
        </p>
      </div>

      <Explain title="What you are about to see">
        <p>Each bar is one model&rsquo;s score: how often its answers come back good enough.</p>
        <p>Nobody set these. They are only what happened — and they keep moving.</p>
      </Explain>

      <div className="rounded-sm border border-rule bg-panel p-5">
        {ranked.length === 0 && <p className="text-[15px] text-muted-ink">No answers graded yet.</p>}
        {ranked.map((a, i) => (
          <div key={a.model} className="border-b border-rule py-3 last:border-b-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-[family-name:var(--font-bricolage)] text-[15px] font-bold">
                {a.model}
              </span>
              <span className="tabular text-[15px] font-bold">{a.mean.toFixed(2)}</span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-[2px] bg-warm-gray">
              <div
                className={i === 0 ? "h-full bg-brand-red" : "h-full bg-navy"}
                style={{ width: `${Math.max(2, a.mean * 100)}%`, transition: "width 600ms ease-out" }}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-[12.5px] text-muted-ink">
              <span>{a.observations} answers graded</span>
              <span className="tabular">{Math.round(a.share * 100)}% of traffic</span>
            </div>
          </div>
        ))}
      </div>

      <p className="text-[14px] text-muted-ink">
        The top bar is not always the one taking the most traffic — price is the other half of the
        decision.
      </p>
    </section>
  );
}
