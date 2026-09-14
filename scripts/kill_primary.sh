#!/usr/bin/env bash
# Demo 4, the surprise. Zero the primary deployment's rpm through the admin API
# so LiteLLM drops it from the healthy pool. Traffic fails over across families,
# the error counter stays at zero, and the posteriors re-sort as the router
# unlearns its favourite.
#
# Deliberately NOT an automatic failover. A manual switch is more reliable on
# stage and far easier to narrate.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f config/.env ] && set -a && . config/.env && set +a

BASE="${GATEWAY_BASE_URL:-http://localhost:4000}"
KEY="${LITELLM_MASTER_KEY:?LITELLM_MASTER_KEY not set}"
TARGET="${1:-${PRIMARY_MODEL:-claude-sonnet}}"

echo "==> killing '$TARGET' on $BASE"

MODEL_ID="$(curl -sS -H "Authorization: Bearer $KEY" "$BASE/model/info" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',[])
for m in d:
    if m.get('model_name')=='$TARGET':
        print((m.get('model_info') or {}).get('id','')); break
")"

if [ -z "$MODEL_ID" ]; then
  echo "!! '$TARGET' not found in the live model list" >&2
  curl -sS -H "Authorization: Bearer $KEY" "$BASE/model/info" \
    | python3 -c "import json,sys;print('available:',[m.get('model_name') for m in json.load(sys.stdin).get('data',[])])" >&2
  exit 1
fi

echo "$TARGET" > /tmp/killed_model.txt
echo "$MODEL_ID" > /tmp/killed_model_id.txt

curl -sS -X POST "$BASE/model/update" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"model_id\":\"$MODEL_ID\",\"litellm_params\":{\"rpm\":0}}" >/dev/null

echo "==> '$TARGET' rpm=0. Watch the error counter stay at zero."
