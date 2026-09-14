# Branch decision: the four-question test

**Decided:** 14 September 2026
**Outcome:** **Branch B** - custom Thompson sampling strategy via `CustomRoutingStrategyBase`,
with LiteLLM's built-in adaptive router shipped alongside it, configured and switchable on stage.
**Deciding question:** question 2 (reward signal). Questions 1, 3 and 4 all came back **yes**.

---

## Correction to the brief before anything else

`talk-plan-v10.md` section 8 states:

> Proxy YAML is wired for the complexity router today; the adaptive, semantic and quality
> routers still require the SDK. Verify this before finalising the demo branch, since it is
> the most likely of the four test questions to come back no.

**This is stale and must not be said on stage.** As of the current LiteLLM documentation the
adaptive router is configured from proxy `config.yaml`, requires Postgres, is cost-aware through
explicit quality/cost weights, exposes per-arm state over an HTTP endpoint, and returns an
`x-litellm-adaptive-router-model` response header. Question 1 is a clear yes.

Saying "it's SDK-only" from the stage would be the single most checkable false claim in the talk,
in the exact segment (slide 16) where the speaker is claiming credibility for having tested the
built-in option honestly. The correction matters more than the branch.

---

## The four questions, with evidence

### Q1. Can it run from proxy YAML, or is it SDK-only?

**YES - proxy YAML.** Configured entirely in `config.yaml`; no SDK required.

```yaml
model_list:
  - model_name: my-router
    litellm_params:
      model: auto_router/adaptive_router
    adaptive_router_config:
      available_models: ["model-a", "model-b"]
      weights:
        quality: 0.7
        cost: 0.3
```

Per-model declarations carry cold-start priors:

```yaml
    model_info:
      input_cost_per_token: 0.000002
      adaptive_router_preferences:
        quality_tier: 3
        strengths: ["code_generation", "analytical_reasoning"]
```

Requires LiteLLM Proxy with a Postgres database. Quality estimates persist in Postgres and reload
on startup; without a database the router still runs but forgets everything on restart. The AWS
Multi-Provider GenAI Gateway guidance already provisions Postgres for virtual keys and spend, so
this requirement costs us nothing - the database is in the architecture either way.

*Consequence for the talk: the "AWS deploys the proxy, so SDK-only is a real gap" argument in
section 6.4 does not apply. Do not use it.*

### Q2. What reward signal does it accept? <- THE NO

**NO - implicit user-satisfaction signals only. There is no documented path to inject a
programmatic quality score.**

The documented reward mechanism is a satisfaction signal inferred from the conversation itself.
The docs' own worked example is a user replying "thanks!" on a later turn, and that turn is what
moves the bandit. Attribution is retroactive and correct - feedback attributes back to the model
that actually served the previous turn, even when stateless routing picks a different model on
the next turn, which is a genuinely well-built detail.

What is absent: any documented endpoint, request header, or metadata field for posting an explicit
reward. No judge score, no guardrail verdict, no schema-validity flag, no retrieval-groundedness
score, no offline eval result.

**Two independent consequences, and both matter.**

1. **Demo-structural.** The stage demo is driven by `loadgen/run.py` against a synthetic prompt
   pool. Synthetic load has no human in it and never says "thanks!". Under demo conditions the
   built-in bandit would receive **no reward at any point in the talk** and its posteriors would
   sit at their cold-start priors for the full 30 minutes. Demo 3 is the curves separating and
   Demo 4 is the curves re-sorting after the kill switch. Neither beat can exist on a router whose
   reward channel cannot be driven. This is not a preference; the demo does not function.

2. **Production-real, and the honest generalisation.** The workloads this talk is actually about
   are back-office and batch enterprise traffic where there is no user turn to read satisfaction
   from. The available quality signal is programmatic: an LLM judge, a guardrail verdict, JSON
   schema validity, a groundedness check against retrieved context. That is the signal a bank has
   and the one the built-in router cannot currently consume. Stating it this way keeps the claim
   defensible in Q&A and keeps it from sounding like a complaint about a beta feature.

### Q3. Can you read per-arm internal state?

**YES.** `GET /adaptive_router/{router_name}/state` returns per-cell estimates:

```json
{
  "cells": [
    { "request_type": "analytical_reasoning", "model": "fast",
      "quality_mean": 0.95, "samples": 0 }
  ]
}
```

`quality_mean` is the router's current estimate for that model on that request type. `samples`
counts real observations that have moved the prior, and excludes cold-start prior mass - a
well-designed distinction, because it makes "this arm has actually learned something" directly
readable rather than inferred.

