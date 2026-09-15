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
    DST.parent.mkdir(parents=True, exist_ok=True)
    DST.write_text(out)
    print(f"    deployed config written ({n} cache block transformed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
