#!/usr/bin/env python3
"""Patches applied to the fetched AWS guidance.

Kept as an explicit, re-runnable script rather than hand edits, because
infra/upstream/ is fetched and any manual change is silently lost on the next
fetch - taking the deployment down with it.

Each patch records WHY, because "we deleted a resource from AWS's own guidance"
needs a reason attached.
"""
from __future__ import annotations

import sys
from pathlib import Path

UPSTREAM = Path(__file__).parent / "upstream"


def drop_appregistry() -> str:
    """Remove the Service Catalog AppRegistry application.

    The guidance creates one to track the solution's resources. As of
    30 July 2026 the service is in maintenance mode and REFUSES new customers:

        AccessDeniedException: AWS Service Catalog AppRegistry is in
        maintenance mode and is no longer available to new customers as of
        July 30, 2026.

    So the official AWS guidance does not deploy on an account created after
    that date. Nothing else in the stack references this resource - it is pure
    solution-tracking metadata - so removing it is safe and is the only way to
    get the rest of the stack up.
    """
    p = UPSTREAM / "litellm-terraform-stack" / "providers.tf"
    s = p.read_text()
    start = s.find('resource "aws_servicecatalogappregistry_application" "solution_application"')
    if start == -1:
        return "appregistry: already absent"
    depth, i = 0, s.index("{", start)
    for j in range(i, len(s)):
        if s[j] == "{":
            depth += 1
        elif s[j] == "}":
            depth -= 1
            if depth == 0:
                end = j + 1
                break
    else:
        return "appregistry: could not find the closing brace, NOT patched"
    s = s[:start] + (
        "# REMOVED by infra/patch-upstream.py: Service Catalog AppRegistry is in\n"
        "# maintenance mode and refuses new customers as of 30 July 2026, so this\n"
        "# resource makes the official guidance undeployable on a new account.\n"
        "# Nothing references it.\n"
    ) + s[end:]
    p.write_text(s)
    return "appregistry: removed"


def main() -> int:
    if not UPSTREAM.exists():
        print("infra/upstream missing - run infra/fetch-upstream.sh first", file=sys.stderr)
        return 1
    for line in (drop_appregistry(),):
        print("  " + line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
