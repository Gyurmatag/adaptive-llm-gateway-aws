# Pre-flight checklist, walked through

Section 12 of the talk plan, walked once rather than read. Each line records
what was actually checked and what the result was, so the remaining items are
visible rather than assumed.

Status key: **[done]** verified now - **[blocked]** needs AWS - **[on the day]**
cannot be done in advance.

---

## The day before

| Item | Status | Evidence / what to do |
|---|---|---|
| Repo public and scrubbed | **[open]** | Repo exists, populated, 16 commits, MIT. Still PRIVATE. Scrub verified clean of account IDs and ARNs (see below). Flip with the command in `repo-url.txt`. |
| README tested from a fresh clone | **[done]** | Cloned into an empty dir and walked the steps. Found two real breaks: 12 commits had never been pushed, and `amplify.yml` was in the wrong directory. Both fixed. 11 tests pass from the clone, `docker compose config` validates, all scripts executable. |
| Backup videos exported | **[open]** | Not recorded. Do this once the deployed stack is up - recording the local stack would show a different URL and a different dashboard origin than the audience sees. |
| Posterior / policy state saved | **[done]** | `python -m router.policy export` produces a content-hashed artifact. Tested: deterministic across a simulated restart. |
| Snapshot-mode path verified | **[done]** | Covered by `tests/test_router.py::test_snapshot_mode_is_deterministic_across_restarts`. Testing it found a real bug: snapshot mode with no artifact silently fell back to the live bandit. Now warns loudly and serves deterministically. |
| Deployed stack health-checked end to end | **[blocked]** | `scripts/smoke_test.sh` is written and runs against whatever `GATEWAY_BASE_URL` points at. |
| Local standby started and verified | **[done]** | Full stack runs under `docker compose`. Demo 1, Demo 2, routing, failover and the dashboard all verified against it. |
| AWS budget alarm confirmed | **[blocked]** | `infra/bootstrap.sh` creates it as its FIRST action and refuses to run without `BUDGET_ALERT_EMAIL`. |
| Deck exported to PDF | **n/a** | Cowork owns the deck. |
| Every screenshot checked for account identifiers | **[done for what exists]** | The only screenshots so far are of the local dashboard, which contains no account data. `ecs-console.png` is blocked. |

## The morning of

| Item | Status |
|---|---|
| Hit the deployed gateway once from the venue network | **[on the day]** |
| Confirm the ALB responds and streaming works | **[on the day]** - `scripts/smoke_test.sh` covers both |
| Confirm the load generator can reach it | **[on the day]** |
| Open the Amplify dashboard from the venue network, confirm SSE connects and curves move | **[on the day]** - the single most important morning check |

## In the room

| Item | Status |
|---|---|
| Projector resolution checked with the dashboard open, not just the deck | **[on the day]** |
| Standby dashboard opened once and verified | **[done locally]** - `dashboard/static/index.html`, plain, no build step |
| Font sizes verified from the back row | **[partly done]** - verified at 1600x900 and at 375px. Two defects found and fixed this way: the savings counter clipped at fixed size, and three curve labels overlapped into unreadable text. The back-row walk itself is still an on-the-day item. |
| Hotspot tested | **[on the day]** - and one full rehearsal must run on it |
| Load generator started and verified | **[on the day]** |
| Local standby running, one env var away | **[done]** - `GATEWAY_BASE_URL` is the only switch |
| Terminal font size raised, history cleared | **[on the day]** |
| Notifications and Slack silenced | **[on the day]** |
| Laptop on mains power | **[on the day]** |
| Second terminal pre-positioned for the kill switch | **[on the day]** - `scripts/kill_primary.sh` auto-selects the current traffic leader, so no argument to remember under pressure |

---

## Scrub verification

Run before flipping the repo public, and again before the talk:

```bash
# \b matters: without word boundaries this matches 12-digit runs inside
# floating point numbers (token costs, similarity scores) and buries the
# real hits in noise.
grep -rEn '\b[0-9]{12}\b|arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:' \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.next \
  --exclude-dir=upstream --exclude-dir=.venv .
```

