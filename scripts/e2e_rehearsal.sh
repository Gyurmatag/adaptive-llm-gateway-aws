#!/usr/bin/env bash
# Drives the full stage sequence from section 6.10 and writes a report with
# real measured numbers. This is not a plan - it executes the demo.
#
# Usage:
#   scripts/e2e_rehearsal.sh --label "run 1 office wifi"
#   scripts/e2e_rehearsal.sh --label "run 2 hotspot" --soak 1020
#
# --soak is the seconds of load between starting the generator (stage minute 2)
# and the kill switch (stage minute 19). Default 1020 = 17 minutes. Shorten it
# ONLY for a plumbing check; the convergence claim needs the full window.
set -uo pipefail
cd "$(dirname "$0")/.."
# ENV_FILE selects the target stack: config/.env is the local standby,
# config/.env.deployed is the AWS stack. Without this the scripts always
# sourced config/.env and silently reset the LOCAL gateway while reporting
# success against the deployed one.
ENV_FILE="${ENV_FILE:-config/.env}"
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

LABEL="local run"
SOAK=1020
while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="$2"; shift 2;;
    --soak)  SOAK="$2";  shift 2;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done

BASE="${GATEWAY_BASE_URL:-http://localhost:4000}"
DASH="${DASHBOARD_BASE_URL:-http://localhost:8080}"
KEY="${LITELLM_MASTER_KEY:?LITELLM_MASTER_KEY not set}"
RATE="${LOADGEN_RATE:-3.0}"
OUT="handoff/e2e-run-$(date +%Y%m%d-%H%M%S).md"
PY="${PYTHON_BIN:-./.venv/bin/python}"

T0=$(date +%s)
el(){ echo $(( $(date +%s) - T0 )); }
log(){ echo "$*" | tee -a "$OUT"; }

