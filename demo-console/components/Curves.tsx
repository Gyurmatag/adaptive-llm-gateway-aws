"use client";

import { colorFor, shortName } from "@/lib/brand";

type Arm = { model: string; observations: number; curve: [number, number][]; requests: number; share: number };

/** What the router believes, as one density per model.
 *
 *  Ported from the projector dashboard so there is a single URL to run the
 *  whole talk from. Every colour is a CSS variable rather than a hex value,
 *  because this page has a light/dark switch and the original palette's
 *  near-black curve disappears on a dark ground.
 */
export function Curves({ arms, leader }: { arms: Arm[]; leader: string | null }) {
  const W = 1000, H = 340;
  const PAD = { top: 26, right: 28, bottom: 42, left: 28 };

  // An arm with almost no observations has a near-flat posterior spanning the
  // whole range. Drawn, it squashes every real curve into a corner and adds a
  // meaningless horizontal line. Below the floor it is not evidence yet.
  const drawable = arms.filter((a) => a.curve?.length > 1 && a.observations >= 5);
  if (!drawable.length) {
    return (
      <div className="flex h-[240px] items-center justify-center text-[16px] text-muted-ink">
        {arms.length ? "Gathering evidence — run a demo or ask something." : "Waiting for the first answers…"}
      </div>
    );
  }

  // One shared x-window, or the panel silently lies about separation.
  const xs = drawable.flatMap((a) => [a.curve[0][0], a.curve[a.curve.length - 1][0]]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  const span = Math.max(x1 - x0, 0.02);
  x0 = Math.max(0, x0 - span * 0.08);
  x1 = Math.min(1, x1 + span * 0.08);
  const yMax = Math.max(...drawable.flatMap((a) => a.curve.map((p) => p[1])), 1);

  const sx = (x: number) => PAD.left + ((x - x0) / (x1 - x0)) * (W - PAD.left - PAD.right);
  const sy = (y: number) => H - PAD.bottom - (y / yMax) * (H - PAD.top - PAD.bottom);

  const tickVals = Array.from({ length: 5 }, (_, i) => x0 + ((x1 - x0) * i) / 4);

  // Real models cluster tightly, so labels fight for the same pixels. Stagger
  // them onto rows and nudge them apart.
  const labelPos = new Map<string, { x: number; row: number }>();
  const placed: { x: number; row: number }[] = [];
  for (const a of [...drawable].sort((p, q) => {
    const px = p.curve.reduce((m, c) => (c[1] > m[1] ? c : m), p.curve[0])[0];
    const qx = q.curve.reduce((m, c) => (c[1] > m[1] ? c : m), q.curve[0])[0];
    return px - qx;
  })) {
    const peak = a.curve.reduce((m, c) => (c[1] > m[1] ? c : m), a.curve[0]);
    const px = sx(peak[0]);
    let row = 0;
    let lx = Math.min(Math.max(px, 110), W - 110);
    while (placed.some((q) => q.row === row && Math.abs(q.x - lx) < 140)) {
      row++;
      const nudge = 105 * (row % 2 === 1 ? 1 : -1) * Math.ceil(row / 2);
      lx = Math.min(Math.max(px + nudge, 110), W - 110);
    }
    placed.push({ x: lx, row });
    labelPos.set(a.model, { x: lx, row });
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img"
         aria-label="How likely each model is to give a good-enough answer">
      <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom}
            stroke="var(--sf-rule)" strokeWidth={2} />
      {tickVals.map((t, i) => (
        <g key={i}>
          <line x1={sx(t)} y1={H - PAD.bottom} x2={sx(t)} y2={H - PAD.bottom + 8}
                stroke="var(--sf-rule)" strokeWidth={2} />
          <text x={sx(t)} y={H - PAD.bottom + 30} textAnchor="middle" fontSize={19}
                fill="var(--sf-gray)" fontFamily="var(--font-manrope)">
            {t.toFixed(2)}
          </text>
        </g>
      ))}

      {drawable.map((a) => {
        const c = colorFor(a.model, leader);
        const isLeader = a.model === leader;
        const d = a.curve
          .map((p, i) => `${i === 0 ? "M" : "L"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`)
          .join(" ");
        const peak = a.curve.reduce((m, p) => (p[1] > m[1] ? p : m), a.curve[0]);
        const pos = labelPos.get(a.model) ?? { x: sx(peak[0]), row: 0 };
        const labelY = Math.max(sy(peak[1]) - 14, 24) + pos.row * 36;
        return (
          <g key={a.model}>
            <path
              d={`${d} L${sx(a.curve[a.curve.length - 1][0])},${H - PAD.bottom} L${sx(a.curve[0][0])},${H - PAD.bottom} Z`}
              fill={c} opacity={isLeader ? 0.16 : 0.07}
              style={{ transition: "d 400ms ease-out, opacity 400ms ease-out" }} />
            <path d={d} fill="none" stroke={c} strokeWidth={isLeader ? 6 : 3.5}
                  strokeLinejoin="round"
                  style={{ transition: "d 400ms ease-out, stroke 400ms ease-out" }} />
            {/* Direct label, no legend box: identity is never colour alone, which
                also survives colour blindness. The canvas-coloured stroke is a
                knockout halo - without it a label sitting on another curve loses
                its first letter from the back of a room. */}
            <text x={pos.x} y={labelY} textAnchor="middle"
                  fontSize={isLeader ? 29 : 23} fontWeight={isLeader ? 800 : 600}
                  fill={c} fontFamily="var(--font-bricolage)"
                  stroke="var(--sf-canvas)" strokeWidth={7} strokeLinejoin="round"
                  paintOrder="stroke"
                  style={{ transition: "x 400ms ease-out, y 400ms ease-out" }}>
              {shortName(a.model)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Rolling traffic split. Same colours as the curves, same order, so the red
 *  moves in both at the same moment when the leader changes. */
export function TrafficSplit({ arms, leader }: { arms: Arm[]; leader: string | null }) {
  const total = arms.reduce((s, a) => s + a.requests, 0);
  if (!total) return null;
  return (
    <div>
      <div className="flex h-12 w-full overflow-hidden rounded-[2px]">
        {arms.map((a) => {
          const pct = (a.requests / total) * 100;
          if (pct <= 0) return null;
          return (
            <div key={a.model} title={`${a.model} ${pct.toFixed(1)}%`}
                 style={{ width: `${pct}%`, background: colorFor(a.model, leader),
                          transition: "width 500ms ease-out, background 400ms ease-out" }} />
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
        {arms.filter((a) => a.requests > 0).map((a) => (
          <div key={a.model} className="flex items-baseline gap-2">
            <span className="inline-block h-3.5 w-3.5 shrink-0"
                  style={{ background: colorFor(a.model, leader) }} />
            <span className="tabular font-[family-name:var(--font-bricolage)] text-[17px] font-bold">
              {((a.requests / total) * 100).toFixed(0)}%
            </span>
            <span className="text-[14px] text-muted-ink">{shortName(a.model)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
