# Architecture as actually deployed

**For slides 12 and 20.** Draw from this, not from section 5's prose. Box list,
arrows and the maturity label per box, exactly as built.

The maturity colours are **paired with a text label**, because the colour coding
has to survive colour blindness and a projector that eats saturation.

---

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

  +------------------+        SSE + JSON        +--------------------+
  | Amplify Hosting  |<-------------------------| ECS: dashboard     |
  | Next.js + shadcn |   browser -> ALB direct  | FastAPI data plane |
  | (static only)    |   NOT via Next.js        | /state /spend      |
  +------------------+                          +--------------------+
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
| Dashboard data plane | **Amber** | `self-built` | Demo instrumentation, not a product |
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
- Judge sample rate **0.5** for the demo, tuned down in production.
