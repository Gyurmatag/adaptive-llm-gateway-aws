"use client";

import { Spend } from "@/lib/types";

/**
 * Panel 3: counterfactual savings.
 *
 * What the same token volume would have cost routed entirely to the most
 * expensive model, minus actual spend. The largest single element on screen.
 *
 * Sized with clamp() against the viewport rather than a fixed rem value: at a
 * fixed size the number overflows its column on a narrow projector and on a
 * phone, and a clipped headline number is worse than a smaller one.
 */
export function SavingsCounter({ spend }: { spend: Spend }) {
  return (
    <div className="flex h-full min-w-0 flex-col justify-center">
      <div
        className="counter font-display font-extrabold leading-none text-brand-red"
        style={{ fontSize: "clamp(3rem, 7.5vw, 7.5rem)" }}
      >
        ${spend.saved_usd.toFixed(2)}
      </div>
      <div className="mt-3 text-xl leading-snug text-muted-ink xl:text-2xl">
        saved vs routing everything to the most expensive model
      </div>
      <div className="mt-5 flex flex-wrap gap-x-8 gap-y-3">
        <Stat label="actual" value={`$${spend.actual_usd.toFixed(2)}`} />
        <Stat label="counterfactual" value={`$${spend.counterfactual_usd.toFixed(2)}`} />
        <Stat label="saved" value={`${spend.saved_pct.toFixed(0)}%`} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="font-display text-2xl font-bold tabular text-navy xl:text-3xl">
        {value}
      </div>
      <div className="text-base text-muted-ink xl:text-lg">{label}</div>
    </div>
  );
}

/**
 * The error counter.
 *
 * It must stay at zero through Demo 4 and that zero is the entire point of the
 * failover beat, so it is large, central to its panel, and never tucked into a
 * corner where nobody can find it under pressure.
 */
export function ErrorCounter({ errors }: { errors: number }) {
  const bad = errors > 0;
  return (
    <div
      className="flex flex-col items-center justify-center px-6 py-8"
      style={{ background: bad ? "#E51F40" : "#0E1126" }}
    >
      <div
        className="counter font-display font-extrabold leading-none"
        style={{ color: "#FFFFFF", fontSize: "clamp(3rem, 6vw, 6rem)" }}
      >
        {errors}
      </div>
      <div
        className="mt-2 text-center text-xl xl:text-2xl"
        style={{ color: bad ? "#FFFFFF" : "#9A9AA5" }}
      >
        errors across failover
      </div>
    </div>
  );
}
