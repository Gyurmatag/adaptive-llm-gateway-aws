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

echo "==> destroying the add-on stack"
if [ -d infra/terraform/.terraform ]; then
  terraform -chdir=infra/terraform destroy -auto-approve || echo "  (add-on destroy reported errors)"
fi

echo "==> destroying the upstream guidance stack"
if [ -x infra/upstream/undeploy.sh ]; then
  ( cd infra/upstream && ./undeploy.sh ) || echo "  (upstream undeploy reported errors)"
else
  echo "  !! infra/upstream/undeploy.sh missing - destroy the stack by hand"
fi

echo "==> deleting prompt routers"
for NAME in "${PROJECT}-claude" "${PROJECT}-nova"; do
  ARN="$($AWS bedrock list-prompt-routers \
    --query "promptRouterSummaries[?promptRouterName=='$NAME'].promptRouterArn" \
    --output text 2>/dev/null)"
  if [ -n "$ARN" ] && [ "$ARN" != "None" ]; then
    $AWS bedrock delete-prompt-router --prompt-router-arn "$ARN" >/dev/null 2>&1 \
      && echo "  deleted $NAME" || echo "  could not delete $NAME"
  fi
done

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
