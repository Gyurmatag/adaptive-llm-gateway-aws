# Adaptive LLM Gateway on AWS

> One endpoint, every model. A LiteLLM gateway on AWS with Bedrock Intelligent
> Prompt Routing, cross-provider fallbacks, semantic caching, and a
> Thompson-sampling router that learns from live traffic.

Built for **"One Endpoint, Every Model: Building an Adaptive LLM Gateway on AWS"**,
AWS Community Day CEE 2026.

**The AWS stack is torn down after the conference.** Nothing here is a live
endpoint - clone it and deploy your own.

---

## Read this first, because it is the point of the talk

Most teams who think they need to build this only need to **deploy** it.

The gateway, the virtual keys, the per-team budgets, the cross-provider
fallbacks and the semantic caching are all off-the-shelf: AWS publishes
[Terraform for exactly this](https://github.com/aws-solutions-library-samples/guidance-for-multi-provider-generative-ai-gateway-on-aws),
and it is vendored here under `infra/upstream/`.

The only thing in this repo that is genuinely *built* is the adaptive router in
`router/`, and even that exists for one narrow reason documented in
[handoff/branch-decision.md](handoff/branch-decision.md): LiteLLM's own adaptive
router is good, is a Thompson-sampling bandit, and configures from proxy YAML -
but it learns from **implicit user-satisfaction signals**, and there is no
documented way to feed it a programmatic quality score. Back-office traffic has
no user to read satisfaction from, so the reward channel is the gap.

If that does not describe your situation, use the built-in one. It is
configured and switchable in `config/config.yaml` as `builtin-adaptive`.

---

## What is in here

| Path | What it is |
|---|---|
| `config/config.yaml` | The model fleet, fallback chains, semantic cache, budgets |
| `router/` | Thompson sampling strategy, judge-based rewards, policy snapshots, shadow mode |
| `infra/` | Deployment: the official AWS guidance plus what it does not cover |
| `dashboard/` | FastAPI data plane - `/state`, `/spend`, SSE stream |
| `dashboard-web/` | Next.js + shadcn live dashboard |
| `loadgen/` | Async load generator with a mixed prompt pool |
| `scripts/` | Demo choreography, reset, smoke test, rehearsal harness |
| `handoff/` | Talk artifacts: branch decision, architecture, deploy lessons, test reports |

---

## Run it locally in about five minutes

No AWS account needed for this path. A mock provider stands in for Bedrock, so
the gateway, the router, the judge loop and the dashboard are all exercised for
real - only the model text is synthetic.

**Requires:** Docker, Python 3.11+, Node 20+.

```bash
git clone https://github.com/Gyurmatag/adaptive-llm-gateway-aws.git
cd adaptive-llm-gateway-aws
cp config/.env.example config/.env
```

Start the mock provider (leave it running):

```bash
python3 -m venv .venv && ./.venv/bin/pip install -q fastapi "uvicorn[standard]" httpx pyyaml
./.venv/bin/python scripts/mock_provider.py --port 9100
```

In a second terminal, start the stack:

```bash
CONFIG_FILE=./config/config.mock.yaml LITELLM_MASTER_KEY=sk-local-demo docker compose up -d
```

Wait for the gateway to report `[thompson] installed`:

```bash
docker compose logs -f gateway | grep thompson
```

Send it traffic:

```bash
GATEWAY_BASE_URL=http://localhost:4000 LITELLM_MASTER_KEY=sk-local-demo \
  LOADGEN_MODEL=demo-router ./.venv/bin/python loadgen/run.py --rate 3
```

Open the standby dashboard at <http://localhost:8080>, or the branded one:

```bash
cd dashboard-web && npm install
echo "NEXT_PUBLIC_DATA_PLANE_URL=http://localhost:8080" > .env.local
npm run dev
```

Watch the Beta curves separate at <http://localhost:3000>, then kill the model
that is taking the most traffic and watch them re-sort with the error counter
holding at zero:

```bash
LITELLM_MASTER_KEY=sk-local-demo ./scripts/kill_primary.sh
```

Reset between runs:

```bash
LITELLM_MASTER_KEY=sk-local-demo ./scripts/reset_demo.sh
```

---

## Deploy it to AWS - roughly a day, and budget for IAM

Longer than the local path, and the deployment is where the real problems are.
[`infra/DEPLOY.md`](infra/DEPLOY.md) is the runbook, written while deploying
rather than afterwards, including what broke.

**Cost first, before anything else runs.** `infra/bootstrap.sh` refuses to
continue without `BUDGET_ALERT_EMAIL` set, and creates the budget cap and
billing alarm as its first action. This is deliberate: the stack runs for days
before a talk and Aurora plus ElastiCache plus ECS plus an ALB is a real
monthly line item.

```bash
export AWS_PROFILE=awsday AWS_REGION=eu-central-1
export BUDGET_ALERT_EMAIL=you@example.com
./infra/bootstrap.sh
```

That sets the budget cap, verifies Bedrock model access per region (and tells
you which other regions have the models if yours does not), and creates the two
Intelligent Prompt Router ARNs.

Then deploy the gateway from the official AWS guidance:

```bash
cd infra/upstream && ./deploy.sh
```

Then point the demo at it and verify:

```bash
export GATEWAY_BASE_URL=https://<your-alb-dns-name>
./scripts/smoke_test.sh
```

**Tear it down when you are done.** This is the step people skip:

```bash
./infra/teardown.sh
```

---

## The two serving modes, and which one a bank would run

The demo runs in **learn mode**, where the posteriors update live in the
request path. That is what makes the curves move on stage, and it is not what
you would ship to a regulated environment.

**Snapshot mode** is the production path: learning happens offline from logs,
the output is a content-hashed versioned policy artifact, and serving is
deterministic.

```bash
./.venv/bin/python -m router.policy export   # freeze current posteriors
ROUTER_MODE=snapshot docker compose up -d gateway
```

Shadow mode logs the choice the router *would* have made while the incumbent
keeps serving, so promotion is a decision made on evidence:

```bash
ROUTER_SHADOW=true ROUTER_INCUMBENT=claude-sonnet docker compose up -d gateway
./.venv/bin/python -m router.shadow          # counterfactual report
```

The report deliberately separates the cost delta from the quality claim. A
router that only spent less is not a smarter router.

---

## Known limits, stated plainly

- **It is a context-free bandit.** It learns which model suits your overall
  traffic mix, not which model suits each prompt. If 80% of your traffic is
  easy, it converges to the cheap model and the hard 20% degrades quietly. Set
  `ROUTER_STRATIFY=true` for per-task-class posteriors, or move to a contextual
  bandit. LiteLLM's built-in adaptive router already does this properly across
  7 request types.
- **Semantic caching is a trap on multi-turn traffic.** Consecutive turns embed
  at roughly 0.99 similarity, so every turn matches the previous one and the
  agent replays a stale response. Single-shot prompts only.
- **Streaming requests contribute cost but no quality signal**, because judging
  them would mean consuming the iterator.
- **The custom routing extension point is SDK-only.** `routing_strategy: custom`
  is rejected by the proxy; `router/proxy_hook.py` installs it at runtime. See
  `infra/DEPLOY.md`.

---

## Licence

MIT. See [LICENSE](LICENSE).
