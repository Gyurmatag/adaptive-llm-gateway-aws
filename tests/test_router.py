"""Unit tests for the routing layer.

These cover the four behaviours the demo depends on: the judge never gets
routed to, cold start explores, the bandit converges, and failover is lossless.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("ROUTER_AUDIT_PATH", "/tmp/test_audit.jsonl")
os.environ.setdefault("ROUTER_SESSION_AFFINITY", "true")

from router.policy import export, load  # noqa: E402
from router.rewards import _extract_score, _reward  # noqa: E402
from router.state import RouterState  # noqa: E402
from router.thompson_router import ThompsonRouter  # noqa: E402

DEPS = [
    {"model_name": "premium", "model_info": {"id": "premium", "arm": True,
     "input_cost_per_token": 3e-6, "output_cost_per_token": 1.5e-5}},
    {"model_name": "cheap", "model_info": {"id": "cheap", "arm": True,
     "input_cost_per_token": 6e-8, "output_cost_per_token": 2.4e-7}},
    {"model_name": "judge", "model_info": {"id": "judge", "arm": False,
     "input_cost_per_token": 3.5e-8, "output_cost_per_token": 1.4e-7}},
]


class FakeRouter(ThompsonRouter):
    def __init__(self, deps, **kw):
        super().__init__(**kw)
        self._deps = deps

    async def _healthy(self, model, rk):
        return self._deps


def _pick(router, n=300, **kw):
    async def go():
        out = {}
        for _ in range(n):
            d = await router.async_get_available_deployment(
                "demo", messages=[{"content": "hello"}], **kw)
            out[d["model_name"]] = out.get(d["model_name"], 0) + 1
        return out
    return asyncio.run(go())


def test_judge_is_never_routed_to():
    assert "judge" not in _pick(FakeRouter(DEPS))


def test_cold_start_explores_every_arm():
    picks = _pick(FakeRouter(DEPS), n=400)
    assert set(picks) == {"premium", "cheap"}
    assert min(picks.values()) > 0


def test_failover_is_total_and_lossless():
    alive = [d for d in DEPS if d["model_name"] != "cheap"]
    picks = _pick(FakeRouter(alive), n=200)
    assert "cheap" not in picks
    assert sum(picks.values()) == 200


def test_session_affinity_pins_one_arm():
    picks = _pick(FakeRouter(DEPS), n=40,
                  request_kwargs={"metadata": {"session_id": "s1"}})
    assert len(picks) == 1


def test_decay_moves_posterior_back_toward_prior():
    s = RouterState()
    a = s.arm("x")
    for _ in range(100):
        a.update(True)
    before = a.alpha
    a.decay(0.985)
    assert a.alpha < before


def test_policy_snapshot_is_deterministic_and_hashed(tmp_path):
    s = RouterState()
    s.ensure_arms(["cheap", "premium"])
    for i in range(80):
        s.record_outcome("cheap", True, cost_usd=1e-4, tokens=400,
                         max_cost_per_token=1.5e-5)
        s.record_outcome("premium", i % 10 != 0, cost_usd=3e-3, tokens=400,
                         max_cost_per_token=1.5e-5)
    p1 = export(s, gamma=0.35, path=tmp_path / "a.json")
    p2 = export(s, gamma=0.0, path=tmp_path / "b.json")
    assert p1.policy_id != p2.policy_id
    reloaded = load(tmp_path / "a.json")
    assert reloaded.policy_id == p1.policy_id
    assert len({reloaded.choose() for _ in range(50)}) == 1


def test_judge_score_parsing_is_tolerant():
    assert _extract_score('{"score": 0.85}') == 0.85
    assert _extract_score('sure: {"score":0.4}.') == 0.4
    assert _extract_score("score = 0.9") == 0.9
    assert _extract_score("no number") is None
    assert _extract_score('{"score": 5}') == 1.0


def test_reward_requires_quality_and_latency():
    assert _reward(0.8, 100) is True
    assert _reward(0.5, 100) is False
    assert _reward(0.9, 10**9) is False
    assert _reward(None, 10) is None
