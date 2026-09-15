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
# ENV_FILE selects the target stack: config/.env is the local standby,
# config/.env.deployed is the AWS stack. Without this the scripts always
# sourced config/.env and silently reset the LOCAL gateway while reporting
# success against the deployed one.
ENV_FILE="${ENV_FILE:-config/.env}"
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

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
#
# LOCAL vs REMOTE matters here. The breaker is a file in the gateway's state
# directory. Locally that is a bind mount and touching it works. On ECS the
# task shares no filesystem with this laptop, so writing the file here did
# nothing at all - measured on the deployed rehearsal: the arm was "killed"
# and kept 26% of traffic. For a remote gateway the switch goes over HTTP to
# the admin endpoint mounted inside the gateway process.
case "$BASE" in
  http://localhost*|http://127.0.0.1*) REMOTE=0 ;;
  *) REMOTE=1 ;;
esac

if [ "$REMOTE" = "1" ]; then
  DASH_URL="${DASHBOARD_BASE_URL:-$BASE/dash}"
  RESP="$(curl -sS -m 15 -X POST "$DASH_URL/admin/disable?arm=$TARGET" \
          -H "Authorization: Bearer $KEY" 2>&1)"
  if printf '%s' "$RESP" | grep -q '"disabled"'; then
    echo "==> '$TARGET' broken out of the circuit (remote). Watch the error counter stay at zero."
  else
    echo "!! remote kill FAILED: $(printf '%s' "$RESP" | head -c 200)" >&2
    exit 1
  fi
else
  STATE_DIR="${ROUTER_STATE_DIR:-router/state}"
  mkdir -p "$STATE_DIR"
  echo "$TARGET" >> "$STATE_DIR/DISABLED"
  sort -u "$STATE_DIR/DISABLED" -o "$STATE_DIR/DISABLED"
  echo "==> '$TARGET' broken out of the circuit. Watch the error counter stay at zero."
fi
echo "    restore with: scripts/reset_demo.sh"