mkdir -p handoff
: > "$OUT"
log "# E2E rehearsal: $LABEL"
log ""
log "- started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "- gateway: \`$BASE\`"
log "- soak window: ${SOAK}s at ${RATE} req/s"
log ""

# ---------------------------------------------------------------- beat 1 reset
log "## Beat 1 - reset to starting state"
B=$(date +%s)
bash scripts/reset_demo.sh >/dev/null 2>&1
log "- reset_demo.sh: $(( $(date +%s) - B ))s"
STATE0=$(curl -sS "$DASH/state" 2>/dev/null | $PY -c "import json,sys;d=json.load(sys.stdin);print(d['total_requests'], d['errors'])" 2>/dev/null || echo "? ?")
log "- state after reset (requests errors): \`$STATE0\`"

# The circuit breaker MUST be empty before a soak. kill_primary.sh writes the
# killed arm into DISABLED, and a run that ended with the drill leaves it there.
# The router then withholds that arm from every selection while the dashboard
# still draws it, so it looks under-observed rather than switched off. That is
# exactly how ipr-nova took 0 selections through an entire rehearsal and made
# the convergence gate fail for an unrelated reason. Never start blind again.
BRK=$(curl -sS "$DASH/state" 2>/dev/null | $PY -c "import json,sys;print(','.join(json.load(sys.stdin).get('disabled_arms') or []))" 2>/dev/null || echo "?")
if [ -n "$BRK" ] && [ "$BRK" != "?" ]; then
  log "- !! circuit breaker was DIRTY after reset: \`$BRK\` - clearing"
  curl -sS -m 15 -X POST "$DASH/admin/enable" -H "Authorization: Bearer $KEY" >/dev/null 2>&1
  BRK=$(curl -sS "$DASH/state" 2>/dev/null | $PY -c "import json,sys;print(','.join(json.load(sys.stdin).get('disabled_arms') or []))" 2>/dev/null || echo "?")
fi
log "- circuit breaker after reset: \`${BRK:-clean}\`"
log ""

# ------------------------------------------------------------- beat 2 loadgen
log "## Beat 2 - start load generator (stage minute 2)"
LG_LOG=$(mktemp)
GATEWAY_BASE_URL="$BASE" LOADGEN_MODEL="${LOADGEN_MODEL:-demo-router}" \
  $PY loadgen/run.py --rate "$RATE" --duration $((SOAK + 600)) --concurrency 10 \
  > "$LG_LOG" 2>&1 &
LG_PID=$!
sleep 5
log "- load generator started, pid $LG_PID, t+$(el)s"
log ""

# ------------------------------------------------------------- beat 3 demo 1
log "## Beat 3 - Demo 1: same request, three model strings"
log ""
for M in ${DEMO1_MODELS:-claude-sonnet gpt-on-bedrock nova-lite}; do
  B=$(date +%s.%N)
  R=$(curl -sS -X POST "$BASE/v1/chat/completions" \
      -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
      -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"What is the capital of Hungary?\"}],\"max_tokens\":60,\"cache\":{\"no-cache\":true}}" 2>/dev/null)
  D=$(echo "$(date +%s.%N) - $B" | bc)
  WHO=$(printf '%s' "$R" | $PY -c "import json,sys;print(json.load(sys.stdin).get('model','?'))" 2>/dev/null || echo "?")
  TXT=$(printf '%s' "$R" | $PY -c "import json,sys;print((json.load(sys.stdin)['choices'][0]['message']['content'] or '')[:90].replace(chr(10),' '))" 2>/dev/null || echo "?")
  log "- \`$M\` -> answered by \`$WHO\` in $(printf '%.0f' $(echo "$D*1000"|bc))ms"
  log "  > $TXT"
done
log ""

# ------------------------------------------------------------- beat 4 demo 2
log "## Beat 4 - Demo 2: semantic cache on a reworded question"
# Two constraints on this pair, and they pull in opposite directions.
#
# 1. It must be OFF-POOL. The load generator has been seeding the semantic
#    cache since beat 2, so a question resembling anything in
#    loadgen/prompts.yaml is already warm and the beat shows no contrast at
#    all - measured before this fix: 19ms then 19ms. The connection-pooling
#    prompt was removed from the pool for exactly this reason.
#
# 2. The rewording must still clear the 0.85 similarity threshold on real
#    Titan embeddings. Measured on amazon.titan-embed-text-v2:0:
#       this pair                          0.9155  -> hits
#       a sourdough paraphrase             0.8037  -> MISSES at 0.85
#       an unrelated control               0.0668
#    A rewording that feels equivalent to a human can still sit under the
#    threshold. Measure it, do not assume it.
Q1="Explain in two sentences why connection pooling reduces database latency."
Q2="In two sentences, why does pooling connections cut latency to a database?"
SPEND_BEFORE=$(curl -sS "$DASH/spend" 2>/dev/null | $PY -c "import json,sys;print(json.load(sys.stdin)['actual_usd'])" 2>/dev/null || echo 0)

B=$(date +%s.%N)
curl -sS -D /tmp/h1.txt -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"model\":\"nova-lite\",\"messages\":[{\"role\":\"user\",\"content\":\"$Q1\"}],\"max_tokens\":120,\"cache\":{\"no-cache\":true}}" -o /tmp/r1.json 2>/dev/null
D1=$(echo "($(date +%s.%N) - $B)*1000" | bc)

B=$(date +%s.%N)
curl -sS -D /tmp/h2.txt -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"model\":\"nova-lite\",\"messages\":[{\"role\":\"user\",\"content\":\"$Q2\"}],\"max_tokens\":120}" -o /tmp/r2.json 2>/dev/null
D2=$(echo "($(date +%s.%N) - $B)*1000" | bc)

SIM=$(grep -i 'x-litellm-semantic-similarity' /tmp/h2.txt | tr -d '\r' | head -1)
HIT=$(grep -i 'x-litellm-cache-hit' /tmp/h2.txt | tr -d '\r' | head -1)
SPEND_AFTER=$(curl -sS "$DASH/spend" 2>/dev/null | $PY -c "import json,sys;print(json.load(sys.stdin)['actual_usd'])" 2>/dev/null || echo 0)

log "- first ask:    $(printf '%.0f' "$D1")ms"
log "- reworded ask: $(printf '%.0f' "$D2")ms"
log "- \`x-litellm-semantic-similarity\`: ${SIM:-**NOT PRESENT**}"
log "- \`x-litellm-cache-hit\`: ${HIT:-not present}"
log "- spend before/after: $SPEND_BEFORE / $SPEND_AFTER"
log ""
log "<details><summary>response headers on the reworded ask</summary>"
log ""
log '```'
sed 's/\r$//' /tmp/h2.txt | head -25 >> "$OUT"
log '```'
log "</details>"
log ""

