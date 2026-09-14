#!/usr/bin/env bash
# Return the demo to its starting state. Required between rehearsals, not a
# convenience: after one full run the budget key is exhausted, the semantic
# cache is warm, the posteriors have converged and a deployment is paused.
#
# Resets, in order:
#   1. the paused deployment from kill_primary.sh
#   2. the $5 budget key's spend
#   3. the semantic cache
#   4. router posteriors, audit log and shadow log
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f config/.env ] && set -a && . config/.env && set +a

BASE="${GATEWAY_BASE_URL:-http://localhost:4000}"
KEY="${LITELLM_MASTER_KEY:?LITELLM_MASTER_KEY not set}"
BUDGET_KEY_ALIAS="${BUDGET_KEY_ALIAS:-demo-budget-key}"

echo "==> resetting demo state against $BASE"

# --- 1. close the circuit breaker ---------------------------------------------
STATE_DIR="${ROUTER_STATE_DIR:-router/state}"
if [ -s "$STATE_DIR/DISABLED" ]; then
  echo "  - restoring $(tr '\n' ' ' < "$STATE_DIR/DISABLED")"
  rm -f "$STATE_DIR/DISABLED"
else
  echo "  - no arm is broken out, skipping"
fi

# --- 2. reset the budget key's spend -----------------------------------------
echo "  - resetting budget key spend ($BUDGET_KEY_ALIAS)"
BUDGET_KEY="$(curl -sS -H "Authorization: Bearer $KEY" "$BASE/key/list?return_full_object=true" \
  | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
keys = d.get('keys', d if isinstance(d,list) else [])
for k in keys:
    if isinstance(k,dict) and k.get('key_alias')=='$BUDGET_KEY_ALIAS':
        print(k.get('token') or k.get('key') or ''); break
" || true)"

if [ -n "$BUDGET_KEY" ]; then
  curl -sS -X POST "$BASE/key/update" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"key\":\"$BUDGET_KEY\",\"spend\":0,\"max_budget\":${BUDGET_USD:-5}}" >/dev/null
  echo "    spend zeroed, max_budget=\$${BUDGET_USD:-5}"
else
  echo "    !! budget key '$BUDGET_KEY_ALIAS' not found - run bootstrap.sh" >&2
fi

# --- 3. flush the semantic cache ---------------------------------------------
echo "  - clearing the semantic cache (must be cold for Demo 2)"
# Delete the cache ENTRIES, never FLUSHALL.
#
# FLUSHALL destroys the redisvl vector index along with the data, and LiteLLM's
# cache client does not notice or recreate it. Writes then keep succeeding into
# unindexed hashes and every lookup silently returns nothing - Demo 2 shows
# "x-litellm-semantic-similarity: 0.0" and no speedup, with no error anywhere.
# The index only comes back when the gateway restarts.
#
# Deleting by key prefix leaves the index definition in place.
CACHE_PREFIX="${SEMANTIC_CACHE_PREFIX:-litellm_semantic_cache_index:}"
CLEARED=""
if [ -n "$(docker compose ps -q valkey 2>/dev/null)" ]; then
  N=$(docker compose exec -T valkey sh -c \
    "redis-cli --scan --pattern '${CACHE_PREFIX}*' | xargs -r redis-cli DEL 2>/dev/null | awk '{s+=\$1} END {print s+0}'" 2>/dev/null | tr -d '\r')
  IDX=$(docker compose exec -T valkey redis-cli FT._LIST 2>/dev/null | tr -d '\r' | head -1)
  if [ -n "$IDX" ]; then
    CLEARED="yes"
    echo "    cleared ${N:-0} cache entries, index '$IDX' intact"
  else
    echo "    !! the search index is GONE. Demo 2 cannot hit until the gateway" >&2
    echo "       restarts: docker compose up -d --force-recreate gateway" >&2
  fi
fi
if [ -z "$CLEARED" ]; then
  curl -sS -X POST "$BASE/cache/flushall" -H "Authorization: Bearer $KEY" >/dev/null 2>&1 \
    && echo "    called /cache/flushall - VERIFY Demo 2's first ask is slow" \
    || echo "    !! could not clear the cache; Demo 2 will show a warm first ask" >&2
fi

# --- 4. router state ----------------------------------------------------------
# The posteriors live in the GATEWAY process's memory. Deleting the state file
# does nothing: the gateway rewrites it from memory a second later. The
# sentinel is picked up by the installer watchdog inside the gateway, which
# resets in-memory state and clears the logs.
echo "  - signalling the gateway to reset its posteriors"
STATE_DIR="${ROUTER_STATE_DIR:-router/state}"
mkdir -p "$STATE_DIR" && touch "$STATE_DIR/RESET"

DEADLINE=$(( $(date +%s) + 20 ))
while [ -f "$STATE_DIR/RESET" ] && [ "$(date +%s)" -lt "$DEADLINE" ]; do sleep 1; done
if [ -f "$STATE_DIR/RESET" ]; then
  echo "    !! gateway did not consume the reset sentinel in 20s." >&2
  echo "       If the gateway is remote it does not share this filesystem -" >&2
  echo "       recycle the ECS task instead:" >&2
  echo "       aws ecs update-service --cluster <c> --service <s> --force-new-deployment" >&2
else
  echo "    posteriors reset to priors"
fi

DASH="${DASHBOARD_BASE_URL:-http://localhost:8080}"
DASH_REQS=$(curl -sS "$DASH/state" 2>/dev/null \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['total_requests'])" 2>/dev/null || echo "?")
echo "    dashboard now reports $DASH_REQS requests (expected 0)"

echo "==> reset complete. Budget full, cache cold, posteriors at priors."
