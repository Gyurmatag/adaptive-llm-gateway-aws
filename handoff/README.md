# handoff/

Everything Cowork needs for the deck. Section 6.9 of `talk-plan-v10.md` is the
manifest; this is the status of each item.

**Read `branch-decision.md` first.** It corrects a factual claim in section 8
of the brief that would otherwise be repeated from the stage, and it changes
the wording of the motif marker on the routing layer.

---

## Manifest status

| File | Feeds | Status |
|---|---|---|
| `branch-decision.md` | Slide 16, slides 11/20 markers | **Ready.** Branch B on question 2, with the 5-beat script for slide 16. |
| `architecture.md` | Slides 12 and 20 | **Ready.** Updated to what actually deployed, which differs from the plan in four ways. |
| `deploy-lessons.md` | Slide 19 first half | **Ready.** Pick 2-3; `infra/DEPLOY.md` has twelve with verbatim errors. |
| `demo-timings.md` | Run of show | **Measured.** |
| `e2e-test-report.md` | **Blocking gate** | **Partially cleared.** Three full runs with real numbers, incl. the deployed stack. Hotspot run NOT executed. |
| `preflight-checklist.md` | Pre-flight | **Ready.** |
| `recording-shotlist.md` | Backup videos | **Ready** - but the recordings themselves need a human. |
| `repo-url.txt` | Slide 21 QR | **Ready. PUBLIC.** CI green. |
| `dashboard-url.txt` | Slide 17, pre-flight | **Ready. LIVE**, connected to the deployed stack. |
| `dashboard-converged.png` | Slide 17 | Local stack, mock provider, four separated curves. |
| `dashboard-failover.png` | Slide 17 | Local stack, after the kill switch. |
| `dashboard-real-bedrock.png` | Slide 17 | Local gateway, **real Bedrock models**. The honest cluster. |
| `dashboard-deployed.png` | Slide 17 | **Live Amplify URL against the deployed stack.** 1300 requests, $2.29 saved, 0 errors. |
| `dashboard-deployed-failover.png` | Slide 17 | Deployed stack after the kill switch. |
| `ecs-console.png` | Slide 12 | **MISSING.** Needs a manual screen capture - see below. |

## What is blocked, and why

**Two things, both needing a human.**

**1. `ecs-console.png`.** The browser extension available to this build could
not save a screenshot to disk. The ECS service page has to be captured by
hand. Before capturing, redact the account id - paste this in the browser
console on the page:

```js
const A=/\b\d{12}\b/g;const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
const t=[];while(w.nextNode()){if(A.test(w.currentNode.nodeValue))t.push(w.currentNode);A.lastIndex=0;}
t.forEach(n=>n.nodeValue=n.nodeValue.replace(A,'<ACCOUNT-ID>'));
document.querySelectorAll('[data-testid="awsc-nav-account-menu-button"],#nav-usernameMenu')
  .forEach(e=>e.style.visibility='hidden');
```

The shot wants: service **Active**, **1 running | 0 pending**, and the load
balancer target health table showing **1 Healthy / 0 Unhealthy**.

**2. The hotspot rehearsal.** The machine has to be moved onto a mobile
hotspot. This matters more than it usually would: the office network dropped
out completely during this build, taking a Terraform apply and a git push with
it. Everything else has been run three times; this has been run zero.

**What this means for the deck.** Nothing structural. `branch-decision.md` and
`architecture.md` are the two structural gates in section 6.9 and both are
ready. The blocked items affect content, not slide structure:

- Slide 12 wants a small scrubbed ECS console screenshot in a corner. Until it
  exists, leave the corner empty rather than substituting a stock image - the
  whole point of that screenshot is that it is real.
- Slide 17's planning can use the local dashboard captures. The audience sees
  the same UI; only the hostname differs.

---

## The one correction the deck must carry

Section 8 of `talk-plan-v10.md` says LiteLLM's adaptive router is SDK-only and
that proxy YAML is wired only for the complexity router.

**That is stale.** The adaptive router configures from proxy YAML, requires
Postgres, is cost-aware through explicit quality/cost weights, exposes per-arm
state over an HTTP endpoint, and returns `x-litellm-adaptive-router-model`.

Saying "it's SDK-only" from the stage would be the most checkable false claim
in the talk, in the exact segment where the speaker is claiming credit for
having tested the built-in option honestly.

The real answer to "doesn't LiteLLM already have an adaptive router?" is in
`branch-decision.md`: it does, it is good, it is Thompson sampling like ours,
and the gap is the **reward channel** - it learns from implicit user
satisfaction and there is no documented way to feed it a programmatic quality
score. Back-office traffic has no user to read satisfaction from.

And the genuinely humbling part, which is the strongest credibility beat
available: **the built-in router stratifies by request type and ours does not**,
which is the exact failure mode slide 19 calls the critical correctness issue.
