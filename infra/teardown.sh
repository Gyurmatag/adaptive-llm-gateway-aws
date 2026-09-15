#!/usr/bin/env bash
# Run this after the conference. The repo stays up; the AWS stack does not.
#
# Aurora plus ElastiCache plus ECS plus an ALB left running is a real monthly
# line item, and the single most common way a conference demo becomes an
# expensive one is that nobody runs this.
set -uo pipefail
cd "$(dirname "$0")/.."

PROFILE="${AWS_PROFILE:-awsday}"
REGION="${AWS_REGION:-eu-central-1}"
PROJECT="${PROJECT:-awsday-gateway}"
AWS="aws --profile $PROFILE --region $REGION"

echo "This destroys the gateway stack, the dashboard service, the prompt"
echo "routers and the Amplify app in region $REGION."
read -r -p "Type the project name to confirm ($PROJECT): " CONFIRM
[ "$CONFIRM" = "$PROJECT" ] || { echo "aborted"; exit 1; }

# The add-on stack (dashboard.tf, alb_streaming.tf, budget.tf) is only
# destroyed if it was ever applied. The old guard tested for the .terraform
# DIRECTORY, which `terraform init` creates whether or not anything was
# deployed - so on this build it ran a destroy against an empty state, failed
# with nine "No value for required variable" errors, printed a soft warning and
# carried on. That reads as "add-on torn down" while nothing happened.
#
# Verified 2026-09-15: the dashboard is served by the gateway container itself
# at /dash (see router/proxy_hook.py), so there is no separate add-on stack in
# this deployment and `terraform state list` is empty.
echo "==> add-on stack"
if [ -s infra/terraform/terraform.tfstate ] || \
   terraform -chdir=infra/terraform state list >/dev/null 2>&1; then
  # Required variables have no defaults, so a bare destroy cannot resolve the
  # config. Pass them from the same tfvars the apply used.
  if [ -f infra/terraform/terraform.tfvars ]; then
    terraform -chdir=infra/terraform destroy -auto-approve \
      || echo "  !! add-on destroy FAILED - check infra/terraform by hand"
  else
    echo "  !! state exists but infra/terraform/terraform.tfvars does not."
    echo "     terraform destroy needs nine required variables and will fail"
    echo "     without it. Destroy infra/terraform by hand."
  fi
else
  echo "  nothing applied (empty state) - skipping"
fi

echo "==> destroying the upstream guidance stack"
if [ -x infra/upstream/undeploy.sh ]; then
  ( cd infra/upstream && ./undeploy.sh ) || echo "  (upstream undeploy reported errors)"
else
  echo "  !! infra/upstream/undeploy.sh missing - destroy the stack by hand"
fi

# Prompt routers: nothing to delete, and that is deliberate.
#
# This loop used to hunt for "${PROJECT}-claude" and "${PROJECT}-nova" and
# delete them. No such routers were ever created. The demo routes through the
# account's DEFAULT prompt routers -
#   bedrock/converse/arn:aws:bedrock:<region>:<acct>:default-prompt-router/amazon.nova:1
# - which are AWS-managed, exist in every account, are not billed, and are not
# ours to delete. The loop therefore matched nothing and printed nothing, which
# read as "routers cleaned up" when it had done exactly nothing.
#
# Verified 2026-09-15: list-prompt-routers returns only "Nova Prompt Router"
# and "aAnthropic Prompt Router", both AWS defaults.
echo "==> prompt routers: none created by this stack, nothing to delete"
echo "    (the demo uses the account's AWS-managed default prompt routers)"

# --- the demo console -------------------------------------------------------
#
# Added by hand for the talk, so nothing in the guidance's stack knows about it
# and nothing else will clean it up. Order matters: the service has to be gone
# before the target group can be deleted, and the listener rules before that.
echo "==> removing the demo console"
CONSOLE_TG="$($AWS elbv2 describe-target-groups --names demo-console-3100 \
  --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null)"

if $AWS ecs describe-services --cluster litellm-stack-cluster --services DemoConsoleService \
     --query 'services[0].status' --output text 2>/dev/null | grep -q ACTIVE; then
  $AWS ecs update-service --cluster litellm-stack-cluster --service DemoConsoleService \
    --desired-count 0 >/dev/null 2>&1
  $AWS ecs delete-service --cluster litellm-stack-cluster --service DemoConsoleService --force \
    >/dev/null 2>&1 && echo "  deleted DemoConsoleService" || echo "  could not delete DemoConsoleService"
fi

ALB_ARN="$($AWS elbv2 describe-load-balancers --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null)"
for L in $($AWS elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" \
           --query 'Listeners[].ListenerArn' --output text 2>/dev/null); do
  for PRIO in 50 40; do
    R="$($AWS elbv2 describe-rules --listener-arn "$L" \
         --query "Rules[?Priority=='$PRIO'].RuleArn" --output text 2>/dev/null)"
    [ -n "$R" ] && $AWS elbv2 delete-rule --rule-arn "$R" >/dev/null 2>&1 \
      && echo "  deleted listener rule $PRIO ($([ "$PRIO" = 50 ] && echo /console || echo /openapi.json))"
  done
done

if [ -n "$CONSOLE_TG" ] && [ "$CONSOLE_TG" != "None" ]; then
  # The service has to finish draining first.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    $AWS elbv2 delete-target-group --target-group-arn "$CONSOLE_TG" >/dev/null 2>&1 \
      && { echo "  deleted target group demo-console-3100"; break; }
    sleep 10
  done
fi

$AWS ec2 revoke-security-group-ingress --group-id sg-03cbea62b9a6e0ab3 \
  --protocol tcp --port 3100 --source-group sg-020c3ff99aaec5a80 >/dev/null 2>&1 \
  && echo "  closed port 3100 on the task security group"

$AWS ecr delete-repository --repository-name demo-console --force >/dev/null 2>&1 \
  && echo "  deleted the demo-console ECR repository"
$AWS ecr delete-repository --repository-name redis-stack --force >/dev/null 2>&1 \
  && echo "  deleted the redis-stack ECR repository"
$AWS logs delete-log-group --log-group-name /ecs/demo-console >/dev/null 2>&1 \
  && echo "  deleted the demo-console log group"

echo "==> deleting the Amplify app"
APP_ID="$($AWS amplify list-apps --query "apps[?name=='${PROJECT}-dashboard'].appId" --output text 2>/dev/null)"
if [ -n "$APP_ID" ] && [ "$APP_ID" != "None" ]; then
  $AWS amplify delete-app --app-id "$APP_ID" >/dev/null 2>&1 \
    && echo "  deleted Amplify app" || echo "  could not delete Amplify app"
fi

echo
echo "==> teardown finished."
echo "    The budget and billing alarm are left in place on purpose."
echo "    Verify in Cost Explorer next week that spend actually went to zero."
