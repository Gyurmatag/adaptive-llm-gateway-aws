# Deploying the console

It runs on the **production** stack, at `<cloudfront>/console`, as its own ECS
service beside the gateway. Deliberately separate: nothing here can disturb
`LiteLLMService`, which is the thing the talk actually depends on.

```
CloudFront (default behaviour, everything)
  └─ ALB
       ├─ rule /console, /console/*  (priority 50)  → demo-console-3100 → ConsoleContainer :3100
       └─ default                                    → litellm-stack-4000 → the gateway :4000
```

## Redeploy after a code change

```bash
export AWS_PROFILE=awsday AWS_REGION=eu-central-1
ACCT=$(aws sts get-caller-identity --query Account --output text)
aws ecr get-login-password | docker login --username AWS --password-stdin "${ACCT}.dkr.ecr.eu-central-1.amazonaws.com"
cd demo-console
docker buildx build --platform linux/arm64 --provenance=false --push \
  -t "${ACCT}.dkr.ecr.eu-central-1.amazonaws.com/demo-console:latest" .
aws ecs update-service --cluster litellm-stack-cluster --service DemoConsoleService --force-new-deployment
```

Takes about three minutes. Watch it with:

```bash
aws elbv2 describe-target-health \
  --target-group-arn "$(aws elbv2 describe-target-groups --names demo-console-3100 \
    --query 'TargetGroups[0].TargetGroupArn' --output text)" \
  --query 'TargetHealthDescriptions[].TargetHealth.State' --output text
```

## Four things that cost an hour each, so they are written down

**The key comes from Secrets Manager, never from the image.** The task
definition references the same secret the gateway reads. `.dockerignore`
excludes `.env.local` so a local key cannot be baked in by accident.

**Build for arm64.** The cluster is `cpuArchitecture: ARM64`. An amd64 image
fails twice over and neither error names the architecture - see
`handoff/deploy-lessons.md`.

**Do not set `HOSTNAME` with `ENV`.** Docker sets `HOSTNAME` to the container
hostname and that wins, so Next binds to a name that resolves to loopback. The
server starts, logs `Ready`, and the load balancer can never reach it: healthy
logs, targets draining forever, 503 at the edge. The `CMD` pins
`HOSTNAME=0.0.0.0` at exec time instead.

**Open the port on the task security group.** It allowed only 4000 and 3000
from the ALB. Port 3100 had to be added, or every health check fails with no
error anywhere except an unhealthy target.

## Streaming works here

`dashboard-web` is a static export because Amplify lists Next.js streaming as
unsupported. That constraint is Amplify's, not CloudFront's - the chat streams
token by token through CloudFront and the ALB, verified on the production URL.

## Teardown

`infra/teardown.sh` removes the service, both listener rules, the target group,
the security group rule, the ECR repositories and the log group. Run it after
the talk.
