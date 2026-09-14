"use client";

import { useEffect, useRef, useState } from "react";
import { Payload, ConnStatus } from "@/lib/types";
import { BetaCurves } from "./beta-curves";
import { TrafficSplit } from "./traffic-split";
import { SavingsCounter, ErrorCounter } from "./counters";

/**
 * The live data path.
 *
 * Amplify Hosting runs Next.js on its compute provider but Next.js streaming is
 * on its unsupported features list, so this EventSource is opened straight
 * against the FastAPI data plane on ECS through the ALB. Nothing live ever goes
 * through a Next.js API route.
 */
const DATA_PLANE =
  process.env.NEXT_PUBLIC_DATA_PLANE_URL?.replace(/\/$/, "") ??
  "http://localhost:8080";

export function Dashboard() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      esRef.current?.close();

      const es = new EventSource(`${DATA_PLANE}/stream`);
      esRef.current = es;

      es.addEventListener("update", (e) => {
        try {
          setPayload(JSON.parse((e as MessageEvent).data));
          setStatus("live");
          retryRef.current = 0;
        } catch {
          /* a malformed frame must not tear the stream down */
        }
      });

      es.onopen = () => {
        setStatus("live");
        retryRef.current = 0;
      };

      es.onerror = () => {
        // A frozen dashboard with no indication is the failure mode that
        // actually hurts on stage. Say so, then recover without a reload.
        setStatus("reconnecting");
        es.close();
        const delay = Math.min(1000 * 2 ** retryRef.current, 10000);
        retryRef.current += 1;
        timerRef.current = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      esRef.current?.close();
    };
  }, []);

  const state = payload?.state;
  const spend = payload?.spend;

  return (
    <main className="min-h-screen px-8 py-6">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <h1 className="font-display text-4xl font-extrabold text-navy">
            Adaptive LLM Gateway
          </h1>
          <span className="text-xl text-muted-ink">
            {state ? `${state.total_requests} requests` : "-"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xl text-muted-ink">
          {state && (
            <>
              <span className="tabular">gamma {state.gamma.toFixed(2)}</span>
              <span className="uppercase tracking-wide">{state.mode}</span>
              {state.shadow && (
                <span className="bg-navy px-3 py-1 text-on-dark">shadow</span>
              )}
            </>
          )}
          <span className="flex items-center gap-2">
            <span
              className={`inline-block h-3 w-3 rounded-full ${
                status === "live" ? "live-dot" : ""
              }`}
              style={{
                background: status === "live" ? "#E51F40" : "#5F606D",
              }}
            />
            {status}
          </span>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <section className="lg:col-span-2 border border-[#EFEAE6] bg-white p-6">
          <h2 className="mb-1 font-display text-3xl font-bold text-navy">
            What the router believes
          </h2>
          <p className="mb-2 text-xl text-muted-ink">
            probability each model returns a good-enough answer
          </p>
          {state ? (
            <BetaCurves arms={state.arms} leader={state.leader} />
          ) : (
            <div className="h-[360px]" />
          )}
        </section>

        <div className="flex min-w-0 flex-col gap-5">
          <section className="min-w-0 flex-1 border border-[#EFEAE6] bg-white p-6">
            {spend ? (
              <SavingsCounter spend={spend} />
            ) : (
              <div className="h-48" />
            )}
          </section>
          <section className="border border-[#EFEAE6]">
            <ErrorCounter errors={state?.errors ?? 0} />
          </section>
        </div>
      </div>

      <section className="mt-5 border border-[#EFEAE6] bg-white p-6">
        <h2 className="mb-4 font-display text-3xl font-bold text-navy">
          Traffic split
        </h2>
        {state ? (
          <TrafficSplit arms={state.arms} leader={state.leader} />
        ) : (
          <div className="h-16" />
        )}
      </section>
    </main>
  );
}
