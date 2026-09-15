"use client";
import type { ReactNode } from "react";

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-sm border border-rule bg-panel ${className}`}>{children}</div>
  );
}

export function Button({
  children, onClick, disabled, tone = "solid", type = "button",
}: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  tone?: "solid" | "quiet" | "danger"; type?: "button" | "submit";
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 text-[15px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-red";
  const tones = {
    solid: "bg-navy text-canvas hover:opacity-90",
    quiet: "border border-rule bg-transparent text-navy hover:bg-warm-gray",
    danger: "bg-brand-red text-white hover:opacity-90",
  } as const;
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${tones[tone]}`}>
      {children}
    </button>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <span className="font-[family-name:var(--font-bricolage)] text-[11px] font-bold uppercase tracking-[0.13em] text-muted-ink">
      {children}
    </span>
  );
}

export function Stat({ value, label, tone = "ink" }: { value: ReactNode; label: string; tone?: "ink" | "red" | "good" }) {
  const c = tone === "red" ? "text-brand-red" : tone === "good" ? "text-good" : "text-navy";
  return (
    <div>
      <div className={`tabular font-[family-name:var(--font-bricolage)] text-2xl font-extrabold leading-none ${c}`}>{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-[0.1em] text-muted-ink">{label}</div>
    </div>
  );
}
