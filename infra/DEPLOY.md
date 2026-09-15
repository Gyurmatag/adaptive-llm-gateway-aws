# Deployment runbook

Written **while** deploying, not afterwards. The failures below are the real
ones, in the order they happened, with the actual error strings - they are the
content for the "what actually bit me" beat on slide 19, and a runbook
reconstructed from memory a week later is fiction.

---

## Order of operations

The order matters and is not arbitrary.

1. **Cost controls first.** `infra/bootstrap.sh` refuses to run without
   `BUDGET_ALERT_EMAIL` and creates the budget cap and billing alarm as its
   first action, before anything can spend money. The stack runs for days
   before a talk.
2. **Model access check second.** It fails in ways that look like configuration
   errors, so verifying it before deploying saves hours of debugging the wrong
   layer.
3. **Prompt routers third**, because their ARNs go into the gateway config.
4. **Then** the upstream guidance stack.
5. **Then** the dashboard service and the ALB tuning.

```bash
export AWS_PROFILE=awsday AWS_REGION=eu-central-1
export BUDGET_ALERT_EMAIL=you@example.com
./infra/bootstrap.sh
cd infra/upstream && ./deploy.sh
```

---

## Sizing: the guidance defaults are production defaults

The upstream `.env.template` is sized for production and would cost several
hundred dollars a month. For a demo that runs for days, override:

| Setting | Upstream | Demo | Why |
|---|---|---|---|
| `DESIRED_CAPACITY` / `MIN_CAPACITY` | 2 / 2 | 1 / 1 | Stage load is ~3 req/s |
| `ECS_VCPUS` | 2 | 1 | Not 3000 req/s |
| `RDS_INSTANCE_CLASS` | db.t3.small | db.t4g.micro | Keys and spend rows only |
| `REDIS_NUM_CACHE_CLUSTERS` | 2 | **2 - cannot be lowered** | See below |

**`REDIS_NUM_CACHE_CLUSTERS` cannot actually be lowered.** Setting the
documented cost knob to 1 fails at plan time:

```
Error: "num_cache_clusters": must be at least 2 if automatic_failover_enabled is true
  with module.base.aws_elasticache_replication_group.redis,
  on modules/base/redis.tf line 54
```

The knob and the module's hard-coded `automatic_failover_enabled = true` are
coupled, and the module does not expose the failover flag. Either run two cache
nodes or patch the module. Two `cache.t4g.micro` nodes is the cheaper answer
than a local fork for a short-lived demo.

The sleeper cost is **NAT gateways**, roughly 32 USD/month each before data
charges, and the VPC pattern creates one per AZ. Check how many you got.

---

## What actually broke

### 1. `routing_strategy: custom` is rejected by the proxy

The headline finding, and the one that changes the talk.

```
ValueError: Invalid routing_strategy: 'custom'. Valid options:
['simple-shuffle', 'least-busy', 'latency-based-routing',
 'cost-based-routing', 'usage-based-routing-v2', 'usage-based-routing',
 'provider-budget-routing']
```

`Router.set_custom_routing_strategy()` is an **SDK** call. The proxy never
invokes it, and there is no YAML key for it. The official AWS guidance deploys
the proxy. So the documented custom-routing extension point is not reachable
from the deployment path AWS publishes.

**The irony worth naming on stage:** the brief predicted "SDK-only" would be the
*built-in adaptive router's* limitation. It is not - that one configures from
proxy YAML perfectly well. It is the **custom** extension point that is SDK-only.

Fix: `router/proxy_hook.py`, loaded as an ordinary callback, waits for the proxy
to build its Router and installs the strategy onto it.

### 2. The proxy rebuilds its Router on `POST /model/update`

Which is exactly what `scripts/kill_primary.sh` calls for Demo 4.

A one-shot install would have silently dropped both the custom strategy and the
reward wrapper **at the most important moment of the talk**, leaving the gateway
serving with `simple-shuffle` and a dashboard showing frozen posteriors. Nothing
would have errored.

Fix: the installer is a watchdog, not a one-shot. It re-arms whenever the live
Router is not the object it patched.

### 3. Addressing a model by name bypasses the router entirely

LiteLLM routes **within** a group of deployments that share a `model_name`.
Every model initially had a unique name, so there was no group and the bandit
never chose anything.

Fix: the `demo-router` group, with every arm also listed individually so Demo 1
can still address them by name. Set `model_info.id` explicitly per arm or
LiteLLM generates uuids and every dashboard curve is labelled with a 64-char
hash - which is exactly what happened on the first run.

Related: only observe traffic that went through the group. Demo 1's direct
calls were creating junk arms in the posteriors.

### 4. The semantic cache: four failures stacked on top of each other

Each one produced a different wrong symptom, and none of them said "the cache
is misconfigured".

**a. `valkey-semantic` is not a cache type in this build.** Valid types are
`local, redis, redis-semantic, s3, disk, qdrant-semantic, azure-blob, gcs`.

**b. `redis-semantic` needs the RediSearch command set.** Plain
`valkey/valkey:8-alpine` does not have it, and `valkey/valkey-extensions:8.1`
ships only the bloom module. The local standby now runs
`redis/redis-stack-server`. **The deployed equivalent is ElastiCache for Valkey
with the `valkey-search` module enabled on the engine version - check this
before you deploy, not after.**

**c. `host`/`port` is not enough:**

```
ValueError: Missing required Redis configuration: REDIS_PASSWORD.
Provide REDIS_PASSWORD or redis_url.
```

