export interface Arm {
  model: string;
  alpha: number;
  beta: number;
  mean: number;
  variance: number;
  observations: number;
  requests: number;
  share: number;
  avg_latency_ms: number;
  cost_usd: number;
  curve: [number, number][];
  /** Broken out of the circuit: withheld from routing, posterior frozen. */
  disabled: boolean;
}

export interface State {
  ts: number;
  mode: "learn" | "snapshot";
  policy_id: string | null;
  gamma: number;
  shadow: boolean;
  leader: string | null;
  /** Arms the circuit breaker is currently withholding. Usually empty. */
  disabled_arms: string[];
  total_requests: number;
  errors: number;
  uptime_s: number;
  arms: Arm[];
}

export interface Spend {
  ts: number;
  actual_usd: number;
  counterfactual_usd: number;
  saved_usd: number;
  saved_pct: number;
  tokens: number;
  errors: number;
}

export interface Payload {
  state: State;
  spend: Spend;
}

export type ConnStatus = "connecting" | "live" | "reconnecting";
