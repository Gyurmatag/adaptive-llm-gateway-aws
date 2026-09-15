#!/usr/bin/env bash
# Day-one AWS setup, in the order that actually works.
#
# Order matters and is not arbitrary:
#   1. budget cap + billing alarm FIRST, before anything can cost money
#   2. model access check, because it fails in ways that look like config errors
#   3. prompt routers, whose ARNs the gateway config needs
#   4. verification, so a wrong model ID surfaces here and not on stage
set -uo pipefail
cd "$(dirname "$0")/.."

# Read the model ids and ARNs the operator has already verified. Without this
# the script checks its own placeholder defaults and reports failures for
# models nobody is using.
[ -f config/.env ] && set -a && . config/.env && set +a

PROFILE="${AWS_PROFILE:-awsday}"
REGION="${AWS_REGION:-eu-central-1}"
PROJECT="${PROJECT:-awsday-gateway}"
BUDGET_USD="${MONTHLY_BUDGET_USD:-150}"
ALERT_EMAIL="${BUDGET_ALERT_EMAIL:-}"
AWS="aws --profile $PROFILE --region $REGION"
FAIL=0

say(){ echo; echo "=== $* ==="; }
ok(){ echo "  ok   $*"; }
bad(){ echo "  FAIL $*"; FAIL=1; }
warn(){ echo "  warn $*"; }

say "identity"
ACCT="$($AWS sts get-caller-identity --query Account --output text 2>&1)" || {
  echo "!! cannot authenticate with profile '$PROFILE'." >&2
  echo "   run: aws configure --profile $PROFILE" >&2
  exit 1
}
# Never echo the account id - it ends up in terminal recordings and screenshots.
ok "authenticated (account ...${ACCT: -4}, region $REGION)"

# ---------------------------------------------------------------- 1. cost caps
say "1. budget cap and billing alarm (before anything else runs)"
if [ -z "$ALERT_EMAIL" ]; then
  bad "BUDGET_ALERT_EMAIL not set - refusing to run without a cost alarm"
  echo "   export BUDGET_ALERT_EMAIL=you@example.com and re-run" >&2
  exit 1
fi

cat > /tmp/budget.json <<JSON
{
  "BudgetName": "${PROJECT}-monthly",
  "BudgetLimit": {"Amount": "${BUDGET_USD}", "Unit": "USD"},
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST"
}
JSON
cat > /tmp/notifications.json <<JSON
[
  {"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":50,"ThresholdType":"PERCENTAGE"},
   "Subscribers":[{"SubscriptionType":"EMAIL","Address":"${ALERT_EMAIL}"}]},
  {"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},
   "Subscribers":[{"SubscriptionType":"EMAIL","Address":"${ALERT_EMAIL}"}]},
  {"Notification":{"NotificationType":"FORECASTED","ComparisonOperator":"GREATER_THAN","Threshold":100,"ThresholdType":"PERCENTAGE"},
   "Subscribers":[{"SubscriptionType":"EMAIL","Address":"${ALERT_EMAIL}"}]}
]
JSON

if aws --profile "$PROFILE" budgets describe-budget \
     --account-id "$ACCT" --budget-name "${PROJECT}-monthly" >/dev/null 2>&1; then
  ok "budget '${PROJECT}-monthly' already exists"
else
  if aws --profile "$PROFILE" budgets create-budget \
       --account-id "$ACCT" \
       --budget file:///tmp/budget.json \
       --notifications-with-subscribers file:///tmp/notifications.json 2>/tmp/budgeterr; then
    ok "budget created: \$${BUDGET_USD}/month, alerts at 50/80/100%"
  else
    bad "budget creation failed: $(tail -1 /tmp/budgeterr)"
  fi
fi
rm -f /tmp/budget.json /tmp/notifications.json

