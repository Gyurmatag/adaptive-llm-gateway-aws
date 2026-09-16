# Gateway image for ECS: the official LiteLLM image plus this repo's router.
#
# The upstream guidance ships a passthrough Dockerfile (FROM the LiteLLM image
# and nothing else), which is correct for a stock deployment. Branch B needs
# the custom strategy INSIDE the image, because the proxy rejects
# `routing_strategy: custom` and router/proxy_hook.py has to be importable as
# a LiteLLM callback at startup.
#
# infra/fetch-upstream.sh copies this over the upstream Dockerfile, so a
# re-fetch does not silently drop the router and leave the deployed gateway
# round-robining with a dashboard that looks fine.
ARG LITELLM_VERSION=main-v1.82.3-stable.patch.2
FROM ghcr.io/berriai/litellm:${LITELLM_VERSION}

# Importable as `router.proxy_hook` from the image's /app working directory.
COPY router/ /app/router/

# The dashboard data plane is mounted onto the gateway's own FastAPI app at
# /dash, because the posteriors are in-process state that a separate Fargate
# task cannot read. See router/proxy_hook.py::_mount_dashboard.
COPY dashboard/ /app/dashboard/

# The posteriors are in-process state. On ECS this path is the task's own
# writable layer: it does NOT survive a task replacement, which is the reason
# snapshot mode exists for the production path (see router/policy.py).
RUN mkdir -p /app/router_state
ENV ROUTER_STATE_PATH=/app/router_state/posteriors.json \
    ROUTER_AUDIT_PATH=/app/router_state/audit.jsonl \
    ROUTER_SHADOW_PATH=/app/router_state/shadow.jsonl

# Router tuning, baked in.
#
# The upstream guidance's Terraform builds the ECS task definition and has no
# hook for arbitrary environment variables, so there is nowhere else to put
# these. Without them the deployed gateway silently runs the library defaults -
# observed on the first deploy: "[thompson] installed: gamma=0.35" against the
# 0.10 that the convergence sweep actually selected.
#
# These values come from scripts/simulate_convergence.py --sweep plus the real
# Bedrock rehearsal. See handoff/e2e-test-report.md.
ENV ROUTER_GAMMA=0.10 \
    ROUTER_MIN_OBS=120 \
    ROUTER_EXPLORE_P=0.40 \
    ROUTER_DECAY_LAMBDA=0.995 \
    ROUTER_DECAY_EVERY=40 \
    # Grade EVERY answer, not half of them. With a background load generator
    # running at 3/s, half was plenty and saved judge calls. Nothing runs in
    # the background now - evidence only exists because someone pressed a
    # button - so every answer has to count or the curves never fill in.
    JUDGE_SAMPLE_RATE=1.0 \
    JUDGE_SCORE_THRESHOLD=0.85 \
    ROUTER_GROUP=demo-router \
    ROUTER_MODE=learn \
    ROUTER_ROLLING_WINDOW=150 \
    # Slide 19, "stop it optimising the wrong thing".
    #
    # QUALITY_FLOOR: the router may chase a cheaper arm only while that arm's
    # posterior mean stays above this. Set below every arm's current mean, so
    # it is a live guardrail rather than a thumb on the scale - raise it past
    # an arm's mean and that arm is excluded from routing outright.
    ROUTER_QUALITY_FLOOR=0.50 \
    # STRATIFY: score easy and hard traffic separately. Without it a bandit
    # wins the easy 80% of traffic and quietly gets worse at the hard 20%,
    # which is the correctness problem the production slide names. The
    # dashboard sums the classes for its headline panels, so turning this on
    # does not empty the curves - see dashboard/app.py _merged_bucket.
    ROUTER_STRATIFY=true
