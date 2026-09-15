"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

/** A plain-words box.
 *
 *  Two audiences read this screen at once: a speaker who needs the next
 *  sentence, and a room that has never seen any of it. Everything here is
 *  written for the room - short lines, no jargon, nothing that needs the
 *  previous slide to make sense.
 */
export function Explain({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-sm border-l-[3px] border-brand-red bg-warm-gray px-5 py-4">
      <p className="font-[family-name:var(--font-bricolage)] text-[13px] font-bold uppercase tracking-[0.1em] text-muted-ink">
        {title}
      </p>
      <div className="mt-2 space-y-1.5 text-[15px] leading-relaxed text-navy">{children}</div>
    </div>
  );
}

/** The one explanation that carries the whole talk. Collapsible, because the
 *  speaker will want it gone after slide 16 and back for questions. */
export function HowItDecides() {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    try {
      const v = localStorage.getItem("explain:how");
      if (v === "0") setOpen(false);
    } catch { /* private window, or storage blocked */ }
  }, []);

  function toggle() {
    setOpen((v) => {
      try { localStorage.setItem("explain:how", v ? "0" : "1"); } catch { /* fine */ }
      return !v;
    });
  }

  return (
    <div className="rounded-sm border border-rule bg-panel">
      <button
        type="button" onClick={toggle}
        className="flex w-full items-center justify-between gap-4 px-5 py-3 text-left"
      >
        <span className="font-[family-name:var(--font-bricolage)] text-[17px] font-bold">
          How it decides which model answers
        </span>
        <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted-ink">
          {open ? "hide" : "show"}
        </span>
      </button>

      {open && (
        <div className="border-t border-rule px-5 py-5">
          <ol className="grid gap-4 sm:grid-cols-3">
            <Step n="1" head="Each model keeps a score">
              How often its answers are good enough. Nothing is hard-coded — the score comes
              only from what actually happened.
            </Step>
            <Step n="2" head="A cheap model grades the answers">
              Every answer gets marked out of 1. A good mark pushes that model&rsquo;s score up,
              a bad one pushes it down.
            </Step>
            <Step n="3" head="Score divided by price wins">
              A model that is nearly as good but far cheaper beats an expensive one. That
              single division is the whole idea.
            </Step>
          </ol>
          <p className="mt-5 border-t border-rule pt-4 text-[15px] text-navy">
            It also tries every model now and then, on purpose — otherwise it would never find
            out that a model it wrote off has got better.
          </p>
        </div>
      )}
    </div>
  );
}

function Step({ n, head, children }: { n: string; head: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="font-[family-name:var(--font-bricolage)] text-[26px] font-extrabold leading-none text-brand-red">
        {n}
      </span>
      <span>
        <span className="block font-[family-name:var(--font-bricolage)] text-[15px] font-bold leading-snug">
          {head}
        </span>
        <span className="mt-1 block text-[14px] leading-relaxed text-muted-ink">{children}</span>
      </span>
    </li>
  );
}
