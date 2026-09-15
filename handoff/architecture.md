# Architecture as actually deployed

**For slides 12 and 20.** Draw from this, not from section 5's prose. Box list,
arrows and the maturity label per box, exactly as built.

The maturity colours are **paired with a text label**, because the colour coding
has to survive colour blindness and a projector that eats saturation.

---

## What actually got deployed, versus the plan

Four things changed between the brief's architecture and the one that is
running. All four are worth knowing before drawing slide 12.

| Planned | Deployed | Why |
|---|---|---|
| Browser -> ALB directly | Browser -> **CloudFront** -> ALB | The ALB is http-only and the Amplify page is https. The stack's own CloudFront distribution is the https front door, and the ALB actively refuses direct access. |
| Dashboard as a second ECS service | Dashboard **mounted on the gateway** at `/dash` | The posteriors are in-process state. Two Fargate tasks share no filesystem, so a separate service would have served an empty state forever while looking healthy. |
| ElastiCache for Valkey + semantic cache | ElastiCache Redis, **exact-match cache only** | ElastiCache has no RediSearch. `redis-semantic` kills the gateway at startup with nothing in the logs. Demo 2 runs on the local standby. |
| ECS autoscaling 1-2 tasks | **Pinned to exactly 1 task** | Two tasks means two independent belief states and a dashboard that alternates between them. |

**The last one is slide 19 content, not a footnote.** Learn mode cannot be
scaled horizontally, because the thing being learned lives in one process's
memory. Snapshot mode can. The demo runs the mode that does not scale.

## Left to right

```
  client apps                gateway                    routing            models
  (virtual keys)                                        layer

  +-----------+   HTTPS   +------------------+      +-------------+    +-----------+
  | demo      |---------->| ALB              |----->| Thompson    |--->| Bedrock   |
  | client    |           | idle timeout 120s|      | router      |    | Converse  |
  | loadgen   |           +--------+---------+      | (custom)    |    | API       |
  +-----------+                    |                 +------+------+    +-----+-----+
                                   v                        |                 |
                          +------------------+              |        +--------+--------+
                          | ECS Fargate      |              |        | Claude  Nova    |
                          | LiteLLM proxy    |              |        | GPT-on-Bedrock  |
                          | KEEPALIVE 130s   |              |        | IPR routers x2  |
                          +--+------------+--+              |        +-----------------+
                             |            |                 |
                   +---------+            +--------+        +---> judge (Nova Micro)
                   v                               v              async, sampled
          +------------------+          +--------------------+
          | Aurora Postgres  |          | ElastiCache Valkey |
          | virtual keys,    |          | semantic cache     |
          | teams, spend     |          | + valkey-search    |
          +------------------+          +--------------------+

  +------------------+                         +--------------------+
  | Amplify Hosting  |   SSE + JSON, browser   | CloudFront (https) |
  | Next.js + shadcn |------------------------>| -> ALB -> ECS      |
  | STATIC export    |   never via Next.js     | /dash/state        |
  | (no compute)     |                         | /dash/spend        |
  +------------------+                         | /dash/stream       |
                                               +--------------------+
     the dashboard data plane is MOUNTED ON THE GATEWAY, not a separate
     service - same process, same origin, so no CORS pinning is needed
```

---

## Boxes and maturity labels

| Box | Maturity | Label to print | Why |
|---|---|---|---|
| ALB | **Green** | `official guidance` | Straight from the AWS Terraform |
| ECS Fargate + LiteLLM proxy | **Green** | `official guidance` | The guidance's own deployment path |
| Aurora Postgres | **Green** | `official guidance` | Virtual keys, teams, spend |
| ElastiCache for Valkey | **Green** | `official guidance` | With the `valkey-search` module |
| Bedrock Converse API | **Green** | `GA AWS service` | Production by definition |
| Bedrock IPR routers (x2) | **Green** | `GA AWS service` | GA since 22 April 2025 |
| Semantic cache | **Green** | `in the box` | LiteLLM feature, config only |
| Virtual keys and budgets | **Green** | `in the box` | LiteLLM feature, config only |
| **Thompson router** | **Amber** | `self-built, conditions apply` | Production-validated *technique*, self-built *component*. Slide 19 lists the conditions |
| **Judge loop** | **Amber** | `self-built` | The reward channel. The reason branch B exists |
| **proxy_hook shim** | **Amber** | `self-built, undocumented seam` | The custom extension point is SDK-only; see below |
| Dashboard data plane | **Amber** | `self-built` | Demo instrumentation, not a product. Mounted on the gateway process |
| CloudFront | **Green** | `official guidance` | The https front door; the ALB refuses direct access |
| Amplify Hosting (UI) | **Green** | `managed` | Static hosting only, no live data path |

**One amber cluster, and it is exactly the routing layer.** Every green box is
either official AWS guidance or a documented LiteLLM feature. That is the whole
point of slide 20: one build marker on the diagram.

---

## Three arrows that carry an argument

**1. Browser to ALB, bypassing Amplify.** Amplify Hosting runs Next.js but
**Next.js streaming is on its unsupported features list**, so the SSE stream
never goes through a Next.js route. Amplify serves static UI; the browser opens
the stream directly against the FastAPI service through the ALB. This is why
the dashboard needs a pinned CORS origin.

**2. The judge arrow points sideways, not through the request path.** It is
asynchronous and sampled. The user's request never waits for it.

**3. IPR routers are ordinary deployments inside the gateway.** This is the
"they compose" answer to *how is this different from Intelligent Prompt
Routing*: IPR router ARNs are arms in the bandit's own candidate set, reached
through the `bedrock/converse/` route because the plain `bedrock/` route does
not parse ARNs.

---

## The seam worth one line on slide 19

The proxy rejects `routing_strategy: custom`. The custom routing extension point
is reachable from the SDK only, and the official AWS guidance deploys the proxy.
`router/proxy_hook.py` bridges that gap, and re-arms itself because the proxy
rebuilds its Router on `POST /model/update` - which is what the kill switch
calls.

Draw it as a small amber connector between the gateway box and the router box,
not as its own box. It is a seam, not a component.

---

## Two numbers for the diagram

- ALB idle timeout **120s**, LiteLLM `KEEPALIVE_TIMEOUT` **130s**. A matched
  pair. Governs streaming completions and the dashboard SSE identically.
- Judge sample rate **0.5**, judge threshold **0.85**, gamma **0.10**. All
  measured, not guessed - see handoff/e2e-test-report.md.
- **Exactly one ECS task.** Not a sizing choice; a correctness one.

## Verified on the deployed stack

- Demo 1 through CloudFront -> ALB -> ECS -> Bedrock: 1375ms / 363ms / 725ms
- Streaming: 24 chunks in 770ms through the ALB
- **SSE streams through CloudFront**, first byte 0.06s, not buffered
- Amplify page connects to `/dash/stream` and shows live state
