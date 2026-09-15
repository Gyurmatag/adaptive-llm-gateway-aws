"use client";

import { Arm } from "@/lib/types";
import { colorFor, shortName } from "@/lib/brand";

/**
 * Panel 2: rolling traffic split.
 *
 * Same colour assignment as the curves, and segments keep their order so a
 * model that loses traffic keeps its position and its colour rather than
 * being reshuffled by size.
 */
export function TrafficSplit({
  arms,
  leader,
}: {
  arms: Arm[];
  leader: string | null;
}) {
  const total = arms.reduce((s, a) => s + a.requests, 0);
  if (!total) {
    return <div className="py-8 text-2xl text-muted-ink">no traffic yet</div>;
  }

  return (
    <div>
      <div className="flex h-16 w-full overflow-hidden rounded-[2px]">
        {arms.map((a) => {
          const pct = (a.requests / total) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={a.model}
              style={{
                width: `${pct}%`,
                background: colorFor(a.model, leader),
                transition: "width 500ms ease-out, background 400ms ease-out",
              }}
              title={`${a.model} ${pct.toFixed(1)}%`}
            />
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2">
        {arms
          .filter((a) => a.requests > 0)
          .map((a) => (
            <div key={a.model} className="flex items-baseline gap-2">
              <span
                className="inline-block h-4 w-4 shrink-0"
                style={{ background: colorFor(a.model, leader) }}
              />
              <span className="font-display text-2xl font-bold tabular">
                {((a.requests / total) * 100).toFixed(0)}%
              </span>
              <span
                className={
                  a.disabled
                    ? "text-xl text-muted-ink line-through decoration-2"
                    : "text-xl text-muted-ink"
                }
              >
                {shortName(a.model)}
              </span>
              {/* A withheld arm must never read as merely quiet. It keeps its
                  colour and position so the eye tracks it, and says why it
                  stopped. */}
              {a.disabled && (
                <span className="rounded-[2px] border border-current px-2 py-0.5 font-display text-base font-bold uppercase tracking-wide text-brand-red">
                  off
                </span>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
