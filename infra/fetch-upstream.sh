#!/usr/bin/env bash
# Fetch the official AWS guidance that this deployment is built on.
#
# It is fetched rather than vendored, deliberately. Copying 100+ files of
# AWS-owned code into an MIT-licensed repo muddies the licensing of both, and
# a pinned copy goes stale silently. Cloning keeps the provenance obvious.
set -euo pipefail
cd "$(dirname "$0")"

REPO="https://github.com/aws-solutions-library-samples/guidance-for-multi-provider-generative-ai-gateway-on-aws.git"
REF="${UPSTREAM_REF:-main}"

if [ -d upstream/.git ]; then
  echo "==> updating existing upstream checkout"
  git -C upstream fetch --depth 1 origin "$REF" && git -C upstream checkout -q FETCH_HEAD
else
  echo "==> cloning the official AWS guidance"
  rm -rf upstream
  git clone --depth 1 --branch "$REF" "$REPO" upstream
fi

echo
echo "==> upstream ready at infra/upstream"
echo "    Deploy with: cd infra/upstream && ./deploy.sh"
echo "    Read infra/DEPLOY.md FIRST - the defaults are production-sized and"
echo "    there are four cache gotchas that each fail with a different symptom."
