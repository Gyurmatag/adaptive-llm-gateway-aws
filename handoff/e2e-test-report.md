# End-to-end test report

**Gate status: PARTIALLY CLEARED.** Two full 17-minute runs executed with real
measured numbers and captured output:

- **Run 1** - local gateway, mock provider. Proves the plumbing.
- **Run 2** - local gateway, **real Amazon Bedrock in eu-central-1**. Proves
  the demo against the models that will actually be on stage.

**Still NOT executed:** any run against the **deployed ECS stack**, the
**hotspot** run, Demo 5 (budget key), and the fallback drill. The ECS
deployment was in progress when this report was written.

Everything below is measured, not asserted. Nothing here is simulated or
extrapolated.

---

## Environment

| | |
|---|---|
| Stack | Local: LiteLLM proxy + Postgres + Redis Stack (Valkey-compatible) in Docker |
| Provider | `scripts/mock_provider.py` - synthetic, because Bedrock is unreachable without credentials |
| Gateway | `http://localhost:4000` |
| Dashboard data plane | `http://localhost:8080` |
| Dashboard UI | Next.js 16 + shadcn, `http://localhost:3000` |
| Network | Office wifi |
| Date | 14 September 2026 |

**What "mock provider" changes and what it does not.** Routing, the judge loop,
the reward path, posterior updates, decay, fallbacks, the circuit breaker, the
semantic cache, spend accounting, the dashboard and the SSE stream are all the
real code paths. Only the model text and its latency are synthetic. What is
NOT exercised: Bedrock's real latency, the `bedrock/converse/` ARN route, real
token accounting, and the ALB.

---

## Run 2 - real Amazon Bedrock, eu-central-1

The run that matters, because it uses the models that will be on stage.

**Fleet** (all verified by invocation, not catalogue lookup):

| arm | model | note |
|---|---|---|
| claude-sonnet | `eu.anthropic.claude-sonnet-4-5-20250929-v1:0` | EU-resident |
| claude-haiku | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | EU-resident |
| nova-lite | `eu.amazon.nova-lite-v1:0` | EU-resident |
| gpt-on-bedrock | `openai.gpt-oss-120b-1:0` | OpenAI, ON_DEMAND, **region-local** |
| ipr-nova | AWS **default** Nova prompt router ARN | via `bedrock/converse/` |
| judge | `eu.amazon.nova-micro-v1:0` | excluded from routing |
| embed | `amazon.titan-embed-text-v2:0` | 1024 dims |

### Headline numbers

| | |
|---|---|
| Requests | **3460** |
| **Client-visible errors** | **0** |
| Wall clock | 1138s |
| Actual spend | **$1.97** |
| Counterfactual (all on the priciest arm) | **$8.38** |
| Saved | **76.5%** |
| Tokens | 558,459 |

### Demo 1 - three model strings, three providers

```
claude-sonnet    1395 ms   "The capital of Hungary is Budapest."
gpt-on-bedrock    512 ms   "The capital of Hungary is Budapest."
nova-lite         404 ms   "The capital of Hungary is Budapest."
ipr-nova          541 ms   via the prompt router ARN
```

The `bedrock/converse/` ARN path works. Section 6.6 calls this the highest-risk
integration point in the build; it is no longer a risk.

### Demo 2 - semantic cache, real Titan embeddings

| | |
|---|---|
| First ask | **739 ms** |
| Reworded ask | **171 ms** |
| Speedup | **4.3x** |
| Header | `x-litellm-semantic-similarity: 0.9154934883118` |

### Demo 4 - kill the primary

| | |
|---|---|
| Kill switch | instant (circuit breaker file) |
| Leader before -> after | `claude-haiku` -> `gpt-on-bedrock` |
| **Errors before -> after** | **0 -> 0** |

### Convergence - and the finding that changes the stage claim

```
leader=ipr-nova  gap=0.0111  sd_sum=0.0671  separated=False
```

Final posteriors:

| arm | mean | sd | observations |
|---|---|---|---|
| ipr-nova | 0.879 | 0.034 | 111 |
| nova-lite | 0.857 | 0.033 | 142 |
| claude-haiku | 0.854 | 0.026 | 224 |
| claude-sonnet | 0.802 | 0.041 | 120 |
| gpt-on-bedrock | 0.685 | 0.037 | 185 |

