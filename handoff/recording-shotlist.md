# Backup recordings: shot list

**This is the one deliverable that needs a human with a screen recorder.** I
cannot capture video. Everything below is exact, so recording it is mechanical
rather than a judgement call.

Section 6.6 wants "a clean video of every demo beat, one keystroke away". The
point is not polish - it is that if a beat fails on stage you switch to the
recording and keep talking, rather than debugging in front of 80 people.

**Do not embed these in the deck.** Section 6.9 is explicit: a failed video
embed on a conference projector is a worse failure than switching to a player.
Keep them in a folder on the desktop with a player already open.

---

## Before recording

```bash
export ENV_FILE=config/.env.deployed        # or config/.env for the local stack
export AWS_PROFILE=awsday AWS_REGION=eu-central-1
./scripts/reset_demo.sh
```

Terminal: font size up, history cleared, no profile name visible in the prompt.
Browser: the Amplify dashboard, no other tabs, no bookmarks bar.

**Check every frame for the account id before you keep the file.** An ARN in a
recording is as permanent as one in a slide.

---

## Shot 1 - Demo 1, one endpoint every model  (~40s)

Record the terminal only.

```bash
for M in claude-sonnet gpt-on-bedrock nova-lite ipr-nova; do
  curl -s -X POST "$GATEWAY_BASE_URL/v1/chat/completions" \
    -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"What is the capital of Hungary? One short sentence.\"}],\"max_tokens\":400}" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print('$M ->', d['model'], '|', d['choices'][0]['message']['content'].strip())"
done
```

Expect roughly: Sonnet ~1.9s, GPT ~0.7s, Nova Lite ~0.4s, IPR ~0.7s.

## Shot 2 - Demo 2, semantic cache  (~25s)

**Record this against the LOCAL stack.** The deployed stack has no semantic
cache - ElastiCache has no RediSearch, see infra/DEPLOY.md. This is the one
beat where the recording and the live demo must come from different gateways.

```bash
Q1="Explain in two sentences why connection pooling reduces database latency."
Q2="In two sentences, why does pooling connections cut latency to a database?"
time curl -s -X POST "$GATEWAY_BASE_URL/v1/chat/completions" -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'Content-Type: application/json' -d "{\"model\":\"nova-lite\",\"messages\":[{\"role\":\"user\",\"content\":\"$Q1\"}],\"max_tokens\":200}" -o /dev/null
time curl -s -D /tmp/h.txt -X POST "$GATEWAY_BASE_URL/v1/chat/completions" -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'Content-Type: application/json' -d "{\"model\":\"nova-lite\",\"messages\":[{\"role\":\"user\",\"content\":\"$Q2\"}],\"max_tokens\":200}" -o /dev/null
grep -i semantic-similarity /tmp/h.txt
```

Expect ~740ms then ~170ms, and
`x-litellm-semantic-similarity: 0.9154934883118`.

## Shot 3 - Demo 3, the curves converging  (~30s, time-lapse)

Record the **dashboard**, not the terminal. Start the load generator, then
capture the dashboard at intervals and speed it up, or record 30s once the
curves have already separated.

The honest framing for this one: on real models four of the five arms cluster
inside 0.80-0.88 and only the weak arm separates cleanly. Record what is
actually on screen, not an idealised version.

## Shot 4 - Demo 4, the kill switch  (~60s) - THE IMPORTANT ONE

Record the dashboard with a terminal in the corner. This is the beat that
peaks, and the one most worth having a recording of.

```bash
./scripts/kill_primary.sh          # auto-selects the current traffic leader
```

Watch for: the killed arm's rolling share collapsing to 0% within ~8s, traffic
re-sorting, and **the error counter staying at 0**. Keep recording for at
least 30s after the switch.

## Shot 5 - Demo 5, the budget block  (~15s)

```bash
./scripts/e2e_rehearsal.sh   # beat 7 does this, or drive the key by hand
```

Expect **HTTP 400** with `"type": "budget_exceeded"`. **Not a 429** - the talk
plan is wrong about this. Record the JSON body; it is the point of the beat.

---

## Also worth recording

**The fallback switch.** Change `GATEWAY_BASE_URL` from the deployed stack to
localhost and re-run shot 1. Twenty seconds, and it is the live proof of slide
6's reversibility argument. If the deployed stack misbehaves on the day, this
recording is also your escape hatch.

---

## What already exists and needs no recording

- `handoff/dashboard-converged.png` - converged curves, 85% saved, errors 0
- `handoff/dashboard-failover.png` - immediately after the kill switch
- `handoff/dashboard-real-bedrock.png` - real models, the honest cluster
- `router/state/prewarmed.json` - load this if live convergence does not
  separate in time (`scripts/make_prewarmed_state.py` rebuilds it)
