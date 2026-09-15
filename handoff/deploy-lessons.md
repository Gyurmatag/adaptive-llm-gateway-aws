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

## Two more, found the day before the talk

- **The circuit breaker starved an arm for an entire rehearsal, in silence.**
  `kill_primary.sh` writes the killed arm into a `DISABLED` file. `reset_demo.sh`
  clears it, but only at the *start* of a run - and the kill drill is the
  second-to-last beat. So a finished run leaves the breaker dirty, and the next
  one begins with an arm already switched off. The router then withheld
  `ipr-nova` from every selection while the dashboard kept drawing it with the
  posterior it had when it was killed. It read as an under-observed arm, not a
  disabled one.

  The damage: 0 selections out of 99, observations frozen at 31 while every
  other arm climbed past 120, and a convergence check reporting
  `separated=False minobs=36` for a reason that had nothing to do with the
  bandit. Two rehearsals were spent tuning gamma and the exploration floor to
  fix a arm that was simply turned off.

  Fixed three ways, because one was clearly not enough: the router now prints a
  throttled warning and writes a `breaker_active` audit event whenever it
  withholds an arm; `/state` carries `disabled_arms` plus a per-arm `disabled`
  flag so the panel can never again render "off" as "quiet"; and the rehearsal
  asserts a clean breaker after the reset and restores it after the kill drill.

- **Build for the architecture Fargate actually runs.** The task definition
  is `cpuArchitecture: ARM64`. The image had always been built natively on an
  Apple Silicon laptop, so it happened to be right. Adding `--platform
  linux/amd64` to "be safe" broke it twice over: the legacy builder produced
  layers ECR served but Fargate could not extract
  (`CannotPullContainerError: wrong diff id`), and once `buildx` produced a
  *valid* amd64 image, the task died with `exec format error` instead. Two
  different failures, neither naming the architecture.

  Colima ships no `buildx` plugin, so install it and pin the platform
  explicitly rather than relying on the host arch:

  ```bash
  docker buildx build --platform linux/arm64 --provenance=false --push \
    -f infra/gateway.Dockerfile -t "$REPO:$TAG" .
  ```

  Verify before deploying, because neither error message will tell you:

  ```bash
  docker buildx imagetools inspect --format '{{.Image.Platform}}' "$REPO:$TAG"
  ```

---

## The honest framing for the beat

Every one of these failed **silently**. None of them threw an error that named
the actual problem. That is the argument for the audit log, for shadow mode and
for a dashboard that shows observation counts rather than just curves - and it
is an argument made by having been bitten, not by having read a best-practices
list.
