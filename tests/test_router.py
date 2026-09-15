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


# Must match ROUTER_GROUP: the strategy only registers arms for its own group,
# so a different name exercises the direct-addressing path instead.
GROUP = "demo-router"


def _pick(router, n=300, **kw):
    async def go():
        out = {}
        for _ in range(n):
            d = await router.async_get_available_deployment(
                GROUP, messages=[{"content": "hello"}], **kw)
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


def test_direct_addressing_bypasses_the_bandit():
    """Demo 1 addresses deployments by name; those must not become arms."""
    from router.state import STATE

    before = {tc: set(b) for tc, b in STATE.arms.items()}

    async def go():
        return await FakeRouter(DEPS).async_get_available_deployment(
            "premium", messages=[{"content": "hello"}])

    asyncio.run(go())
    after = {tc: set(b) for tc, b in STATE.arms.items()}
    assert after == before, "direct addressing must not register new arms"


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


# --------------------------------------------------------------- shadow mode
# These two modules are the ones slide 19 claims a production story on, so they
# get tested rather than merely shipped.

def test_shadow_mode_serves_the_incumbent_but_logs_the_bandit(tmp_path, monkeypatch):
    """Shadow mode must not change what is served. That is its whole point."""
    monkeypatch.setenv("ROUTER_SHADOW", "true")
    monkeypatch.setenv("ROUTER_INCUMBENT", "premium")
    monkeypatch.setenv("ROUTER_SHADOW_PATH", str(tmp_path / "shadow.jsonl"))

    import importlib

    from router import shadow as sh
    importlib.reload(sh)
    import router.thompson_router as tr
    importlib.reload(tr)

    class R(tr.ThompsonRouter):
        async def _healthy(self, model, rk):
            return DEPS

    r = R()
    served = set()

    async def go():
        for _ in range(120):
            d = await r.async_get_available_deployment(
                GROUP, messages=[{"content": "hello"}])
            served.add(d["model_name"])

    asyncio.run(go())

    # Every request served by the incumbent, regardless of what the bandit wanted.
    assert served == {"premium"}, f"shadow mode changed serving: {served}"

    report = sh.report(tmp_path / "shadow.jsonl")
    assert report["requests"] == 120
    # The bandit's preference was recorded even though it never served.
    assert set(report["would_choose"]) <= {"premium", "cheap"}
    assert 0.0 <= report["agreement_rate"] <= 1.0

    monkeypatch.delenv("ROUTER_SHADOW")
    importlib.reload(sh)
    importlib.reload(tr)


def test_snapshot_mode_is_deterministic_across_restarts(tmp_path, monkeypatch):
    """A frozen policy must serve the same arm every time, and survive reload."""
    from router import policy as pol

    st = RouterState()
    st.ensure_arms(["premium", "cheap"])
    for i in range(150):
        st.record_outcome("cheap", i % 6 != 0, cost_usd=1e-4, tokens=400,
                          max_cost_per_token=1.5e-5)
        st.record_outcome("premium", True, cost_usd=3e-3, tokens=400,
                          max_cost_per_token=1.5e-5)

    path = tmp_path / "policy.json"
    exported = pol.export(st, gamma=0.35, path=path)

    monkeypatch.setenv("ROUTER_MODE", "snapshot")
    monkeypatch.setenv("ROUTER_POLICY_PATH", str(path))

    import importlib

    from router import policy as pol2
    importlib.reload(pol2)
    import router.thompson_router as tr
    importlib.reload(tr)

    class R(tr.ThompsonRouter):
        async def _healthy(self, model, rk):
            return DEPS

    async def go(router):
        return {(await router.async_get_available_deployment(
            GROUP, messages=[{"content": "x"}]))["model_name"] for _ in range(80)}

    first = asyncio.run(go(R()))
    # A second instance stands in for a restart: same artifact, same behaviour.
    second = asyncio.run(go(R()))

    assert len(first) == 1, f"snapshot serving was not deterministic: {first}"
    assert first == second, "a restart changed the served arm"
    assert first == {exported.best["_all"]}

    monkeypatch.delenv("ROUTER_MODE")
    importlib.reload(tr)


