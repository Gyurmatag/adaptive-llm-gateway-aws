"use client";

import { useEffect, useState } from "react";

type Mode = "light" | "dark" | "system";

/** Light / dark / follow the room.
 *
 *  Which one you want depends on the venue, and you find out about four
 *  minutes before you go on - so it is a control, not a build-time decision.
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("system");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("theme") as Mode | null;
      if (saved === "light" || saved === "dark" || saved === "system") setMode(saved);
    } catch { /* private window */ }
  }, []);

  function pick(m: Mode) {
    setMode(m);
    const root = document.documentElement;
    // "system" removes the stamp entirely and lets prefers-color-scheme decide.
    if (m === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", m);
    try { localStorage.setItem("theme", m); } catch { /* fine */ }
  }

  const options: { id: Mode; label: string }[] = [
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
    { id: "system", label: "System" },
  ];

  return (
    <div className="inline-flex rounded-sm border border-rule" role="group" aria-label="Colour theme">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => pick(o.id)}
          aria-pressed={mode === o.id}
          className={`px-3 py-1.5 text-[12.5px] font-semibold transition-colors first:rounded-l-sm last:rounded-r-sm ${
            mode === o.id ? "bg-navy text-canvas" : "text-muted-ink hover:text-navy"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
