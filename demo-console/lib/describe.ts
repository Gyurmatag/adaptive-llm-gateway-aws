/** Rendering an audit line as a sentence, not as JSON.
 *
 *  Shared by the always-on ticker and the full Decisions tab so the two can
 *  never drift into describing the same event differently.
 */
export type Entry = Record<string, unknown> & { ts: number; event: string };

// The strings the router itself writes, spelled out for a room that has never
// seen them.
const REASON: Record<string, string> = {
  thompson: "sampled the posteriors",
  cold_start_exploration: "exploring — fewest observations",
  session_affinity: "pinned to this conversation",
  operator_pin: "operator pin",
  snapshot: "frozen policy",
  snapshot_degraded: "frozen policy, no artifact",
};

const KIND: Record<string, { label: string; tone: "route" | "reward" | "alert" }> = {
  route: { label: "ROUTE", tone: "route" },
  reward: { label: "REWARD", tone: "reward" },
  breaker_active: { label: "BREAKER", tone: "alert" },
  arm_withheld: { label: "WITHHELD", tone: "alert" },
  arm_restored: { label: "RESTORED", tone: "reward" },
  client_error: { label: "ERROR", tone: "alert" },
  judge_error: { label: "JUDGE", tone: "alert" },
  reward_error: { label: "REWARD", tone: "alert" },
  failure: { label: "FAILURE", tone: "alert" },
};

export function kindOf(event: string) {
  return KIND[event] ?? { label: event.toUpperCase(), tone: "route" as const };
}

export function describeEntry(r: Entry): string {
  const arm = (r.arm as string) ?? "";
  switch (r.event) {
    case "route": {
      const why = REASON[(r.reason as string) ?? ""] ?? (r.reason as string) ?? "";
      const score = r.score as Record<string, number> | undefined;
      const best = score && Object.keys(score).length
        ? ` · best score ${Math.max(...Object.values(score)).toFixed(2)} of ${Object.keys(score).length} arms`
        : "";
      // Slide 19 wants the cost on the decision, not only the reason.
      const cpt = r.cost_per_token as number | undefined;
      const cost = cpt ? ` · $${(cpt * 1000).toFixed(4)}/1k tokens` : "";
      return `chose ${arm} — ${why}${best}${cost}`;
    }
    case "reward": {
      const s = r.judge_score as number | null | undefined;
      const good = r.success as boolean | null;
      const ms = Math.round((r.latency_ms as number) ?? 0);
      return `${arm} judged ${s === null || s === undefined ? "—" : s.toFixed(2)} → ${
        good ? "counted as good" : "counted as not good enough"} · ${ms} ms`;
    }
    case "arm_withheld":
      return `${arm} removed from routing by the gateway — cooldown or rate limit`;
    case "arm_restored":
      return `${arm} back in routing after ${Math.round((r.withheld_s as number) ?? 0)}s`;
    case "breaker_active":
      return `withholding ${((r.excluded as string[]) ?? []).join(", ")} — circuit breaker`;
    case "client_error":
    case "failure":
      return `${arm || "request"} failed — ${String(r.error ?? "").slice(0, 90)}`;
    case "judge_error":
      return `judge unavailable — ${String(r.error ?? "").slice(0, 90)}`;
    default:
      return JSON.stringify(r).slice(0, 120);
  }
}
