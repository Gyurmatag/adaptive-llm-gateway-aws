/** Server-side load generator. One per container, started and stopped from the UI.
 *
 *  This replaces `python3 loadgen/run.py` in a terminal, which was the last
 *  thing standing between the speaker and a keyboard-free demo.
 *
 *  Hard-capped on purpose: a generator nobody can see is a generator nobody
 *  turns off, and this one spends real money on Bedrock. It stops itself after
 *  MAX_MINUTES no matter what.
 */
import { GATEWAY, authHeaders } from "./gateway";

const MAX_MINUTES = 90;

const PROMPTS = [
  "Write three sentences about databases.",
  "Why do databases use B-trees? Explain briefly.",
  "Write a Python function that reverses a list.",
  "Summarise what a database index is, in one line.",
  "What is the capital of Hungary? One sentence.",
  "Explain connection pooling in two sentences.",
  "Write a SQL query that finds duplicate rows.",
  "Give one reason to add an index, briefly.",
];

type State = {
  running: boolean;
  startedAt: number | null;
  sent: number;
  ok: number;
  failed: number;
  rate: number;
  timer: ReturnType<typeof setInterval> | null;
  stopAt: number | null;
};

// Module scope survives between requests inside one Node process, which is all
// this needs - the service runs exactly one task.
const g = globalThis as unknown as { __traffic?: State };
const state: State = (g.__traffic ??= {
  running: false, startedAt: null, sent: 0, ok: 0, failed: 0,
  rate: 3, timer: null, stopAt: null,
});

async function fire() {
  const prompt = `${PROMPTS[Math.floor(Math.random() * PROMPTS.length)]} #${state.sent}`;
  state.sent++;
  try {
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "demo-router",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
        cache: { "no-cache": true },
      }),
      cache: "no-store",
    });
    if (res.ok) state.ok++; else state.failed++;
    await res.arrayBuffer();
  } catch {
    state.failed++;
  }
}

export function start(rate = 3) {
  if (state.running) return status();
  state.running = true;
  state.startedAt = Date.now();
  state.stopAt = Date.now() + MAX_MINUTES * 60_000;
  state.sent = 0; state.ok = 0; state.failed = 0;
  state.rate = Math.min(Math.max(rate, 0.5), 10);
  const everyMs = 1000 / state.rate;
  state.timer = setInterval(() => {
    if (state.stopAt && Date.now() > state.stopAt) { stop(); return; }
    void fire();
  }, everyMs);
  return status();
}

export function stop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.running = false;
  return status();
}

export function status() {
  return {
    running: state.running,
    rate: state.rate,
    sent: state.sent,
    ok: state.ok,
    failed: state.failed,
    elapsedS: state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
    stopsInS: state.running && state.stopAt
      ? Math.max(0, Math.round((state.stopAt - Date.now()) / 1000)) : 0,
  };
}
