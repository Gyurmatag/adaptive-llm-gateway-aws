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
TARGET="${1:-${PRIMARY_MODEL:-auto}}"

# On stage, kill whatever the dashboard is currently showing as dominant. A
# model carrying 8% of traffic makes an undramatic failover; the traffic leader
# makes the re-sort obvious from the back row.
if [ "$TARGET" = "auto" ]; then
  DASH="${DASHBOARD_BASE_URL:-http://localhost:8080}"
  TARGET="$(curl -sS "$DASH/state" 2>/dev/null \
    | python3 -c "import json,sys;print(json.load(sys.stdin).get('leader') or '')" 2>/dev/null)"
  [ -z "$TARGET" ] && TARGET="claude-sonnet"
  echo "==> auto-selected current traffic leader: $TARGET"
fi

echo "==> killing '$TARGET' on $BASE"

# Match on model_info.id, NOT model_name.
#
# Every arm appears twice in the model list: once under its own model_name so
# Demo 1 can address it directly, and once inside the router group with
# model_info.id set to the arm name. Matching by model_name finds the DIRECT
# deployment and zeroing that one does nothing to the bandit - the arm keeps
# taking traffic. Observed: 68 of the last 75 routing decisions still went to
# a model that had just been "killed", with the error counter correctly at
# zero and the dashboard looking exactly as if the failover had worked.
ROUTER_GROUP="${ROUTER_GROUP:-demo-router}"
# Throw the circuit breaker.
#
# NOT the admin API: LiteLLM cannot disable a config-file deployment at runtime.
# POST /model/update with rpm 0 silently does nothing (rpm reads back as None)
# and POST /model/delete returns 400 "not found in db", because config-defined
# deployments are not in the database. Both look like they worked and the model
# keeps serving. See router/thompson_router.py.
STATE_DIR="${ROUTER_STATE_DIR:-router/state}"
mkdir -p "$STATE_DIR"
echo "$TARGET" >> "$STATE_DIR/DISABLED"
sort -u "$STATE_DIR/DISABLED" -o "$STATE_DIR/DISABLED"

echo "==> '$TARGET' broken out of the circuit. Watch the error counter stay at zero."
echo "    restore with: scripts/reset_demo.sh"