**Real models cluster far more tightly than the mock's synthetic ladder.** Four
of the five arms sit inside 0.80-0.88, well within each other's error bars.
Only `gpt-on-bedrock` separates cleanly, at 0.685.

**What this means for the stage, stated plainly.** The "four cleanly separating
curves" picture from the mock run is an artifact of a synthetic quality ladder
spaced 0.10 apart. With real models on a mixed prompt pool you get **one clear
laggard and a cluster**. That is still a router that has learned something real
and visible - it found the weak arm and moved traffic - but do not promise four
separating curves, because the room will be looking at the same screen you are.

**The genuinely interesting result**: `claude-sonnet`, by far the most
expensive arm, scored **0.802** - below `nova-lite` at 0.857 and below the
managed `ipr-nova` router at 0.879. On this traffic the premium model is not
better, which is the talk's own thesis arriving as measured data rather than
as an assertion.

### Bedrock throttling on a new account

189 internal `Too many requests` in one 360-request stretch. **Every one was
absorbed by LiteLLM's retries and fallbacks; client-visible errors stayed at
zero.** Two consequences:

1. The error counter must count client-visible failures, not attempts.
   Counting attempts put "189 errors" on the dashboard during a run where
   every client request succeeded - see the defect table below.
2. Throttling, not quality, partly drives the traffic split on a new account.
   The heavily-used arm gets cooled down and traffic lands elsewhere. Worth
   knowing before attributing every shift on screen to the bandit.

### Captures

- `handoff/dashboard-real-bedrock.png` - the real-model dashboard

---

## Run 1 - local stack, mock provider

Kept because it is the only run where the convergence *tuning* was validated
against a known ground truth. Everything below this line is Run 1.

## Beat-by-beat, measured

### Beat 1 - reset to starting state

| | |
|---|---|
| `reset_demo.sh` wall clock | **2s** |
| State after reset | `0 requests, 0 errors, 0 arms` |
| Cache entries cleared | 58, search index verified intact |
| Budget key | not created (needs `bootstrap.sh`) |

### Beat 2 - load generator start

Started at t+7s. 3 req/s, concurrency 10, 70/30 easy/hard mix (verified by
sampling: 0.296 hard over 10,000 draws).

### Beat 3 - Demo 1: same request, three model strings

Cache explicitly bypassed so these are genuine provider calls.

```
claude-sonnet    -> answered by claude-sonnet    1012 ms   39 tokens
gpt-on-bedrock   -> answered by gpt-on-bedrock    791 ms   39 tokens
nova-lite        -> answered by nova-lite         333 ms    8 tokens
```

Total machine time ~2.1s against a 90s budget.

### Beat 4 - Demo 2: semantic cache on a reworded question

Question: *"Describe in two sentences how a sourdough starter develops its sour flavour."*
Reworded: *"In two sentences, what makes a sourdough starter turn sour?"*

| | |
|---|---|
| First ask | **305 ms** |
| Reworded ask | **46 ms** |
| Speedup | **6.6x** |
| Header | `x-litellm-semantic-similarity: 0.694365024567` |

The question is deliberately off-topic relative to `loadgen/prompts.yaml`. This
matters and is covered under "flaky beats" below.

### Beat 5 - soak to stage minute 19

Full 1020s (17 minutes) of continuous load. Nine samples, **zero errors
throughout**.

| t+s | requests | errors | arm means (observations) |
|---|---|---|---|
| 7 | 14 | 0 | sonnet 0.750(2) nova-lite 0.800(3) gpt 0.667(1) ipr-nova 0.333(1) |
| 127 | 372 | 0 | sonnet 0.798(38) nova-lite 0.581(46) gpt 0.849(38) ipr-nova 0.773(60) |
| 247 | 732 | 0 | sonnet 0.908(82) nova-lite 0.657(87) gpt 0.816(81) ipr-nova 0.703(104) |
| 367 | 1089 | 0 | sonnet 0.902(120) nova-lite 0.646(189) gpt 0.810(121) ipr-nova 0.706(122) |
| 487 | 1446 | 0 | sonnet 0.900(128) nova-lite 0.633(331) gpt 0.820(127) ipr-nova 0.737(156) |
| 607 | 1805 | 0 | sonnet 0.893(132) nova-lite 0.649(461) gpt 0.813(129) ipr-nova 0.748(205) |
| 728 | 2162 | 0 | sonnet 0.896(135) nova-lite 0.656(572) gpt 0.815(130) ipr-nova 0.746(260) |
| 848 | 2521 | 0 | sonnet 0.901(140) nova-lite 0.641(726) gpt 0.816(131) ipr-nova 0.735(282) |
| 968 | 2879 | 0 | sonnet 0.914(153) nova-lite 0.650(879) gpt 0.820(133) ipr-nova 0.732(306) |