# --------------------------------------------------------- beat 5 convergence
log "## Beat 5 - soak to stage minute 19 (${SOAK}s)"
log ""
log "| t+s | requests | errors | leader | arm means |"
log "|---|---|---|---|---|"
END=$(( $(date +%s) + SOAK ))
while [ "$(date +%s)" -lt "$END" ]; do
  S=$(curl -sS "$DASH/state" 2>/dev/null | $PY -c "
import json,sys
d=json.load(sys.stdin)
means=' '.join('%s=%.3f(%d)'%(a['model'],a['mean'],a['observations']) for a in d['arms'])
print('%d|%d|%s|%s' % (d['total_requests'], d['errors'], d['leader'] or '-', means))
" 2>/dev/null || echo "?|?|?|?")
  log "| $(el) | $(echo "$S" | cut -d'|' -f1) | $(echo "$S" | cut -d'|' -f2) | $(echo "$S" | cut -d'|' -f3) | $(echo "$S" | cut -d'|' -f4) |"
  sleep "${SAMPLE_INTERVAL:-60}"
done
log ""

SEP=$(curl -sS "$DASH/state" 2>/dev/null | $PY -c "
import json,sys,math
d=json.load(sys.stdin)
arms=sorted(d['arms'], key=lambda a:-a['mean'])
if len(arms)<2: print('INSUFFICIENT ARMS'); raise SystemExit
sd=lambda a: math.sqrt(a['variance'])
gap=arms[0]['mean']-arms[1]['mean']; s=sd(arms[0])+sd(arms[1])
print('leader=%s gap=%.4f sd_sum=%.4f separated=%s minobs=%d' % (
  arms[0]['model'], gap, s, gap>s, min(a['observations'] for a in d['arms'])))
" 2>/dev/null || echo "could not evaluate")
log "**Convergence at the kill point:** \`$SEP\`"
log ""

# ------------------------------------------------------------- beat 6 demo 4
log "## Beat 6 - Demo 4: kill the primary"
ERR_BEFORE=$(curl -sS "$DASH/state" 2>/dev/null | $PY -c "import json,sys;print(json.load(sys.stdin)['errors'])" 2>/dev/null || echo "?")
LEAD_BEFORE=$(curl -sS "$DASH/state" 2>/dev/null | $PY -c "import json,sys;print(json.load(sys.stdin)['leader'])" 2>/dev/null || echo "?")
B=$(date +%s)
KILLED=$(bash scripts/kill_primary.sh 2>&1 | tail -3)
log "- killed at t+$(el)s (took $(( $(date +%s) - B ))s)"
log '```'
log "$KILLED"
log '```'
sleep 45
ERR_AFTER=$(curl -sS "$DASH/state" 2>/dev/null | $PY -c "import json,sys;print(json.load(sys.stdin)['errors'])" 2>/dev/null || echo "?")
LEAD_AFTER=$(curl -sS "$DASH/state" 2>/dev/null | $PY -c "import json,sys;print(json.load(sys.stdin)['leader'])" 2>/dev/null || echo "?")
log "- leader before -> after: \`$LEAD_BEFORE\` -> \`$LEAD_AFTER\`"
log "- **errors before -> after: $ERR_BEFORE -> $ERR_AFTER** (must be 0 -> 0)"
# Restore the arm the drill just killed. Leaving it broken out poisons every
# later beat AND the next run, silently.
curl -sS -m 15 -X POST "$DASH/admin/enable" -H "Authorization: Bearer $KEY" >/dev/null 2>&1
BRK_AFTER=$(curl -sS "$DASH/state" 2>/dev/null | $PY -c "import json,sys;print(','.join(json.load(sys.stdin).get('disabled_arms') or []))" 2>/dev/null || echo "?")
log "- breaker restored after drill: \`${BRK_AFTER:-clean}\`"
log ""

# ------------------------------------------------------------- beat 7 demo 5
log "## Beat 7 - Demo 5: budget key hits its ceiling"
# The budget block must be detected from the BODY, not the status code.
#
#   local gateway    -> HTTP 400 with {"error":{"type":"budget_exceeded"}}
#   deployed gateway -> HTTP *200* with the same error body
#
# The deployed stack routes /v1/chat/completions through the guidance's
# middleware container, which passes the error through with a 200. A harness
# that waits for a non-200 never terminates there, and a speaker who points at
# the status code is pointing at the wrong thing. Show the JSON.
#
# Requests must also send cache.no-cache: with exact-match caching on, a
# repeated identical prompt is served from cache, costs nothing, and the key
# never approaches its ceiling.
BK="${BUDGET_KEY:-}"
if [ -z "$BK" ]; then
  BK="$(curl -sS -m 20 -X POST "$BASE/key/generate" -H "Authorization: Bearer $KEY" \
        -H 'Content-Type: application/json' \
        -d "{\"key_alias\":\"demo-budget-$(date +%s)\",\"max_budget\":${BUDGET_USD:-0.0002},\"models\":[\"${LOADGEN_MODEL:-demo-router}\"]}" 2>/dev/null \
        | $PY -c "import json,sys;print(json.load(sys.stdin).get('key',''))" 2>/dev/null)"
fi
if [ -n "$BK" ]; then
  B=$(date +%s); N=0; BLOCKED=0; CODE=""
  while [ "$N" -lt 300 ] && [ "$BLOCKED" = "0" ]; do
    CODE=$(curl -sS -m 60 -o /tmp/bk_resp.json -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
      -H "Authorization: Bearer $BK" -H 'Content-Type: application/json' \
      -d "{\"model\":\"${LOADGEN_MODEL:-demo-router}\",\"messages\":[{\"role\":\"user\",\"content\":\"Write three sentences about databases.\"}],\"max_tokens\":300,\"cache\":{\"no-cache\":true}}" 2>/dev/null)
    N=$((N+1))
    BLOCKED=$($PY -c "
import json
try:
    d=json.load(open('/tmp/bk_resp.json'))
    print(1 if (d.get('error') or {}).get('type')=='budget_exceeded' else 0)
except Exception: print(0)" 2>/dev/null)
  done
  MSG=$($PY -c "
import json
try:
    d=json.load(open('/tmp/bk_resp.json')); e=d.get('error') or {}
    print('%s | %s' % (e.get('type','?'), (e.get('message') or '')[:140]))
except Exception: print('(unparseable)')" 2>/dev/null)
  if [ "$BLOCKED" = "1" ]; then
    log "- **BLOCKED** after $N requests, $(( $(date +%s) - B ))s"
    log "- transport status: \`HTTP $CODE\` - note this is 200 on the deployed"
    log "  stack (the middleware passes the error through) and 400 locally."
    log "  **Detect the body, not the status. Do not say 429 on stage.**"
    log "  \`\`\`"
    log "  $MSG"
    log "  \`\`\`"
  else
    log "- **NOT BLOCKED** after $N requests. Last body: $MSG"
    log "  Check that requests sent cache.no-cache - a cached repeat costs nothing."
  fi
else
  log "- **SKIPPED**: could not create a budget key."
fi
log ""

# ------------------------------------------------------- beat 8 fallback drill
log "## Beat 8 - fallback drill: GATEWAY_BASE_URL switch"
STANDBY="${STANDBY_BASE_URL:-http://localhost:4000}"
if [ "$STANDBY" != "$BASE" ]; then
  B=$(date +%s.%N)
  curl -fsS -o /dev/null -X POST "$STANDBY/v1/chat/completions" \
    -H "Authorization: Bearer ${STANDBY_KEY:-$KEY}" -H 'Content-Type: application/json' \
    -d '{"model":"demo-router","messages":[{"role":"user","content":"hi"}],"max_tokens":20}' 2>/dev/null \
    && log "- standby answered in $(printf '%.0f' $(echo "($(date +%s.%N)-$B)*1000"|bc))ms" \
    || log "- **standby did NOT answer**"
else
  log "- SKIPPED: STANDBY_BASE_URL equals GATEWAY_BASE_URL"
fi
log ""

kill "$LG_PID" 2>/dev/null; wait "$LG_PID" 2>/dev/null
log "## Load generator summary"
log '```'
tail -4 "$LG_LOG" >> "$OUT"
log '```'
log ""
log "- total wall clock: $(el)s"
log "- finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
echo "==> report written to $OUT"
