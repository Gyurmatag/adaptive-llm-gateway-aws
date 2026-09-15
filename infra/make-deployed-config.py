#!/usr/bin/env python3
"""Generate the DEPLOYED gateway config from config/config.yaml.

One transform: `redis-semantic` becomes plain `redis`.

LiteLLM's semantic cache goes through redisvl, which needs the RediSearch
command set. ElastiCache does not provide it - not on Redis OSS, and not on
Valkey unless the search module is enabled on the engine version. The failure
is not graceful: the gateway dies during startup immediately after logging
"passed cache type=redis-semantic", writes no error to the task log at all,
and the ECS task then cycles forever while the load balancer serves 502.

The local standby runs Redis Stack, which does have RediSearch, so the
semantic cache demo (Demo 2) still works there. See infra/DEPLOY.md.
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
    # Plain `redis`, NOT `redis-semantic`.
    #
    # ElastiCache has no RediSearch, which redisvl requires, and the failure
    # takes the whole gateway down during startup with nothing in the logs.
    # Exact-match caching still works; semantic matching does not. The local
    # standby runs Redis Stack and keeps the semantic cache.
    #
    # host/port/password, NOT redis_url: the guidance's ECS task definition
    # sets REDIS_HOST, REDIS_PORT, REDIS_PASSWORD and REDIS_SSL - there is no
    # REDIS_URL, so `redis_url: os.environ/REDIS_URL` resolves to nothing and
    # the gateway dies in get_redis_client(). The local compose stack is the
    # opposite: redis_url is required there because redisvl rejects
    # host/port without a password. The two environments genuinely need
    # different cache wiring.
    type: redis
    host: os.environ/REDIS_HOST
    port: os.environ/REDIS_PORT
    password: os.environ/REDIS_PASSWORD
    ttl: 900
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
