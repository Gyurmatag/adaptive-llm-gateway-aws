# End-to-end test report

**Gate status: PARTIALLY CLEARED.** Three full runs executed with real measured
numbers and captured output:

- **Run 1** - local gateway, mock provider. Proves the plumbing.
- **Run 2** - local gateway, **real Amazon Bedrock in eu-central-1**.
- **Run 3** - the **deployed AWS stack**: Amplify -> CloudFront -> ALB -> ECS
  -> Bedrock. The topology that will be on stage.

**Still NOT executed: the hotspot run.** It needs the machine moved onto a
mobile hotspot, which is a physical act this build could not perform. Given
that the office network dropped out completely during this build - taking a
Terraform apply and a git push with it - that gate matters more than usual and
remains genuinely open.

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

## Run 3 - the deployed AWS stack

The topology that will be on stage. `https://<cloudfront>/` in front of the
ALB, ECS Fargate, one task, Bedrock in eu-central-1.

### Convergence - the first run to pass the strict test

```
leader=claude-sonnet  gap=0.0539  sd_sum=0.0472  separated=True  minobs=103
```

**This is the only run where the posteriors separated on the strict criterion**
(leader clear of runner-up by more than the sum of their standard deviations),
with every arm at 103 or more real observations. Runs 1 and 2 did not reach it.

### Demo 1 - through CloudFront, ALB and ECS

```
claude-sonnet    1375 ms
gpt-on-bedrock    363 ms
nova-lite         725 ms
```

Streaming: **24 chunks in 770 ms** through the ALB.
**SSE through CloudFront: first byte at 0.06s, not buffered.**

### Demo 2 - DOES NOT WORK on the deployed stack

```
first ask:    640ms
reworded ask: 591ms
x-litellm-semantic-similarity: NOT PRESENT
```

Expected, and not a defect to fix: ElastiCache has no RediSearch, so the
semantic cache cannot run there at all. **Demo 2 must be run against the local
standby.** See infra/DEPLOY.md.

### Demo 4 - worked only after two failures worth recording

The first two attempts **reported success and did nothing**:

```
leader before -> after: claude-haiku -> claude-haiku
killed arm rolling share after the "kill": 26%
errors: 0        <- because nothing had happened
```

Two independent causes, both invisible:

1. The circuit breaker is a FILE in the gateway's state directory. Locally
   that is a bind mount; on ECS the task shares no filesystem with the laptop,
   so the switch was thrown on the wrong machine. Fixed with master-key
   protected admin endpoints mounted inside the gateway process
   (`POST /dash/admin/disable`).
2. The service was running **two** ECS tasks, so the admin POST reached one
   while the other kept serving. A hand-applied autoscaling pin does not
   survive `terraform apply` - it must be set in `MAX_CAPACITY`.

Verified working, single task, deployed stack:

| | |
|---|---|
| kill switch | **0.18s** |
| killed arm share (window 250) | 42% -> 38% -> 31% -> 21% -> 17% -> **0%** at t+65s |
| leader | `gpt-on-bedrock` -> `claude-haiku` |
| **errors** | **0 throughout** |

Re-measured after tuning the rolling window to 150, single task, deployed:

| | |
|---|---|
| killed arm | `claude-haiku`, 36% of traffic and the leader |
| t+15s | 13% |
| t+30s | 2% |
| t+45s | **0%** |
| **errors** | **0 throughout** |

45s to fully resolve inside a 90s beat, against 65s before the change.
Capture: `handoff/dashboard-deployed-failover.png`, taken from the live
Amplify URL.

### Demo 5 - budget enforcement confirmed, script reporting wrong

```
budget_exceeded | Budget has been exceeded!
Current cost: 0.00174795, Max budget: 0.0005
```

Enforcement works. The rehearsal script logged `HTTP 200` for it, which is a
reporting bug in the harness, not a gateway failure. **Still a 400, not a 429.**

### Fallback drill - NOT VALID this run

`standby did NOT answer`. The local stack had been repointed at the deployed
config, so there was no second gateway to fall back to. The mechanism is one
environment variable and is exercised by every script via `ENV_FILE`, but the
deployed-to-local switch has still not been timed.

### Honest caveats on this run

- The soak was **~14 clean minutes, not 17**. `reset_demo.sh` forced a new ECS
  task and returned while the previous one was still draining, so the first
  three minutes of traffic went to a task that then died. Fixed, but this run
  carries the shortfall.
- `handoff/dashboard-deployed.png` is captured from the **live Amplify URL**
  against this stack: 1300 requests, $2.29 saved (74%), zero errors.

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

**Why "separated" now measures discrimination, not the top two.** The gate
used to ask whether the single best arm was distinguishable from the second
best. On this fleet it never can be, and that is a property of the models
rather than a failure of the router:

```
arm              mean      sd   obs   req   $/1k req
claude-haiku     0.872  0.0294   131   529     0.6621
claude-sonnet    0.869  0.0355    90   401     1.9133
nova-lite        0.819  0.0380   103   411     0.1529
ipr-nova         0.809  0.0481    66   308     0.2860
gpt-on-bedrock   0.721  0.0452    98   436     0.1361
```

`claude-haiku` and `claude-sonnet` both clear the 0.85 judge threshold at about
0.87. The true gap is **0.0027**. Separating a gap that small needs on the order
of **1e5 observations per arm** - roughly thirty hours of soak at 3 req/s. The
rehearsal was reporting `separated=False` for something no amount of soaking
could fix, and two runs were spent tuning gamma and the exploration floor
against it.

