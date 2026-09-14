# Provider and shared configuration.
#
# NOTE ON WHAT IS *NOT* HERE.
#
# Section 6.2 of the talk plan sketches this file as holding ECS, ALB, Aurora,
# ElastiCache and Secrets Manager. It deliberately does not, and the reason is
# the talk's own argument.
#
# Those resources come from the official AWS Multi-Provider Generative AI
# Gateway guidance, fetched by infra/fetch-upstream.sh. Re-implementing them
# here would be exactly the mistake slide 5 warns about: teams that believe
# they must build usually only need to deploy. A hand-rolled ECS + Aurora +
# ElastiCache stack in this repo would contradict the talk while claiming to
# demonstrate it.
#
# What lives in this directory is only the part the guidance does not cover:
#
#   budget.tf         cost cap and billing alarm (day-one, not pre-flight)
#   dashboard.tf      the FastAPI data plane as a second ECS service
#   alb_streaming.tf  reads the upstream ALB; the idle timeout is set by
#                     bootstrap.sh, because it is a one-attribute change to a
#                     resource another stack owns
#
# Deploy order is in infra/DEPLOY.md and it matters.

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # Every resource carries the project tag so Cost Explorer can attribute the
  # demo's spend, which is the check to run the week after the conference.
  default_tags {
    tags = {
      Project      = var.project
      ManagedBy    = "terraform"
      Ephemeral    = "true"
      TeardownWith = "infra/teardown.sh"
    }
  }
}

# Billing metrics only ever publish to us-east-1, regardless of where the
# stack itself runs.
provider "aws" {
  alias  = "billing"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
    }
  }
}
