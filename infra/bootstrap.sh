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
  local region="$1" id="$2"
  local out
  out="$(aws --profile "$PROFILE" --region "$region" bedrock get-foundation-model \
        --model-identifier "$id" --query 'modelDetails.modelLifecycle.status' \
        --output text 2>&1)"
  if [ "$out" = "ACTIVE" ]; then echo "ACTIVE"; else echo "MISSING"; fi
}

MODELS="${MODEL_CLAUDE_SONNET:-anthropic.claude-sonnet-4-5-20250929-v1:0}
${MODEL_GPT:-openai.gpt-5-6-20260817-v1:0}
${MODEL_NOVA_LITE:-amazon.nova-lite-v1:0}
${MODEL_JUDGE:-amazon.nova-micro-v1:0}"

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
create_router() {
  local name="$1" fallback="$2" primary="$3"
  local existing
  existing="$($AWS bedrock list-prompt-routers \
    --query "promptRouterSummaries[?promptRouterName=='$name'].promptRouterArn" \
    --output text 2>/dev/null)"
  if [ -n "$existing" ] && [ "$existing" != "None" ]; then
    echo "$existing"; return 0
  fi
  $AWS bedrock create-prompt-router \
    --prompt-router-name "$name" \
    --models "[{\"modelArn\":\"$primary\"},{\"modelArn\":\"$fallback\"}]" \
    --fallback-model "{\"modelArn\":\"$fallback\"}" \
    --routing-criteria '{"responseQualityDifference":0.10}' \
    --query promptRouterArn --output text 2>/dev/null
}

ARN_PREFIX="arn:aws:bedrock:${REGION}::foundation-model"
IPR_CLAUDE="$(create_router "${PROJECT}-claude" \
  "${ARN_PREFIX}/${IPR_CLAUDE_CHEAP:-anthropic.claude-3-5-haiku-20241022-v1:0}" \
  "${ARN_PREFIX}/${IPR_CLAUDE_STRONG:-anthropic.claude-3-5-sonnet-20241022-v2:0}")"
IPR_NOVA="$(create_router "${PROJECT}-nova" \
  "${ARN_PREFIX}/${IPR_NOVA_CHEAP:-amazon.nova-lite-v1:0}" \
  "${ARN_PREFIX}/${IPR_NOVA_STRONG:-amazon.nova-pro-v1:0}")"

if [ -n "$IPR_CLAUDE" ] && [ "$IPR_CLAUDE" != "None" ]; then
  ok "Claude prompt router ready"
else
  warn "Claude prompt router not created - the demo still works without IPR arms"
fi
if [ -n "$IPR_NOVA" ] && [ "$IPR_NOVA" != "None" ]; then
  ok "Nova prompt router ready"
else
  warn "Nova prompt router not created"
fi

# Write ARNs to the local env file only. They contain the account id, so they
# must never reach a commit - config/.env is gitignored, .env.example is not.
if [ -f config/.env ]; then
  sed -i.bak '/^IPR_CLAUDE_ARN=/d;/^IPR_NOVA_ARN=/d' config/.env && rm -f config/.env.bak
  { echo "IPR_CLAUDE_ARN=$IPR_CLAUDE"; echo "IPR_NOVA_ARN=$IPR_NOVA"; } >> config/.env
  ok "ARNs written to config/.env (gitignored)"
else
  warn "config/.env missing - copy config/.env.example first"
fi

say "summary"
if [ "$FAIL" -eq 0 ]; then
  echo "  bootstrap OK. Next: infra/upstream/deploy.sh, then scripts/smoke_test.sh"
else
  echo "  bootstrap finished WITH FAILURES - fix model access before deploying"
fi
exit $FAIL
