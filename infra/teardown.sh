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
