"use client";

import { Arm } from "@/lib/types";
import { colorFor, shortName } from "@/lib/brand";

/**
 * Panel 1: the "it is learning" evidence.
 *
 * One Beta density per routed model, redrawn live. A narrow curve means the
 * router is confident, and that has to be visible without explanation.
 *
 * This panel carries Demo 3 and has to survive the moment in Demo 4 when the
 * curves re-sort, so the redraw is a CSS transition on the path rather than a
 * remount - the re-sort reads as motion instead of as a flicker.
 */
export function BetaCurves({
  arms,
  leader,
}: {
  arms: Arm[];
  leader: string | null;
}) {
  const W = 1000;
  const H = 360;
  const PAD = { top: 28, right: 28, bottom: 44, left: 28 };

  const drawable = arms.filter((a) => a.curve?.length > 1);
  if (!drawable.length) {
    return (
      <div className="flex h-[360px] items-center justify-center text-2xl text-muted-ink">
        waiting for traffic...
      </div>
    );
  }

  // Shared x-window across all arms so the curves are directly comparable.
  // Each arm's own curve is sampled around its own mean, so without this the
  // panel would silently lie about separation.
  const xs = drawable.flatMap((a) => [a.curve[0][0], a.curve[a.curve.length - 1][0]]);
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  const span = Math.max(x1 - x0, 0.02);
  x0 = Math.max(0, x0 - span * 0.08);
  x1 = Math.min(1, x1 + span * 0.08);

  const yMax = Math.max(...drawable.flatMap((a) => a.curve.map((p) => p[1])), 1);

  const sx = (x: number) =>
    PAD.left + ((x - x0) / (x1 - x0)) * (W - PAD.left - PAD.right);
  const sy = (y: number) =>
    H - PAD.bottom - (y / yMax) * (H - PAD.top - PAD.bottom);

  let labelRow = new Map<string, number>();

  const ticks = 5;
  const tickVals = Array.from(
    { length: ticks },
    (_, i) => x0 + ((x1 - x0) * i) / (ticks - 1),
  );

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label="Beta posterior density per model"
    >
      {/* baseline */}
      <line
        x1={PAD.left}
        y1={H - PAD.bottom}
        x2={W - PAD.right}
        y2={H - PAD.bottom}
        stroke="#C4C0BB"
        strokeWidth={2}
      />
      {tickVals.map((t, i) => (
        <g key={i}>
          <line
            x1={sx(t)}
            y1={H - PAD.bottom}
            x2={sx(t)}
            y2={H - PAD.bottom + 8}
            stroke="#C4C0BB"
            strokeWidth={2}
          />
          {/* 20px axis labels - the brief's floor is 18pt effective */}
          <text
            x={sx(t)}
            y={H - PAD.bottom + 32}
            textAnchor="middle"
            fontSize={20}
            fill="#5F606D"
            fontFamily="var(--font-manrope)"
          >
            {t.toFixed(2)}
          </text>
        </g>
      ))}

      {(() => {
        // Direct labels collide when two peaks sit close together - three
        // models near the same mean rendered as "GP-IPRnova-et" on the
        // projector check. Stagger colliding labels onto separate rows rather
        // than letting them overlap; a legend box would break the rule that
        // identity is never colour alone.
        const placed: { x: number; row: number }[] = [];
        labelRow = new Map<string, number>();
        for (const a of drawable) {
          const peak = a.curve.reduce((m, p) => (p[1] > m[1] ? p : m), a.curve[0]);
          const x = Math.min(Math.max(sx(peak[0]), 120), W - 120);
          let row = 0;
          while (placed.some((q) => q.row === row && Math.abs(q.x - x) < 190)) row++;
          placed.push({ x, row });
          labelRow.set(a.model, row);
        }
        return null;
      })()}
      {drawable.map((a) => {
        const c = colorFor(a.model, leader);
        const isLeader = a.model === leader;
        const d = a.curve.map((p, i) =>
          `${i === 0 ? "M" : "L"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`,
        ).join(" ");
        const peak = a.curve.reduce((m, p) => (p[1] > m[1] ? p : m), a.curve[0]);

        return (
          <g key={a.model}>
            <path
              d={`${d} L${sx(a.curve[a.curve.length - 1][0])},${H - PAD.bottom} L${sx(a.curve[0][0])},${H - PAD.bottom} Z`}
              fill={c}
              opacity={isLeader ? 0.16 : 0.07}
              style={{ transition: "d 400ms ease-out, opacity 400ms ease-out" }}
            />
            <path
              d={d}
              fill="none"
              stroke={c}
              strokeWidth={isLeader ? 6 : 3.5}
              strokeLinejoin="round"
              style={{ transition: "d 400ms ease-out, stroke 400ms ease-out" }}
            />
            {/* Direct label at the peak. No legend box - identity is never
                colour alone, which also survives colour blindness.

                The canvas-coloured stroke under the glyphs is a knockout halo.
                Without it a label sitting on another model's curve loses its
                first letter to the stroke: "IPR nova" read as "PR nova" on the
                projector check, which is exactly the kind of thing that only
                shows up from the back of the room. */}
            <text
              // Keep the direct label fully inside the plot. A half-clipped
              // model name is worse than a nudged one.
              x={Math.min(Math.max(sx(peak[0]), 120), W - 120)}
              y={Math.max(sy(peak[1]) - 14, 22) + (labelRow.get(a.model) ?? 0) * 34}
              textAnchor="middle"
              fontSize={isLeader ? 30 : 24}
              fontWeight={isLeader ? 800 : 600}
              fill={c}
              fontFamily="var(--font-bricolage)"
              stroke="#FFFAF6"
              strokeWidth={7}
              strokeLinejoin="round"
              paintOrder="stroke"
              style={{ transition: "x 400ms ease-out, y 400ms ease-out" }}
            >
              {shortName(a.model)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
