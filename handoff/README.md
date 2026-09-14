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
| `branch-decision.md` | Slide 16 second half, slides 11 and 20 motif markers | **Ready.** Branch B, decided on question 2. Includes the exact 5-beat script for slide 16. |
| `architecture.md` | Slides 12 and 20 | **Ready.** Box list, arrows, maturity label per box, paired with text labels for colour blindness. |
| `deploy-lessons.md` | Slide 19 first half | **Ready.** Three lessons with the real error strings, plus backups. |
| `demo-timings.md` | Run of show validation | **Partial.** Local numbers measured. Deployed numbers pending. |
| `e2e-test-report.md` | **Blocking gate** | **Partial.** One full run against the local stack, with real numbers. The second run and the hotspot run need the deployed stack. |
| `preflight-checklist.md` | Pre-flight | **Ready.** Section 12 walked, with what is done vs blocked. |
| `repo-url.txt` | Slide 21 QR | **Ready but PRIVATE.** URL is final; the repo must be flipped public before the talk. |
| `dashboard-url.txt` | Pre-flight, slide 17 | **Blocked.** Amplify needs AWS credentials. |
| `dashboard-converged.png` | Slide 17 planning, speaker notes | **Local capture.** From the real Next.js + shadcn app in the Shiwaforce brand, against live converging data. Not from Amplify. |
| `dashboard-failover.png` | Slide 17 planning | **Local capture.** The moment after the kill switch, error counter at zero. |
| `ecs-console.png` | Slide 12 | **Blocked.** Needs a running ECS service. |

---

## What is blocked, and why

The AWS account has no IAM user and no Identity Center user, so there is no
credential the CLI can use. That blocks the deployment, Amplify, the ECS
console screenshot, and the second rehearsal run against the deployed stack.

Everything that does not require AWS is built, verified and committed.

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
