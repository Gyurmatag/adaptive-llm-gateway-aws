"use client";

import { useCallback, useEffect, useState } from "react";
import { Curves, TrafficSplit } from "./Curves";
import { Explain } from "./Explain";
import { Stat, Button } from "./ui";
import { api } from "@/lib/base";

/** Demo 3 - the curves, the split and the money, on the same URL as everything
 *  else. This used to live on a separate dashboard; one link is one less thing
 *  to get wrong on stage. */
export function Standings() {
  const [state, setState] = useState<any>(null);
  const [spend, setSpend] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(api("/api/state"), { cache: "no-store" }).then((x) => x.json()).catch(() => null);
    if (r?.state) { setState(r.state); setSpend(r.spend); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 2000); return () => clearInterval(t); }, [load]);

  const arms = state?.arms ?? [];
  const graded = arms.reduce((s: number, a: any) => s + a.observations, 0);
  const thin = graded < 25;

  // Nothing runs in the background, so the evidence only exists because
  // somebody asked for it. This is that ask.
  async function warmUp() {
    setBusy(true);
    await fetch(api("/api/warmup"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rounds: 6 }),
    }).catch(() => null);
    setBusy(false); load();
  }

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h2 className="font-[family-name:var(--font-bricolage)] text-[26px] font-extrabold leading-tight tracking-[-0.01em]">
          What the router believes
        </h2>
        <p className="mt-2 max-w-[62ch] text-[15px] text-muted-ink">
          How likely each model is to give a good-enough answer — built from{" "}
          {graded.toLocaleString()} graded answers.
        </p>
      </div>

      <Explain title="Reading this chart">
        <p>Further <b>right</b> means better answers. <b>Narrower</b> means the gateway is more
        sure about it.</p>
        <p>A wide, flat curve means it has not made its mind up yet — so it keeps trying that
        model until it has.</p>
      </Explain>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={warmUp} disabled={busy}>
          {busy ? "Asking 48 questions…" : thin ? "Ask 48 questions to build the picture" : "Ask 48 more"}
        </Button>
        {thin && (
          <span className="text-[13.5px] text-muted-ink">
            {graded === 0
              ? "Nothing has been asked yet — the curves are built from real answers."
              : `Only ${graded} answers graded so far. A curve needs a handful before it means anything.`}
          </span>
        )}
      </div>

      <div className="rounded-sm border border-rule bg-panel p-4">
        <Curves arms={arms} leader={state?.leader ?? null} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="rounded-sm border border-rule bg-panel p-5">
          <h3 className="font-[family-name:var(--font-bricolage)] text-[17px] font-bold">
            Where the questions actually went
          </h3>
          <div className="mt-4">
            <TrafficSplit arms={arms} leader={state?.leader ?? null} />
          </div>
        </div>
        <div className="rounded-sm border border-rule bg-panel p-5">
          <div className="flex flex-col gap-5">
            <Stat value={spend ? `$${spend.saved_usd.toFixed(2)}` : "–"} label="Saved" tone="red" />
            <Stat value={spend ? `${spend.saved_pct.toFixed(0)}%` : "–"} label="Cheaper than always-biggest" />
            <Stat value={state ? state.errors : "–"} label="Failed answers"
                  tone={state && state.errors === 0 ? "good" : "red"} />
          </div>
        </div>
      </div>

      <p className="text-[14px] text-muted-ink">
        The rightmost curve is not always the one taking the most traffic — price is the other
        half of the decision.
      </p>
    </section>
  );
}
