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

# Bake this repo's router into the gateway image and hand the upstream stack
# our model fleet. Both are copied on every fetch so an upstream update cannot
# silently drop them.
echo "==> applying required patches to the fetched guidance"
python3 patch-upstream.py

echo "==> layering the custom router into the gateway image"
cp gateway.Dockerfile upstream/Dockerfile
mkdir -p upstream/config
# The deployed stack gets a TRANSFORMED config - see make-deployed-config.py.
python3 make-deployed-config.py

# deploy.sh builds from the upstream directory, so the router has to be inside
# that build context.
rm -rf upstream/router && cp -R ../router upstream/router
rm -rf upstream/router/state && mkdir -p upstream/router/state
rm -rf upstream/router/__pycache__
rm -rf upstream/dashboard && cp -R ../dashboard upstream/dashboard
rm -rf upstream/dashboard/__pycache__

echo
echo "==> upstream ready at infra/upstream"
echo "    Deploy with: cd infra/upstream && ./deploy.sh"
echo "    Read infra/DEPLOY.md FIRST - the defaults are production-sized and"
echo "    there are four cache gotchas that each fail with a different symptom."