# Billing metrics only publish to us-east-1, regardless of where the stack runs.
if aws --profile "$PROFILE" --region us-east-1 cloudwatch put-metric-alarm \
     --alarm-name "${PROJECT}-billing" \
     --comparison-operator GreaterThanThreshold \
     --evaluation-periods 1 --metric-name EstimatedCharges \
     --namespace AWS/Billing --period 21600 --statistic Maximum \
     --threshold "$(echo "$BUDGET_USD * 0.8" | bc)" \
     --dimensions Name=Currency,Value=USD \
     --treat-missing-data notBreaching 2>/tmp/alarmerr; then
  ok "billing alarm at 80% of cap"
else
  warn "billing alarm failed: $(tail -1 /tmp/alarmerr)"
fi

# ------------------------------------------------------------ 2. model access
say "2. Bedrock model access (fails in ways that look like config errors)"
check_model() {
  # INVOKE, do not just look up. A model can be ACTIVE in the catalog and still
  # refuse every call - the gpt-5.6 family lists as ACTIVE and returns
  # "not available for this account" until model access is granted, and bare
  # ids list as ACTIVE but reject on-demand invocation. Listing lies; calling
  # does not.
  local region="$1" id="$2"
  local out
  case "$id" in
    *embed*|*titan-embed*)
      out="$(aws --profile "$PROFILE" --region "$region" bedrock-runtime invoke-model \
            --model-id "$id" --body '{"inputText":"ping"}' \
            --cli-binary-format raw-in-base64-out --content-type application/json \
            /dev/stdout 2>&1)"
      echo "$out" | grep -qi embedding && echo "ACTIVE" || echo "MISSING"
      return ;;
  esac
  out="$(aws --profile "$PROFILE" --region "$region" bedrock-runtime converse \
        --model-id "$id" --messages '[{"role":"user","content":[{"text":"ping"}]}]' \
        --inference-config '{"maxTokens":8}' 2>&1)"
  echo "$out" | grep -q '"output"' && echo "ACTIVE" || echo "MISSING"
}

# Defaults are inference-profile ids, not bare model ids. A bare id fails with
# "Invocation of model ID X with on-demand throughput isn't supported", which
# reads like a quota problem and is not one.
MODELS="${MODEL_CLAUDE_SONNET:-eu.anthropic.claude-sonnet-4-5-20250929-v1:0}
${MODEL_GPT:-openai.gpt-oss-120b-1:0}
${MODEL_NOVA_LITE:-eu.amazon.nova-lite-v1:0}
${MODEL_JUDGE:-eu.amazon.nova-micro-v1:0}
${MODEL_EMBED:-amazon.titan-embed-text-v2:0}"

echo "  checking in $REGION:"
for M in $MODELS; do
  S="$(check_model "$REGION" "$M")"
  if [ "$S" = "ACTIVE" ]; then ok "$M"; else bad "$M not available in $REGION"; fi
done

# The talk's narrative wants eu-central-1 for the data residency argument, but
# the OpenAI-on-Bedrock models are the ones most likely to be region-limited.
# Report where they DO exist rather than just failing.
if [ "$FAIL" -ne 0 ]; then
  echo
  warn "some models are missing in $REGION. Checking alternatives:"
  for ALT in us-east-1 us-west-2 eu-west-1; do
    [ "$ALT" = "$REGION" ] && continue
    echo "    $ALT:"
    for M in $MODELS; do
      S="$(check_model "$ALT" "$M")"
      printf "      %-50s %s\n" "$M" "$S"
    done
  done
  echo
  echo "  NOTE: enabling a model in the console (Bedrock > Model access) is a"
  echo "  separate step from the model existing in the region. Do both."
fi

# ---------------------------------------------------------- 3. prompt routers
say "3. Intelligent Prompt Router ARNs"

# AWS ships DEFAULT prompt routers per family. Prefer them over creating custom
# ones: they already exist, they need no permissions to create, and
# create-prompt-router fails on accounts without the older family models.
#
# Each default router is checked by actually INVOKING it, because a router can
# exist and still be dead: the default Anthropic router pairs Claude 3.5 Haiku
# with Sonnet 3.5 v2, and in regions where those have been retired it returns
#   ResourceNotFoundException: This model version has reached the end of its life.
# Listing it would report a healthy router. Only invoking it tells the truth.
probe_router() {
  local arn="$1"
  local out
  out="$($AWS bedrock-runtime converse --model-id "$arn" \
      --messages '[{"role":"user","content":[{"text":"ping"}]}]' \
      --inference-config '{"maxTokens":8}' 2>&1)"
  if echo "$out" | grep -q '"output"'; then
    echo "ALIVE"
  elif echo "$out" | grep -qi "end of its life"; then
    echo "EOL"
  else
    echo "DEAD"
  fi
}