**Posteriors vs the simulated ground truth**, which is the honest check that
the router learned rather than drifted:

| arm | true P(good) | learned mean | error |
|---|---|---|---|
| claude-sonnet | 0.95 | 0.914 | -0.036 |
| gpt-on-bedrock | 0.86 | 0.820 | -0.040 |
| ipr-nova | 0.76 | 0.732 | -0.028 |
| nova-lite | 0.64 | 0.650 | +0.010 |

Ordering recovered exactly. Every arm within 0.04 of truth.

**Separation.** First measured separated at **t+238s** - about four minutes,
against a seventeen-minute budget. Ample margin.

Strict criterion (leader's mean clear of runner-up by more than the sum of
their standard deviations) at the kill point:

```
gap = 0.0650   sd_sum = 0.0768   separated = False
```

**This "False" needs reading correctly, and it is the honest caveat.** The
criterion compares the top TWO arms, which here are the two closest in true
quality (0.95 vs 0.86). Their posteriors do overlap at the tails. The three
adjacent pairs below them are all cleanly separated, and what the audience
actually sees is four visibly distinct peaks - see
`handoff/dashboard-converged.png`. The visual claim holds; the strictest
possible statistical claim about the top pair does not, and should not be made
from the stage.

### Beat 6 - Demo 4: kill the primary

| | |
|---|---|
| `kill_primary.sh` wall clock | **0.09s** |
| Target | auto-selected the current traffic leader (`nova-lite`) |
| Killed arm's rolling share, t+8s | **0%** (from 62%) |
| Traffic re-sort | claude-sonnet 52% -> 66% -> 79% -> **85%** over 32s |
| **Errors across the transition** | **0 -> 0** |
| Last 60 routing decisions after the kill | `{claude-sonnet: 41, gpt-on-bedrock: 2, ipr-nova: 1}` - no trace of the killed arm |

Capture: `handoff/dashboard-failover.png`.

### Beat 7 - Demo 5: budget key hits its ceiling

**NOT EXECUTED.** The $5 budget key is created by `infra/bootstrap.sh`, which
needs AWS. The config is in place (`config/config.yaml`) and `reset_demo.sh`
resets the key's spend, but the 429 has never been observed.

**Queue the backup recording for this beat.**

### Beat 8 - fallback drill: `GATEWAY_BASE_URL` switch

**NOT MEANINGFULLY EXECUTED.** With no deployed stack there is only one
gateway, so switching the base URL to localhost is a no-op. The mechanism is a
single environment variable and is verified in the sense that every script and
the load generator already read it, but the deployed-to-local switch has not
been timed.

---

## Settings that made the posteriors separate inside the window

This is the highest-risk item in the demo and it is a tuning problem. These
values were not guessed - `scripts/simulate_convergence.py --sweep` drives the
real router against simulated responses and reports whether separation lands
inside 17 minutes.

```
ROUTER_GAMMA=0.10          # cost/quality dial
ROUTER_MIN_OBS=120         # cold-start exploration floor
ROUTER_EXPLORE_P=0.40
ROUTER_DECAY_LAMBDA=0.995
ROUTER_DECAY_EVERY=40
JUDGE_SAMPLE_RATE=0.50
LOADGEN_RATE=3.0
```

**Why gamma is 0.10 and not the 0.35 the brief suggests.** The real fleet spans
roughly a 50x cost range. Above about gamma 0.2 the cost term dominates the
Thompson score so consistently that the expensive arms are never sampled, never
judged, and their posteriors sit at the prior - flat curves, which from the
back of a room read as a broken dashboard rather than as unexplored arms.
Sweep output at gamma 0.35: `min_observations: 0`.

**Why the exploration floor exists.** Same reason. Until every arm has
`MIN_OBS` real observations, 40% of traffic goes to the least-observed arm.
Once all arms clear the floor, exploration stops and pure Thompson takes over.

**Why the judge samples at 0.5 rather than 0.3.** Observations are what narrow
the curves. At 0.3 the posteriors were still too wide at t+1020 for the
separation to be visually convincing.