Use `redis_url`. Note this failure takes the **whole gateway** down at startup,
not just the cache.

**d. The embedding model must be provider-qualified:**

```
ValueError: Invalid embedding method: litellm.BadRequestError:
LLM Provider NOT provided. You passed model=embed
```

The semantic cache calls `litellm.embedding()` **directly**, not through the
Router, so a `model_list` entry name cannot resolve. It needs
`bedrock/amazon.titan-embed-text-v2:0`. It must also be an *embedding* model -
pointing it at the judge (a chat model) looks plausible and fails at runtime.

Working result:

```
first ask   : 385 ms
reworded ask:  40 ms
x-litellm-semantic-similarity: 0.760638833046
```

### 5. The reward loop was silently dead

Two independent bugs, both invisible: 585 routing decisions, zero posterior
updates, and a dashboard that looked alive because traffic was flowing.

**a. LiteLLM's callbacks never fired on the routed path.** Both
`litellm_settings.callbacks` and `success_callback` register cleanly - the proxy
even logs `Initialized Success Callbacks` - but neither hook is invoked on the
proxy's routed request path in this build. Verified by auditing on hook entry.
Fix: wrap `Router.acompletion`, which we already own via the install shim.

**b. `asyncio.create_task()` with no strong reference.** The reward task was
being garbage collected before it ran. Fix: hold the tasks in a set.

**c. The judge was called as `litellm.acompletion(model="judge")`**, which
cannot resolve a Router group name, failing with `LLM Provider NOT provided` -
swallowed by the judge's own except clause. Fix: call through the Router's
original (unwrapped) `acompletion`, so it neither fails nor recurses.

**Lesson worth stating on stage:** every one of these failed *silently*. A
routing layer that cannot prove it is learning is indistinguishable from one
that is. That is the argument for the audit log and for shadow mode, made the
hard way.

### 6. The official AWS guidance no longer deploys on a new account

The single most surprising failure, and the one most worth a sentence on stage.

```
Error: creating AWS Service Catalog AppRegistry Application (...):
api error AccessDeniedException: AWS Service Catalog AppRegistry is in
maintenance mode and is no longer available to new customers as of
July 30, 2026.
```

The guidance creates a Service Catalog AppRegistry application to track the
solution's resources. That service stopped accepting new customers on
30 July 2026, so on any account created after that date the official AWS
Terraform fails at apply time. Nothing else in the stack references the
resource - it is pure solution-tracking metadata - so `infra/patch-upstream.py`
removes it.

**Why this is a patch script and not a hand edit:** `infra/upstream/` is
fetched, so a manual change is silently lost on the next fetch and takes the
deployment with it. `fetch-upstream.sh` runs the patcher every time.

*Worth saying out loud, because it is the talk's own argument turning on
itself: "deploy, don't build" is right, and the thing you deploy still rots.
Official guidance is a starting point with a maintenance burden, not a
guarantee.*

### 7. Transient DNS failures mid-apply

```
Error: creating S3 Bucket (...): request send failed,
  dial tcp: lookup ...s3.eu-central-1.amazonaws.com: no such host
Error: creating Secrets Manager Secret (...): request send failed,
  dial tcp: lookup secretsmanager.eu-central-1.amazonaws.com: no such host
```

Local DNS, not AWS. Terraform surfaces it as a resource creation error, which
reads like a permissions or naming problem. Re-running the apply cleared it.
Worth knowing before debugging the wrong layer - and worth remembering on a
conference network.

### 8. The budget block is a 400, not a 429

Virtual key budgets are enforced, but the response is:

```json
{"error": {"message": "Budget has been exceeded! Current cost: 0.00080844, Max budget: 0.0008",
           "type": "budget_exceeded", "code": "400"}}
```

**HTTP 400 with `type: budget_exceeded`.** The talk plan says the key "starts
returning 429". It does not. Saying 429 from the stage would be contradicted by
the screen behind you.

Also worth knowing before choosing a number: measured cost on this fleet is
roughly **$0.000046 per request**, so a literal $5 budget needs about 100,000
requests. A stage-usable budget is a few ten-thousandths of a dollar. Frame it
as "a key with a small budget", not "a $5 key", unless the key has been
accumulating spend since minute 2.

Spend tracking is also slightly behind enforcement: the key showed
`spend=0.000642` against `max_budget=0.0008` on the request that was blocked,
because the blocking check uses a more current figure than `/key/info` reports.

### 9. Streaming and the ALB idle timeout

LiteLLM warns to keep `KEEPALIVE_TIMEOUT` **above** the load balancer idle
timeout or streams get cut mid-flight. These are a matched pair:

- `infra/terraform/variables.tf` -> `alb_idle_timeout_seconds = 120`
- `config/config.yaml` -> `general_settings.keepalive_timeout: 130`

The same timeout governs the dashboard's SSE connection. Tune it once, verify
it for both. The SSE stream sends a comment heartbeat every tick so a quiet
dashboard is never reaped during a slow slide.

---

## Verify

```bash
export GATEWAY_BASE_URL=https://<your-alb-dns-name>
./scripts/smoke_test.sh
```

Checks liveness, the model list, one completion per arm, the
`bedrock/converse/` ARN path, streaming, and the dashboard data plane.

## Tear down

```bash
./infra/teardown.sh
```

Leaves the budget and billing alarm in place on purpose. Verify in Cost
Explorer the following week that spend actually went to zero.
