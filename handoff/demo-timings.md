# Demo timings

**For run-of-show validation.** Measured wall-clock seconds per demo beat, so
the deck author can flag if Act 2 will not fit.

Source: `handoff/e2e-test-report.md`. The table below is the **local stack**;
the deployed numbers follow it and are now measured, not pending.

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

All from `handoff/e2e-test-report.md`, local stack, mock provider.

| Beat | Measured | Budget | Verdict |
|---|---|---|---|
| Demo 1, three models | **2.1s** total (1012 / 791 / 333 ms) | 90s | Fits with ~88s of talking |
| Demo 2, first ask | **305 ms** | - | - |
| Demo 2, reworded ask | **46 ms** | - | **6.6x** - this ratio is the beat |
| Demo 2, total machine time | ~0.4s | 60s | Fits easily |
| Demo 3, convergence | 17 min of background load, **0s of stage time** | - | The stagecraft trick works |
| Demo 3, first separation | **t+238s** (~4 min) | 17 min | Large margin |
| Demo 4, kill switch | **0.09s** to fire | - | - |
| Demo 4, killed arm to 0% of traffic | **8s** | - | Visible almost immediately |
| Demo 4, full re-sort to 85% | **32s** | 90s | Fits, and wants silence not filler |
| Demo 2 on PRODUCTION, reworded | **0.864s -> 0.127s**, similarity 0.9496 | 60s | **6.8x**. Needs the Redis Stack sidecar |
| Demo 5, budget block | **4-6s**, blocks after 3-6 requests | 10s | Fits. **Not a 429** - see below |
| Fallback switch | **614ms / 622ms** (runs 5, 6) | - | Effectively instant |

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
- **Demo 5 is instant** once the budget key is near its ceiling. Drive it close
  during the soak so it tips on stage rather than after 200 requests of waiting.
  **Do not call it a 429.** On the deployed stack the block comes back as
  **HTTP 200** with `budget_exceeded` in the body, because the guidance's
  middleware passes the error through; locally it is a 400. Point at the JSON,
  never at the status code.

---

## Measured against the DEPLOYED stack

Amplify -> CloudFront -> ALB -> ECS -> Bedrock, runs 5 and 6.

| Beat | Deployed | Note |
|---|---|---|
| Per-request latency, by arm | nova-lite **862ms**, gpt-on-bedrock **893ms**, ipr-nova **1090ms**, claude-haiku **1214ms**, claude-sonnet **2418ms** | Real Bedrock inference, through ALB and TLS |
| `ipr-nova` under sustained load | 60/60 HTTP 200, **p95 1891ms** | Driven at the demo's own 3 req/s |
| Demo 4, kill switch fires | **0-1s** | `POST /dash/admin/disable` - the file-based breaker cannot reach ECS |
| Demo 4, errors across the failover | **0**, both runs | 3241 client requests in run 5 |
| Demo 5, budget block | **4-5s**, after 3-5 requests | HTTP 200 + `budget_exceeded` body |
| Fallback switch to standby | **614ms / 622ms** | Local gateway as standby, `STANDBY_KEY` required |
| SSE first byte through CloudFront | **0.06-0.07s** | Not buffered; update frames continuous |
| Full rehearsal wall clock | **1084-1091s** | Against the 17-minute Act 2 budget |

**Savings shown on the dashboard at the end of a run: $3.5625, 72.6%**, across
327,082 tokens and zero errors.

The one number that got worse on the deployed stack is `claude-sonnet` at
2418ms. It is the slowest arm by a factor of nearly three, which is worth
knowing before Demo 1 addresses it directly on stage.