---

## Error count across the failover

**Zero.** Measured at t+8, 16, 24 and 32 seconds after the kill switch, and
zero for the entire 2879-request soak before it. This is the number the demo
turns on and it held.

---

## Beats that could not be made reliable - queue their recordings

1. **Demo 5, the budget 429.** Never executed. Needs AWS.
2. **The fallback drill.** Never meaningfully executed. Needs a deployed stack
   to switch away from.
3. **Demo 2 is fragile by construction and this is worth understanding.** The
   load generator starts at stage minute 2 and seeds the semantic cache
   continuously. If the Demo 2 question resembles anything in
   `loadgen/prompts.yaml`, it is already warm by minute 17 and the beat shows
   no contrast at all - measured, before the fix: 19ms then 19ms. The question
   is now deliberately off-topic and the connection-pooling prompt was removed
   from the pool. **If the prompt pool is ever edited, re-check this.**
4. **The top two arms do not separate on the strict criterion.** See beat 5.
   Do not claim statistical separation of the top pair from the stage.

---

## What is blocked, and why

No AWS credential exists on the machine: the account has zero IAM users and
zero Identity Center users, so the CLI has nothing to authenticate with.

Not executed as a result:
- Both runs against the **deployed** stack
- The **hotspot** run
- Demo 5 (budget key)
- The fallback drill with a real second endpoint
- `bedrock/converse/` ARN smoke test - **the highest-risk integration point in
  the whole build, per section 6.6, and it remains untested**

**The second run and the hotspot run remain a genuine gate that has not been
cleared.** A single clean run against a mock provider on office wifi proves
considerably less than the brief asks for.

---

## What running it actually caught

Recorded because it is the argument for rehearsing rather than planning. Every
one of these failed **silently** - traffic flowed, the dashboard looked alive,
and nothing logged an error.

| Defect | Consequence if undetected |
|---|---|
| Semantic cache was caching the **judge** | 404 identical scores (0.63); every arm marked a failure; all posteriors collapsed to 0.012 |
| `kill_primary.sh` killed the wrong deployment | 68 of the last 75 routes still went to the "killed" model, error counter correctly at 0 |
| LiteLLM cannot disable a config-file deployment at runtime | `/model/update` silently no-ops, `/model/delete` 400s. Demo 4 had no working mechanism at all |
| Traffic split was cumulative, not rolling | Killed arm still showed 63% of traffic 45s later; the failover panel showed nothing |
| `reset_demo.sh` did nothing | Run 2 started with run 1's 864 requests and 10 errors on the board |
| `FLUSHALL` destroyed the vector index | Semantic cache silently never hit again until a gateway restart |
| Reward callbacks never fired | 585 routing decisions, zero posterior updates |
| `asyncio.create_task` with no strong reference | Reward tasks garbage collected before running |
| Judge called as `litellm.acompletion(model="judge")` | Cannot resolve a router group name; failed and was swallowed |
| Savings counter read `$0.00 actual / 100% saved` | A fabricated headline number on the largest element on screen |
| Demo 1 and Demo 2 served from cache | Both beats showed ~19ms; Demo 2 had no contrast to show |
| Bare Bedrock model ids rejected | "on-demand throughput isn't supported" - every Anthropic/Nova model needs an `eu.` inference profile |
| `os.environ/VAR` does not interpolate mid-string | `bedrock/converse/os.environ/X` sent literally; Bedrock says "invalid model identifier" |
| `tier` is a reserved `model_info` field | Any other value fails validation and LiteLLM DROPS that deployment while still starting |
| Default Anthropic prompt router is EOL in eu-central-1 | Listing reports it healthy; only invoking reveals it |
| `REDIS_NUM_CACHE_CLUSTERS=1` fails at plan time | Coupled to a hard-coded `automatic_failover_enabled` the module does not expose |
| Error counter counted attempts, not client errors | 189 "errors" during a run where all 360 client requests succeeded |
| Fallback-served deployments became junk arms | A flat posterior stretched the dashboard x-axis to 0..1 |
| Snapshot mode fell back to the live bandit in silence | Deterministic serving requested, self-modifying policy delivered |
| Three curve labels overlapped | Read as "GP-IPRnova-et" on the projector check |
| Savings counter clipped at fixed font size | Headline number cut off at narrower widths |