IPR_NOVA=""
IPR_CLAUDE=""
while IFS=$'\t' read -r NAME ARN; do
  [ -z "${ARN:-}" ] && continue
  STATUS="$(probe_router "$ARN")"
  case "$STATUS" in
    ALIVE) ok   "$NAME is alive" ;;
    EOL)   warn "$NAME exists but its underlying models are END OF LIFE in $REGION" ;;
    *)     warn "$NAME did not answer" ;;
  esac
  if [ "$STATUS" = "ALIVE" ]; then
    case "$ARN" in
      *amazon.nova*)     IPR_NOVA="$ARN" ;;
      *anthropic.claude*) IPR_CLAUDE="$ARN" ;;
    esac
  fi
done < <($AWS bedrock list-prompt-routers \
          --query 'promptRouterSummaries[].[promptRouterName,promptRouterArn]' \
          --output text 2>/dev/null)

[ -z "$IPR_NOVA" ] && warn "no usable Nova prompt router - the demo runs without that arm"
[ -z "$IPR_CLAUDE" ] && warn "no usable Anthropic prompt router - see handoff/branch-decision.md, this is slide 11 content"

# ARNs contain the account id, so they go to config/.env only, never a commit.
# Only overwrite a value we actually resolved: clobbering a verified ARN with
# an empty string is worse than leaving it alone.
if [ -f config/.env ]; then
  for PAIR in "IPR_NOVA_ARN=$IPR_NOVA" "IPR_CLAUDE_ARN=$IPR_CLAUDE"; do
    KEY="${PAIR%%=*}"; VAL="${PAIR#*=}"
    [ -z "$VAL" ] && continue
    sed -i.bak "/^${KEY}=/d" config/.env && rm -f config/.env.bak
    echo "${KEY}=${VAL}" >> config/.env
  done
  ok "usable ARNs written to config/.env (gitignored)"
else
  warn "config/.env missing - copy config/.env.example first"
fi

# ------------------------------------------------- 4. ALB idle timeout for SSE
say "4. ALB idle timeout (streaming completions AND the dashboard SSE stream)"
ALB_ARN="${ALB_ARN:-}"
if [ -z "$ALB_ARN" ]; then
  ALB_ARN="$($AWS elbv2 describe-load-balancers \
    --query "LoadBalancers[?contains(LoadBalancerName, '${PROJECT}')].LoadBalancerArn | [0]" \
    --output text 2>/dev/null)"
fi
if [ -n "$ALB_ARN" ] && [ "$ALB_ARN" != "None" ]; then
  IDLE="${ALB_IDLE_TIMEOUT:-120}"
  if $AWS elbv2 modify-load-balancer-attributes --load-balancer-arn "$ALB_ARN" \
       --attributes "Key=idle_timeout.timeout_seconds,Value=$IDLE" >/dev/null 2>&1; then
    ok "ALB idle timeout set to ${IDLE}s"
    echo "     KEEPALIVE_TIMEOUT in config/config.yaml must stay ABOVE this."
    echo "     Currently: $(grep -E '^\s*keepalive_timeout' config/config.yaml | tr -d ' ' || echo '?')"
  else
    warn "could not set the ALB idle timeout - streaming may be cut mid-flight"
  fi
else
  echo "  skip ALB not deployed yet. Re-run bootstrap.sh after deploy.sh."
fi

say "summary"
if [ "$FAIL" -eq 0 ]; then
  echo "  bootstrap OK. Next: infra/upstream/deploy.sh, then scripts/smoke_test.sh"
else
  echo "  bootstrap finished WITH FAILURES - fix model access before deploying"
fi
exit $FAIL
