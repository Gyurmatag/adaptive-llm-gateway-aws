/** Real traffic, on demand, optionally against both routers at once.
 *
 *  Nothing starts by itself: it runs because somebody pressed a button, and it
 *  stops itself after MAX_MINUTES regardless. A load generator nobody can see
 *  is one nobody turns off, and this one spends real money on two accounts.
 *
 *  "Both" mode is the comparison the talk needs: the SAME question goes to this
 *  gateway and to OpenRouter's Auto Router, and the running cost of each is
 *  kept. One request proves a point; two hundred proves a bill.
 */
import { GATEWAY, authHeaders } from "./gateway";

const MAX_MINUTES = 90;
const OR_KEY = process.env.OPENROUTER_API_KEY ?? "";

const PROMPTS = [
  "Write a Python function that reverses a list.",
  "Write a SQL query that finds duplicate rows.",
  "Why do databases use B-trees? Explain briefly.",
  "Why is connection pooling worth it? Explain.",
  "Summarise what a database index is, in one line.",
  "Summarise why caching helps, briefly.",
  "What is the capital of Hungary?",
  "What is the default port for PostgreSQL?",
];

type Side = { sent: number; ok: number; failed: number; costUsd: number };
type State = {
  running: boolean; mode: "gateway" | "both"; rate: number;
  startedAt: number | null; stopAt: number | null;
  timer: ReturnType<typeof setInterval> | null;
  mine: Side; theirs: Side;
};

const blank = (): Side => ({ sent: 0, ok: 0, failed: 0, costUsd: 0 });

const g = globalThis as unknown as { __traffic?: State };
const state: State = (g.__traffic ??= {
  running: false, mode: "gateway", rate: 3, startedAt: null, stopAt: null,
  timer: null, mine: blank(), theirs: blank(),
});

async function askGateway(prompt: string) {
  state.mine.sent++;
  try {
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        model: "demo-router",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 160, cache: { "no-cache": true },
      }),
      cache: "no-store",
    });
    const cost = Number(res.headers.get("x-litellm-response-cost") ?? 0);
    await res.arrayBuffer();
    if (!res.ok) { state.mine.failed++; return; }
    state.mine.ok++;
    if (Number.isFinite(cost)) state.mine.costUsd += cost;
  } catch { state.mine.failed++; }
}

async function askOpenRouter(prompt: string) {
  if (!OR_KEY) return;
  state.theirs.sent++;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openrouter/auto",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 160,
      }),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.choices) { state.theirs.failed++; return; }
    state.theirs.ok++;
    // OpenRouter bills the exact number back, so this is measured, not modelled.
    const c = Number(body?.usage?.cost ?? 0);
    if (Number.isFinite(c)) state.theirs.costUsd += c;
  } catch { state.theirs.failed++; }
}

function fire() {
  const prompt = `${PROMPTS[Math.floor(Math.random() * PROMPTS.length)]} #${state.mine.sent}`;
  void askGateway(prompt);
  if (state.mode === "both") void askOpenRouter(prompt);
}

export function start(rate = 3, mode: "gateway" | "both" = "gateway") {
  if (state.running) return status();
  state.running = true;
  state.mode = OR_KEY ? mode : "gateway";
  state.rate = Math.min(Math.max(rate, 0.5), 10);
  state.startedAt = Date.now();
  state.stopAt = Date.now() + MAX_MINUTES * 60_000;
  state.mine = blank(); state.theirs = blank();
  state.timer = setInterval(() => {
    if (state.stopAt && Date.now() > state.stopAt) { stop(); return; }
    fire();
  }, 1000 / state.rate);
  return status();
}

export function stop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.running = false;
  return status();
}

export function status() {
  const elapsedS = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
  return {
    running: state.running,
    mode: state.mode,
    rate: state.rate,
    elapsedS,
    stopsInS: state.running && state.stopAt ? Math.max(0, Math.round((state.stopAt - Date.now()) / 1000)) : 0,
    openrouterConfigured: Boolean(OR_KEY),
    mine: state.mine,
    theirs: state.theirs,
  };
}
