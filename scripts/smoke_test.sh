#!/usr/bin/env bash
# Runs against whatever GATEWAY_BASE_URL points at. Checks the things that
# actually break, in the order they break.
set -uo pipefail
cd "$(dirname "$0")/.."
[ -f config/.env ] && set -a && . config/.env && set +a

BASE="${GATEWAY_BASE_URL:-http://localhost:4000}"
KEY="${LITELLM_MASTER_KEY:?LITELLM_MASTER_KEY not set}"
FAIL=0
pass(){ echo "  ok   $*"; }
fail(){ echo "  FAIL $*"; FAIL=1; }

echo "==> smoke test against $BASE"

echo "-- health"
curl -fsS "$BASE/health/liveliness" >/dev/null 2>&1 && pass "liveliness" || fail "liveliness"

echo "-- model list"
MODELS="$(curl -fsS -H "Authorization: Bearer $KEY" "$BASE/v1/models" 2>/dev/null \
  | python3 -c "import json,sys;print(' '.join(m['id'] for m in json.load(sys.stdin).get('data',[])))" 2>/dev/null)"
[ -n "$MODELS" ] && pass "models: $MODELS" || fail "could not list models"

echo "-- one completion per arm (Demo 1: same curl, three providers)"
for M in ${DEMO1_MODELS:-claude-sonnet gpt-on-bedrock nova-lite}; do
  OUT="$(curl -fsS -X POST "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: OK\"}],\"max_tokens\":16}" 2>/dev/null)"
  WHO="$(printf '%s' "$OUT" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('model','?'))" 2>/dev/null)"
  [ -n "$WHO" ] && [ "$WHO" != "?" ] && pass "$M -> answered by $WHO" || fail "$M did not answer"
done

echo "-- bedrock/converse ARN route (the highest-risk integration point)"
if [ -n "${IPR_CLAUDE_ARN:-}" ]; then
  OUT="$(curl -fsS -X POST "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d '{"model":"ipr-claude","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":16}' 2>/dev/null)"
  printf '%s' "$OUT" | grep -q '"content"' && pass "IPR router ARN resolves through bedrock/converse/" \
    || fail "IPR ARN route failed - this is the documented converse-vs-plain-bedrock trap"
else
  echo "  skip IPR_CLAUDE_ARN not set (run infra/bootstrap.sh)"
fi

echo "-- streaming (must survive the ALB idle timeout)"
CHUNKS="$(curl -fsS -N -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"nova-lite","messages":[{"role":"user","content":"Count from 1 to 20."}],"max_tokens":120,"stream":true}' 2>/dev/null \
  | grep -c '^data:' || true)"
[ "${CHUNKS:-0}" -gt 2 ] && pass "streaming returned $CHUNKS chunks" || fail "streaming returned $CHUNKS chunks"

echo "-- dashboard data plane"
DASH="${DASHBOARD_BASE_URL:-http://localhost:8080}"
curl -fsS "$DASH/health" >/dev/null 2>&1 && pass "dashboard /health" || fail "dashboard /health"
curl -fsS "$DASH/state" >/dev/null 2>&1 && pass "dashboard /state" || fail "dashboard /state"

echo
[ "$FAIL" -eq 0 ] && echo "==> SMOKE TEST PASSED" || echo "==> SMOKE TEST FAILED"
exit $FAIL
