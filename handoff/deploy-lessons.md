# Deploy lessons

**For slide 19, first half.** Extracted from `infra/DEPLOY.md`. Two or three of
these, one sentence each, delivered flat. Pick by what the room is.

Full detail and the verbatim error strings are in `infra/DEPLOY.md`.

---

## The three to use

**1. The documented extension point was not reachable from the deployment path.**
LiteLLM's custom routing strategy is an SDK call. The proxy rejects
`routing_strategy: custom` outright, and the official AWS guidance deploys the
proxy. A shim installs the strategy onto the running Router instead.

> Best line: *the brief I wrote for myself predicted "SDK-only" would be the
> built-in router's limitation. It was the opposite. The built-in one
> configures from YAML fine. It was my own extension point that could not be
> deployed the way AWS deploys this.*

**2. The kill switch would have silently disabled the router.**
`POST /model/update` makes the proxy rebuild its Router, which drops any
runtime-installed strategy. The failover demo would have "worked", the error
counter would have stayed at zero, and the gateway would have been
round-robining with a dashboard showing frozen curves. Nothing would have
errored. The installer had to become a watchdog.

> This is the one to tell. It is specific, it is a near-miss, and it lands the
> point that a routing layer which cannot prove it is learning is
> indistinguishable from one that is not.

**3. The semantic cache failed four times in a row, each with a different wrong
symptom.** The cache type did not exist in the pinned build; the backend needed
a Redis search module the Valkey image did not ship; `host`/`port` was rejected
in favour of `redis_url` and the failure took the *whole gateway* down at
startup; and the embedding model had to be provider-qualified because the cache
calls `litellm.embedding()` directly rather than through the Router.

> Short version for stage: *four config lines, four different failure modes,
> and only one of them said anything about caching.*

---

## Backups if the room wants infrastructure rather than software

- **The guidance defaults are production defaults.** Two ECS tasks at 2 vCPU,
  `db.t3.small`, two cache clusters. For a demo that runs for days that is the
  difference between tens and hundreds of dollars. The sleeper is NAT gateways,
  one per AZ.
- **ElastiCache engine version is a gate, not a detail.** The semantic cache
  needs the `valkey-search` module enabled on the engine version. Check before
  deploying.
- **`KEEPALIVE_TIMEOUT` must exceed the ALB idle timeout** or streams get cut
  mid-flight - and the same timeout governs the dashboard's SSE connection.
  120s and 130s here.

---

## The honest framing for the beat

Every one of these failed **silently**. None of them threw an error that named
the actual problem. That is the argument for the audit log, for shadow mode and
for a dashboard that shows observation counts rather than just curves - and it
is an argument made by having been bitten, not by having read a best-practices
list.
