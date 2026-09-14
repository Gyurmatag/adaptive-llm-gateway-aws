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

# --- 1. un-pause the killed deployment ---------------------------------------
if [ -f /tmp/killed_model_id.txt ]; then
  MODEL_ID="$(cat /tmp/killed_model_id.txt)"
  NAME="$(cat /tmp/killed_model.txt 2>/dev/null || echo '?')"
  echo "  - restoring '$NAME' rpm"
  curl -sS -X POST "$BASE/model/update" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"model_id\":\"$MODEL_ID\",\"litellm_params\":{\"rpm\":${PRIMARY_RPM:-600}}}" >/dev/null \
    && rm -f /tmp/killed_model_id.txt /tmp/killed_model.txt
else
  echo "  - no paused deployment recorded, skipping"
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
echo "  - flushing the semantic cache (must be cold for Demo 2)"
curl -sS -X POST "$BASE/cache/flushall" -H "Authorization: Bearer $KEY" >/dev/null 2>&1 \
  || echo "    (no cache endpoint; flush Valkey directly if Demo 2 misbehaves)"

# --- 4. router state ----------------------------------------------------------
echo "  - clearing router posteriors, audit and shadow logs"
rm -f router/state/posteriors.json router/state/audit.jsonl router/state/shadow.jsonl
curl -sS -X POST "$BASE/../reset" >/dev/null 2>&1 || true
DASH="${DASHBOARD_BASE_URL:-http://localhost:8080}"
curl -sS -X POST "$DASH/admin/reset" >/dev/null 2>&1 \
  && echo "    dashboard state reset" \
  || echo "    (dashboard not reachable at $DASH; it reloads priors on restart)"

echo "==> reset complete. Budget full, cache cold, posteriors at priors."
