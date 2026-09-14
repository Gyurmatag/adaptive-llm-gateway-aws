# Demo timings

**For run-of-show validation.** Measured wall-clock seconds per demo beat, so
the deck author can flag if Act 2 will not fit.

Source: `handoff/e2e-test-report.md`. Measured against the **local stack**;
the deployed stack adds ALB and cross-region latency per request but does not
change the beat structure. Numbers marked `deployed: pending` need re-measuring
once the AWS stack is up.

---

## Act 2 budget, from the run of show

| Time | Beat | Budgeted |
|---|---|---|
| 0:16-0:17 | Demo 1: one endpoint, every model | 90s |
| 0:17-0:19 | Slide 14 + Demo 2: semantic cache | 60s for the demo |
| 0:19-0:23 | Slide 16 + Demo 3: the curves | Demo 3 is ~60s of looking |
| 0:23-0:25 | Demo 4: kill the primary + Demo 5: budget | ~90s + 10s |

---

## Measured

| Beat | Measured (local) | Budget | Verdict |
|---|---|---|---|
| Demo 1, three models | see e2e report, ~1.5s of actual request time | 90s | Fits with 88s of talking |
| Demo 2, first ask | 385 ms | - | - |
| Demo 2, reworded ask | **40 ms** | - | The gap is the demo |
| Demo 2, total beat | ~5s of machine time | 60s | Fits easily |
| Demo 3, convergence | 17 min of background load, **0s of stage time** | - | The stagecraft trick works |
| Demo 4, kill switch to visible re-sort | see e2e report | 90s | - |
| Demo 5, budget key to 429 | see e2e report | 10s | - |

**The important number is Demo 2's 385ms -> 40ms.** That ratio is the beat. It
is visible without explanation and it costs five seconds of stage time.

**Demo 3 costs zero stage time by construction.** The load generator starts at
minute 2 and the curves separate on their own by minute 19. That is the whole
reason for starting it during slide 3.

---

## What to watch on the clock

- **Act 1 is the overrun risk**, not Act 2. Act 2's machine time is a handful
  of seconds; the rest is talking, which is compressible. Act 1 is
  conversational and expands.
- **Demo 4 needs silence, not time.** The brief says say nothing for a few
  seconds and let them watch. Budget the seconds; do not fill them.
- **The 429 in Demo 5 is instant** once the budget key is near its ceiling.
  Drive it close during the soak so it tips on stage rather than after 200
  requests of waiting.

---

## Not yet measured

Everything above is the local stack. Against the deployed stack, re-measure:

- Demo 1 per-request latency through the ALB (adds a hop plus TLS)
- Demo 2 first-ask latency (real Bedrock inference, not a mock's 300ms sleep)
- Demo 4 time from `kill_primary.sh` to visible re-sort on the Amplify dashboard
  (adds SSE propagation through the ALB)
- The `GATEWAY_BASE_URL` fallback switch, deployed -> localhost