def test_stratification_keeps_separate_posteriors_per_task_class(monkeypatch):
    """Slide 19 point 6: a context-free bandit optimises the traffic MIX.

    With 80% easy traffic, a single posterior converges to whatever wins the
    easy 80% and the hard 20% degrades silently. ROUTER_STRATIFY=true keeps a
    posterior per task class so the two cannot be averaged together.
    """
    monkeypatch.setenv("ROUTER_STRATIFY", "true")

    import importlib

    import router.rewards as rw
    importlib.reload(rw)

    assert rw.task_class_of([{"content": "refactor this python function"}]) == "code"
    assert rw.task_class_of([{"content": "capital of Hungary"}]) == "factual"

    st = RouterState()
    # cheap wins the easy 80%, premium wins the hard 20%
    for _ in range(400):
        st.record_outcome("cheap", True, task_class="factual")
        st.record_outcome("premium", False, task_class="factual")
    for _ in range(100):
        st.record_outcome("cheap", False, task_class="code")
        st.record_outcome("premium", True, task_class="code")

    assert st.leader("factual") == "cheap"
    assert st.leader("code") == "premium", (
        "stratification failed: the hard class was swamped by the easy one")

    # And the un-stratified view is exactly the failure mode being warned about.
    flat = RouterState()
    for _ in range(400):
        flat.record_outcome("cheap", True)
        flat.record_outcome("premium", False)
    for _ in range(100):
        flat.record_outcome("cheap", False)
        flat.record_outcome("premium", True)
    assert flat.leader() == "cheap", (
        "the context-free bandit should converge to the easy-traffic winner - "
        "that is the point being made on slide 19")

    monkeypatch.delenv("ROUTER_STRATIFY")
    importlib.reload(rw)


def test_breaker_excludes_arm_and_is_visible():
    """A broken-out arm must be withheld from routing AND reported as disabled.

    The regression this locks down: kill_primary.sh writes an arm into the
    DISABLED file, the rehearsal never cleared it, and the router then dropped
    that arm from every selection in silence. The dashboard kept drawing it with
    the posterior it had when it was switched off, so it read as a merely
    under-observed arm. It cost a whole rehearsal: ipr-nova took 0 selections
    out of 99, minobs froze at 36, and the convergence gate failed for a reason
    that had nothing to do with the bandit.
    """
    import importlib
    import tempfile

    import router.state as rstate

    with tempfile.TemporaryDirectory() as d:
        os.environ["ROUTER_STATE_DIR"] = d
        importlib.reload(rstate)
        import dashboard.app as dash
        importlib.reload(dash)

        # Nothing disabled -> nothing reported.
        assert dash.disabled_arms() == []

        (rstate.STATE_PATH.parent).mkdir(parents=True, exist_ok=True)
        (rstate.STATE_PATH.parent / "DISABLED").write_text("ipr-nova\nclaude-sonnet\n")

        # The breaker file is what the dashboard reports, read live.
        assert dash.disabled_arms() == ["claude-sonnet", "ipr-nova"]

        # And the snapshot marks them, so a switched-off arm can never again be
        # mistaken for one that is merely waiting for observations.
        rstate.STATE.ensure_arms(["ipr-nova", "claude-sonnet", "nova-lite"],
                                 rstate.GLOBAL_CLASS)
        snap = dash.snapshot()
        assert snap["disabled_arms"] == ["claude-sonnet", "ipr-nova"]
        flags = {a["model"]: a["disabled"] for a in snap["arms"]}
        assert flags["ipr-nova"] is True
        assert flags["claude-sonnet"] is True
        assert flags["nova-lite"] is False
