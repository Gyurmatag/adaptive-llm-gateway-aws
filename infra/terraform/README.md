# Terraform

This directory does **not** reimplement the gateway. That would contradict the
talk's own argument: position 3 on the gradient is a deploy, not a build.

The bulk comes from the official AWS guidance, fetched by
`infra/fetch-upstream.sh` into `infra/upstream/` (fetched, not vendored, so its
licensing stays its own):
**aws-solutions-library-samples/guidance-for-multi-provider-generative-ai-gateway-on-aws**

It ships Terraform for ECS or EKS, an ALB, RDS Postgres, ElastiCache, Secrets
Manager and the Bedrock interface. `infra/upstream/deploy.sh` drives it.

What lives **here** is only what the guidance does not cover:

| File | Why it is not upstream |
|---|---|
| `dashboard.tf` | The FastAPI data plane as a second ECS service behind the same ALB, on `/dash/*`. The guidance deploys the gateway only. |
| `alb_streaming.tf` | ALB idle timeout raised for SSE and streaming completions. The guidance leaves the default, which cuts both. |
| `budget.tf` | AWS Budgets cap plus the billing alarm. Day-one item, not a pre-flight one. |
| `variables.tf` | Demo-sized overrides of the guidance defaults, which are production-sized. See the cost note below. |

## Cost note - the guidance defaults are not demo defaults

The upstream `.env.template` defaults are sized for production and would cost
several hundred dollars a month:

| Setting | Upstream default | Here | Why |
|---|---|---|---|
| `DESIRED_CAPACITY` / `MIN_CAPACITY` | 2 / 2 | 1 / 1 | One task carries stage load. Horizontal scaling is the production story, not the demo's. |
| `ECS_VCPUS` | 2 | 1 | Stage load is ~2 req/s, not 3000. |
| `RDS_INSTANCE_CLASS` | db.t3.small | db.t4g.micro | Virtual keys and spend rows only. |
| `REDIS_NUM_CACHE_CLUSTERS` | 2 | 1 | A replica protects nothing on a throwaway demo. |

Keeping the upstream defaults for a three-day demo is the single easiest way to
turn this talk into an expensive one.

## Deploy

Do not run `terraform apply` here first. Run `infra/bootstrap.sh`, which
sequences the whole thing in the order that actually works.
