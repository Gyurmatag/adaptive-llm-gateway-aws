#!/usr/bin/env python3
"""Generate the DEPLOYED gateway config from config/config.yaml.

One transform: the semantic cache is repointed from ElastiCache to a Redis
Stack SIDECAR running inside the same ECS task, reachable on localhost.

LiteLLM's semantic cache goes through redisvl, which needs the RediSearch
command set. ElastiCache does not provide it - not on Redis OSS (this stack
runs 7.1.0), and not on Valkey unless the search module is enabled on the
engine version. The failure is not graceful: the gateway dies during startup
immediately after logging "passed cache type=redis-semantic", writes no error
to the task log at all, and the ECS task then cycles forever while the load
balancer serves 502.

This used to degrade to plain `redis`, which meant Demo 2 silently did not work
on the deployed stack: repeating a question hit an exact-match cache, but
REWORDING it - the whole point of the demo - missed every time and no
x-litellm-semantic-similarity header was ever returned. Measured on the
deployed URL: same question 0.738s -> 0.068s, reworded question 1.105s and a
cache miss.

So the task now runs `redis/redis-stack-server` as a sidecar. The gateway
reaches it on localhost:6379 with no password and no TLS, which is also the
shape redisvl wants. ElastiCache is still used for everything else LiteLLM
needs Redis for - router cooldowns, spend tracking - via router_settings.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE.parent / "config" / "config.yaml"
DST = HERE / "upstream" / "config" / "config.yaml"

REPLACEMENT = """  cache: true
  cache_params:
    # redis-semantic against the Redis Stack SIDECAR in this task, not against
    # ElastiCache. ElastiCache for Redis OSS has no RediSearch, and pointing
    # redisvl at it kills the gateway during startup with nothing in the log.
    #
    # Demo 2 needs REWORDED questions to hit. Plain `redis` only matches
    # identical strings, so the demo looked fine when you repeated a question
    # and silently failed the moment you rephrased one.
    type: redis-semantic
    # localhost: the sidecar shares the task's network namespace. No password
    # and no TLS, which is what redisvl wants - host/port without a password
    # makes it raise "Missing required Redis configuration: REDIS_PASSWORD".
    # Nothing outside the task can reach it.
    redis_url: redis://localhost:6379
    similarity_threshold: 0.85
    ttl: 900
    # A PROVIDER-QUALIFIED embedding model, not a model_list group name: the
    # semantic cache calls litellm.embedding() directly rather than going
    # through the Router, so a group name fails with "LLM Provider NOT
    # provided" and the gateway does not start.
    redis_semantic_cache_embedding_model: bedrock/amazon.titan-embed-text-v2:0
    semantic_cache_scope: end_user
"""


def resolve_env_refs(text: str) -> tuple[str, list[str]]:
    """Substitute os.environ/VAR references that only exist locally.

    The config reaches the deployed gateway through S3, and the ECS task
    definition only carries the variables the guidance's Terraform sets. Any
    `os.environ/VAR` the task does not define resolves to None, and LiteLLM
    then dies on it with a message that names neither the variable nor the
    model:

        if "ollama" in litellm_model_name and litellm_model_api_base is None:
        TypeError: argument of type 'NoneType' is not iterable

    Substituting here is safe for secrets hygiene: the generated file goes to
    S3 and to infra/upstream/, both of which are gitignored. The ARN carries
    the account id and must never reach a commit.
    """
    env: dict[str, str] = {}
    envfile = HERE.parent / "config" / ".env"
    if envfile.exists():
        for line in envfile.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()

    # Only variables the ECS task does NOT define. Everything the guidance
    # already injects (REDIS_*, DATABASE_URL, AWS_REGION) stays a reference.
    task_provides = {
        "REDIS_HOST", "REDIS_PORT", "REDIS_PASSWORD", "REDIS_SSL",
        "DATABASE_URL", "AWS_REGION", "LITELLM_MASTER_KEY",
    }
    substituted: list[str] = []
    for name in sorted(set(re.findall(r"os\.environ/([A-Z0-9_]+)", text))):
        if name in task_provides:
            continue
        val = env.get(name, "")
        if not val:
            print(f"    WARNING: os.environ/{name} is referenced but not set "
                  f"locally and not provided by the task", file=sys.stderr)
            continue
        text = text.replace(f"os.environ/{name}", val)
        substituted.append(name)
    return text, substituted


def main() -> int:
    if not SRC.exists():
        print(f"missing {SRC}", file=sys.stderr)
        return 1
    src = SRC.read_text()

    pattern = re.compile(r"^  cache: true\n  cache_params:\n(?:^ {4}.*\n|^\s*\n)*", re.M)
    out, n = pattern.subn(REPLACEMENT, src, count=1)
    if n == 0:
        print("WARNING: cache block not found; deployed config is unchanged",
              file=sys.stderr)
    out, subs = resolve_env_refs(out)
    DST.parent.mkdir(parents=True, exist_ok=True)
    DST.write_text(out)
    print(f"    deployed config written ({n} cache block transformed, "
          f"{len(subs)} env ref(s) resolved: {', '.join(subs) or 'none'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
