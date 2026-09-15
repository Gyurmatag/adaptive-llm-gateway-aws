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

# The posteriors are in-process state. On ECS this path is the task's own
# writable layer: it does NOT survive a task replacement, which is the reason
# snapshot mode exists for the production path (see router/policy.py).
RUN mkdir -p /app/router_state
ENV ROUTER_STATE_PATH=/app/router_state/posteriors.json \
    ROUTER_AUDIT_PATH=/app/router_state/audit.jsonl \
    ROUTER_SHADOW_PATH=/app/router_state/shadow.jsonl