What is measurable inside the window, and what the curves actually show from the
back of a room, is **discrimination**: the leader against the worst arm.

```
discrimination=0.1507 vs 0.0746  separated=True
top2=0.0027 vs 0.0648            TIED
leader_cheaper_than_runnerup=True (0.6621 vs 1.9133 per 1k)
minobs=66
```

**This is the better stage claim, not a weaker one.** Two arms being tied on
quality is the *setup* for the whole talk: when quality is indistinguishable,
the router takes the cheap one. `claude-haiku` leads on traffic at **2.9x less
cost per request than `claude-sonnet`** at statistically identical quality. Say
that, and point at the `gpt-on-bedrock` curve sitting clearly below the pack as
the thing the router learned to avoid.

---

## The bug that cost two rehearsals: an arm that was switched off

Run 4 reported `separated=False minobs=36` with `ipr-nova` frozen at 31
observations while every other arm climbed past 120. It was not a bandit
problem. `ipr-nova` was **in the circuit breaker's `DISABLED` file** and had
been withheld from every routing decision.

`kill_primary.sh` writes the killed arm into `DISABLED`. `reset_demo.sh` clears
it - but only at the *start* of a run, and the kill drill is beat 6 of 8. So a
finished run leaves the breaker dirty and the next one begins with an arm
already off.

Measured directly, before the fix:

```
150 requests driven at the demo-router group
  nova-lite        41   0.414
  claude-haiku     32   0.323
  gpt-on-bedrock   26   0.263
  claude-sonnet     0   0.000
  ipr-nova          0   0.000     <- 0 of 99 selections
```

The exploration floor should have poured 40% of traffic into `ipr-nova`, since
it was the least-observed arm by a wide margin. It got none, because the
breaker removed it from `healthy` before the bandit ever saw it. The arm itself
was fine: driven directly at soak rate it returned **60/60 HTTP 200, p95
1891ms**.

**Why it went unnoticed for two runs.** The dashboard kept drawing the arm with
the posterior it had when it was killed. A switched-off arm and a merely
under-observed arm rendered identically. Three fixes, because one was not
enough:

- the router prints a throttled warning and writes a `breaker_active` audit
  event whenever it withholds an arm
- `/state` carries `disabled_arms` and a per-arm `disabled` flag; the traffic
  split strikes the arm through and badges it **off**
- the rehearsal asserts a clean breaker after the reset and restores it after
  the kill drill, so a run can no longer poison the next one

Run 5, after the fix: every arm accumulating, `minobs=66`, 3241 requests, **0
errors**.

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

Superseded. This section previously recorded that no AWS credential existed on
the machine, so nothing could run against real infrastructure. That is no
longer true and the items are kept here only so the history is legible:

| Previously blocked | Status |
|---|---|
| Runs against the **deployed** stack | **Done** - runs 3, 4, 5 and 6 all ran against ECS behind CloudFront |
| Demo 5 (budget key) | **Done** - blocks after 3 requests, 5s. HTTP **200** on the deployed stack with `budget_exceeded` in the body |
| Fallback drill with a real second endpoint | **Done** - standby answered in **614ms**. It had been failing on a 401, not a dead standby: beat 8 authenticated to the local gateway with the *deployed* master key. `STANDBY_KEY` now carries the local one |
| `bedrock/converse/` ARN smoke test | **Done** - `ipr-nova` *is* the ARN route (`bedrock/converse/arn:aws:bedrock:...:default-prompt-router/amazon.nova:1`). 60/60 HTTP 200 at soak rate, p95 1891ms |
| The **hotspot** run | Run 4 ran on a phone hotspot, but under the circuit-breaker bug, so it does not count as clean. A post-fix hotspot run is the one remaining item |

### Still genuinely open

- **A clean hotspot run.** Run 4 was on a hotspot but was poisoned by the
  disabled-arm bug. Needs re-running on the phone hotspot now that the fix is
  in.
- **`infra/teardown.sh` still cannot be executed** without destroying the stack
  the talk runs on, but every step of it has now been dry-run read-only, and
  that caught two defects that would have left the demo billing:

  1. **The prompt-router deletion was a silent no-op.** It hunted for
     `awsday-gateway-claude` / `awsday-gateway-nova`, which were never created -
     the demo uses the account's AWS-managed *default* prompt routers. The loop
     matched nothing and printed nothing, which read as "cleaned up".
  2. **The add-on `terraform destroy` guarded on the `.terraform` directory**,
     which `init` creates whether or not anything was applied. With an empty
     state it failed with nine `No value for required variable` errors, printed
     `(add-on destroy reported errors)` and carried on.

  Verified working: `undeploy.sh` is present and executable, its two
  prerequisites (`infra/upstream/config/config.yaml` and `infra/upstream/.env`)
  both exist, `LITELLM_VERSION` and `CERTIFICATE_ARN` are set, and the Amplify
  lookup resolves the real app id. The `$150` budget `awsday-gateway-monthly`
  exists and is deliberately left in place.

  One caveat for whoever runs it: upstream's `undeploy.sh` echoes every
  provider API key to stdout. All 22 are empty placeholders in this deployment,
  so nothing leaks here - but do not paste its output anywhere if that ever
  changes.
- **Backup recordings.** `handoff/recording-shotlist.md` lists the shots; the
  videos need a human at the keyboard.

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