This is enough to build a dashboard on. It is a scalar mean per cell rather than the full
`(alpha, beta)` pair, so the Beta density curves in `dashboard-brief.md` section 4.1 would have
to be reconstructed or replaced with point estimates plus a sample count - visually weaker than
real densities, but workable. **Q3 is a yes and should not be cited as a reason for branch B.**

### Q4. Is it cost-aware?

**YES.** Explicit weights, which must sum to 1.0:

```yaml
      weights:
        quality: 0.7
        cost: 0.3
```

Cost per token is declared per model in `model_info.input_cost_per_token`. This is a different
parameterisation from the custom router's `score = theta / cost**gamma` but expresses the same
dial, and the built-in version is arguably the more legible of the two on a slide.

---

## Score: 3 yes, 1 no -> Branch B

Per section 6.4, any no means branch B, and the no is the justification stated on stage.

---

## What is actually built, and why it is not "we ignored the built-in one"

Both routers ship in this repo and both are reachable from `config/config.yaml`.

- `router/thompson_router.py` - the custom `CustomRoutingStrategyBase` strategy, serving the demo.
  It exists because it accepts a judge score as reward. That is the whole reason.
- The built-in adaptive router - configured as a live model group, switchable mid-talk. Slide 16
  asks for "show it being switched on", so it has to genuinely work, not be a screenshot.

The custom code is deliberately small. Provider adapters, retries, cooldowns, fallbacks, rate-limit
awareness and spend tracking all still come from LiteLLM. The extension point is supported API,
not a fork.

---

## Two things the built-in router does better, to say out loud

Volunteering these is what makes the rest of the slide credible. Both are real.

1. **It stratifies by request type and the custom router does not.** The built-in router classifies
   each request into one of 7 types and tracks each model per type independently, so a model that
   is strong on factual lookup and weak on code wins factual traffic and loses code traffic. That
   is precisely the failure mode named in `talk-plan-v10.md` section 7 point 6 - the context-free
   bandit that converges to the cheap model on an 80% easy traffic mix and silently degrades the
   hard 20%. **The built-in router already solves the correctness problem slide 19 raises, and the
   custom one mitigates it with per-task-class bandits rather than eliminating it.**

   This is the strongest honesty beat available in the talk. Slide 19 names stratification as "the
   critical correctness issue, not a nicety", and the built-in product handles it better than the
   speaker's own code. Say that.

2. **It is a supported product with a persistence story.** Postgres-backed, reloads on restart,
   maintained by someone else. The custom router's state file is the speaker's problem forever,
   which is the ownership cost from slide 6 landing on the speaker's own build.

## One thing to flag rather than discover live

`adaptive: true` alongside routing plugins **raises at config validation** - the bandit selector
does not consume plugin-narrowed candidate pools yet. Do not configure both. This is also a decent
one-line answer if anyone asks how mature the feature is.

---

## Effect on the published abstract

None, and this is a better outcome than section 6.4 anticipated. The abstract names Thompson
sampling. The custom router is Thompson sampling, and the built-in adaptive router is **also**
documented as Thompson sampling within a tier's pool. Both sides of the comparison use the same
algorithm, so the abstract stays accurate under either branch and the difference is correctly
framed as the reward channel rather than the algorithm.

That framing is also more interesting than "mine is better": same algorithm, different reward
signal, and the reward signal is what the enterprise constraint actually bites on.

---

## Motif marker for the routing layer

Exact wording for slides 11, 16 and 20:

> **build** - the reward channel

Rendered on slide 20 in the marker sequence as **build**, keeping "one build marker on the whole
diagram" intact. The qualifier is spoken, not printed, on slides 11 and 20; slide 16 is where the
qualifier earns its space.

**Slide 16 second half, the 30 second beat, in delivery order:**

1. LiteLLM ships an adaptive router. It is a bandit, it is Thompson sampling, it is configured
   from the same proxy YAML as everything else, and it is cost-aware. *(switch it on live)*
2. It learns from user satisfaction signals inferred from the conversation.
3. My traffic has no user in it. Back-office batch work has no "thanks!" turn, and neither does the
   load generator that has been running since minute 2.
4. So the one thing I built is the reward channel: a judge scores a sample of answers, and that
   score is what moves the posteriors.
5. And it beat me on one thing - it stratifies by request type out of the box, which is the exact
   failure mode on the production slide coming up.

Beat 5 is the one to protect if the segment runs long. It is the credibility, not the caveat.

---

## Sources

- LiteLLM adaptive router: https://docs.litellm.ai/docs/adaptive_router
- LiteLLM Auto Router v2: https://docs.litellm.ai/blog/autorouter-v2
- LiteLLM auto routing: https://docs.litellm.ai/docs/proxy/auto_routing
- LiteLLM routing plugins: https://docs.litellm.ai/docs/routing_plugins
