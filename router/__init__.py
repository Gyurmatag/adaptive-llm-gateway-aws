"""Adaptive routing layer for the AWS Community Day CEE 2026 gateway demo.

Branch B: a custom Thompson sampling strategy on LiteLLM's supported
`CustomRoutingStrategyBase` extension point. It exists for exactly one reason -
it accepts a programmatic judge score as reward, which the built-in adaptive
router does not. See handoff/branch-decision.md.
"""

__all__ = ["state", "rewards", "thompson_router", "policy", "shadow"]