Current result: **clean**. The only `arn:aws:` strings in the repo are a
foundation-model ARN template (which has an empty account field by
construction) and an AWS-managed IAM policy ARN. Neither carries an account
identifier. Account IDs and ARNs never enter the repo by
construction - `bootstrap.sh` writes the prompt router ARNs to `config/.env`,
which is gitignored, and `.env.example` carries placeholders only. The one
place an account ID could leak is a screenshot, so every image in `handoff/`
needs a look before the deck uses it.

---

## Before anything else: two environment facts

1. **Set the locale.** `LANG` and `LC_ALL` are unset on the demo machine. With
   no locale, zsh mangles non-ASCII bytes when you capture curl output into a
   shell variable - `character not in range`, three times out of nine. In front
   of a Hungarian audience, accented characters are exactly what triggers it.

   ```bash
   export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
   ```

   Also: pipe curl straight into `python3`, never through a shell variable.

2. **Demo 2 depends on a hand-registered task definition.** The semantic cache
   runs as a Redis Stack sidecar added in `litellm-stack-fargate-task:3`,
   registered by hand. Re-running the guidance's deploy script reverts the
   service to a task definition with no sidecar, and Demo 2 silently drops back
   to exact-match: repeating a question still looks fast, rewording one misses.
   Confirm before the talk:

   ```bash
   curl -sS -D- -o /dev/null -X POST "$GATEWAY_BASE_URL/v1/chat/completions" \
     -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' \
     -d '{"model":"nova-lite","messages":[{"role":"user","content":"Which city is Slovenia'"'"'s capital?"}],"max_tokens":80}' \
     | grep -i semantic-similarity
   ```

   It must print a similarity. If it prints nothing, the sidecar is gone.

---

## The three items that are not on the original list but should be

1. **Confirm the gateway logs `[thompson] installed` after every restart.** If
   it does not, the gateway is serving with `simple-shuffle` and the whole
   router demo is a lie that no error message will reveal. One `docker compose
   logs gateway | grep thompson` before starting.

2. **Confirm the dashboard's request count is zero after `reset_demo.sh`.**
   Reset silently did nothing for two rehearsals, and the second run started
   with the first run's numbers already on the board. `reset_demo.sh` now
   prints the dashboard's count so this is visible rather than assumed.

3. **Confirm the circuit breaker is empty before you start.** One line:

   ```bash
   curl -sS "$DASHBOARD_BASE_URL/state" | python3 -c \
     "import json,sys;print(json.load(sys.stdin)['disabled_arms'] or 'clean')"
   ```

   It must print `clean`. If it names an arm, that arm is switched off: it will
   take no traffic, its curve will sit frozen where it was killed, and nothing
   on the dashboard will say so. This cost two rehearsals - `ipr-nova` took 0
   of 99 selections while looking merely under-observed. `kill_primary.sh`
   leaves the killed arm in the breaker, so **any run that ends with Demo 4
   leaves it dirty**. Clear it with:

   ```bash
   curl -sS -X POST "$DASHBOARD_BASE_URL/admin/enable" \
     -H "Authorization: Bearer $LITELLM_MASTER_KEY"
   ```

   The rehearsal now does this automatically at beat 1 and after the drill, but
   if you ran a demo by hand, check it yourself.

   **Same command, second field: `withheld_arms`.** That is the *other* way an
   arm goes quiet - LiteLLM cooling a deployment down after failures, which on a
   bad network it will do repeatedly. On the hotspot rehearsal that kept
   `ipr-nova` out of routing for nine minutes while the error count stayed at
   zero. It clears itself when the link settles; nothing to fix, but know which
   one you are looking at:

   ```bash
   curl -sS "$DASHBOARD_BASE_URL/state" | python3 -c \
     "import json,sys;d=json.load(sys.stdin);print('disabled',d['disabled_arms'],'withheld',d['withheld_arms'])"
   ```

   `disabled` is yours and needs clearing. `withheld` is LiteLLM's and needs
   patience. If a curve stops moving on stage, this is the first thing to check,
   and the gateway log says it in words: `[thompson] LiteLLM is withholding ...`.
