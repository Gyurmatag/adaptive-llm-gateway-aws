"""judge + cost + latency -> reward.

This module is the reason branch B exists.

LiteLLM's built-in adaptive router learns from an implicit user-satisfaction
signal read off the conversation ("thanks!" on a later turn). There is no
documented way to post an explicit quality score to it. Synthetic load has no
user in it and never says thanks, and neither does back-office batch traffic -
so on this workload the built-in bandit would never receive a reward at all.

Here the reward is programmatic: a small judge model scores a sampled fraction
of answers, and that score - combined with a latency SLA - is what moves the
posteriors. See handoff/branch-decision.md.
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import time
from typing import Any

from router import shadow
from router.state import GLOBAL_CLASS, STATE

JUDGE_MODEL = os.environ.get("JUDGE_MODEL_NAME", "judge")
JUDGE_SAMPLE_RATE = float(os.environ.get("JUDGE_SAMPLE_RATE", "0.30"))
JUDGE_THRESHOLD = float(os.environ.get("JUDGE_SCORE_THRESHOLD", "0.7"))
LATENCY_SLA_MS = float(os.environ.get("ROUTER_LATENCY_SLA_MS", "12000"))
DECAY_LAMBDA = float(os.environ.get("ROUTER_DECAY_LAMBDA", "0.985"))
DECAY_EVERY = int(os.environ.get("ROUTER_DECAY_EVERY", "25"))
STRATIFY = os.environ.get("ROUTER_STRATIFY", "false").lower() == "true"

JUDGE_PROMPT = """You are grading an assistant answer for basic quality.

Question:
{question}

Answer:
{answer}

Score the answer from 0.0 to 1.0 on whether it is correct, responsive and
complete enough to send to a user. Reply with ONLY a JSON object:
{{"score": <float 0.0-1.0>}}"""

# The priciest arm's per-token cost, used for the counterfactual savings
# counter. Set at startup by the router once it has seen the model list.
MAX_COST_PER_TOKEN = 0.000015

# The judge is a deployment inside the proxy's Router, not a bare provider
# model, so it must be called through the Router. litellm.acompletion(model=
# "judge") cannot resolve a router group name and fails with "LLM Provider NOT
# provided" - which the judge's own except-clause then swallows, leaving the
# posteriors silently frozen. proxy_hook sets this at install time.
ROUTER = None

# asyncio.create_task() returns a task that is only weakly referenced by the
# loop. Without keeping a strong reference the task can be garbage collected
# before it ever runs, which is exactly the kind of bug that looks like "the
# judge is just slow" until nothing ever updates.
_PENDING: set = set()


def spawn(coro) -> None:
    task = asyncio.ensure_future(coro)
    _PENDING.add(task)
    task.add_done_callback(_PENDING.discard)

_AUDIT_PATH = os.environ.get("ROUTER_AUDIT_PATH", "router/state/audit.jsonl")

# The router's posteriors live in the GATEWAY process; the dashboard is a
# separate service on ECS. They share state through the state file, so the
# gateway has to actually write it - throttled, because a write per request
# would be pointless churn at 3 req/s.
_PERSIST_INTERVAL_S = float(os.environ.get("ROUTER_PERSIST_INTERVAL", "1.0"))
_last_persist = 0.0


def _persist(force: bool = False) -> None:
    global _last_persist
    now = time.time()
    if not force and (now - _last_persist) < _PERSIST_INTERVAL_S:
        return
    _last_persist = now
    try:
        STATE.save()
    except OSError:
        pass


def audit(event: dict) -> None:
    """Append-only audit log of every routing decision and its reason.

    'The router changed its mind' is not an answer for a risk committee.
    Slide 19, point 4.
    """
    try:
        os.makedirs(os.path.dirname(_AUDIT_PATH), exist_ok=True)
        with open(_AUDIT_PATH, "a") as fh:
            fh.write(json.dumps({"ts": time.time(), **event}) + "\n")
    except OSError:
        # Audit logging must never take the request path down.
        pass


def task_class_of(messages: list[dict] | None) -> str:
    """Crude task classifier for stratified posteriors.

    Deliberately simple and deliberately named as a weakness on stage: the
    built-in adaptive router classifies into 7 request types properly. This is
    the cheap version, and it exists so the stratification argument on slide 19
    is demonstrated in code rather than only asserted.
    """
    if not STRATIFY or not messages:
        return GLOBAL_CLASS
    text = " ".join(str(m.get("content", "")) for m in messages).lower()
    if any(k in text for k in ("code", "function", "python", "sql", "bug", "refactor")):
        return "code"
    if any(k in text for k in ("summar", "tl;dr", "shorten", "condense")):
        return "summarization"
    if any(k in text for k in ("why", "explain", "compare", "analyse", "analyze", "trade-off")):
        return "reasoning"
    return "factual"


def _extract_score(raw: str) -> float | None:
    """Parse the judge's reply. Tolerant, because judges wander off format."""
    try:
        return max(0.0, min(1.0, float(json.loads(raw)["score"])))
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        pass
    import re

    m = re.search(r'"?score"?\s*[:=]\s*([01]?\.?\d+)', raw)
    if m:
        try:
            return max(0.0, min(1.0, float(m.group(1))))
        except ValueError:
            return None
    return None


async def judge_score(question: str, answer: str) -> float | None:
    """Score an answer with the small judge model. Never raises."""
    try:
        if ROUTER is None:
            audit({"event": "reward_error", "error": "judge router not set"})
            return None
        # _original_acompletion, not the wrapped one: the wrapper would observe
        # the judge's own call and schedule a judge call for it, recursively.
        call = getattr(ROUTER, "_thompson_original_acompletion", None) or ROUTER.acompletion
        resp = await call(
            model=JUDGE_MODEL,
            messages=[{"role": "user", "content": JUDGE_PROMPT.format(
                question=question[:2000], answer=answer[:2000])}],
            max_tokens=32,
            temperature=0.0,
            # THE JUDGE MUST NEVER BE CACHED.
            #
            # Judge prompts share a long fixed template and differ only in the
            # embedded question and answer, so they embed extremely close
            # together and the semantic cache matches them against each other.
            # The observed effect: every single judgement returned the SAME
            # score (0.63) for 404 consecutive rewards, every arm was marked a
            # failure because 0.63 sat under the 0.7 threshold, and all four
            # posteriors collapsed to a mean of 0.012 while the dashboard
            # looked perfectly healthy.
            #
            # A cached judge is worse than no judge: it is a constant reward
            # signal wearing the costume of a real one.
            caching=False,
        )
        return _extract_score(resp.choices[0].message.content or "")
    except Exception as e:  # noqa: BLE001
        # A judge failure must not fail the user's request or corrupt the
        # posteriors. Returning None means "no reward this time" - but it is
        # audited, because a permanently broken judge is indistinguishable
        # from a quiet one otherwise.
        audit({"event": "judge_error", "error": f"{type(e).__name__}: {e}"[:200]})
        return None


def _reward(score: float | None, latency_ms: float) -> bool | None:
    """Bernoulli 'good enough': judge clears threshold AND latency inside SLA."""
    if score is None:
        return None
    return bool(score >= JUDGE_THRESHOLD and latency_ms <= LATENCY_SLA_MS)


async def score_and_update(
    arm: str,
    question: str,
    answer: str,
    latency_ms: float,
    cost_usd: float,
    tokens: int,
    task_class: str = GLOBAL_CLASS,
) -> None:
    """Async reward path. Sampled, off the hot path, never blocks the response."""
    if random.random() > JUDGE_SAMPLE_RATE:
        # Not sampled: still bank the cost and token volume so the savings
        # counter stays accurate, but do not move the posterior.
        async with STATE._lock:
            a = STATE.arm(arm, task_class)
            a.total_latency_ms += latency_ms
            a.total_cost_usd += cost_usd
            a.total_tokens += tokens
            STATE.actual_spend_usd += cost_usd
            STATE.total_tokens += tokens
            STATE.counterfactual_spend_usd += tokens * MAX_COST_PER_TOKEN
        _persist()
        return

    score = await judge_score(question, answer)
    success = _reward(score, latency_ms)
    if success is None:
        return

    async with STATE._lock:
        STATE.record_outcome(
            arm, success, task_class=task_class, latency_ms=latency_ms,
            cost_usd=cost_usd, tokens=tokens,
            max_cost_per_token=MAX_COST_PER_TOKEN,
        )
        decayed = STATE.maybe_decay(DECAY_LAMBDA, DECAY_EVERY)

    audit({
        "event": "reward", "arm": arm, "task_class": task_class,
        "judge_score": score, "success": success,
        "latency_ms": round(latency_ms, 1), "cost_usd": cost_usd,
        "decay_applied": decayed,
    })
    _persist()


# ------------------------------------------------------------ LiteLLM callbacks

def _usage(response: Any) -> tuple[int, float]:
    try:
        u = response.get("usage") if isinstance(response, dict) else response.usage
        total = int(getattr(u, "total_tokens", None) or u["total_tokens"])
    except (AttributeError, KeyError, TypeError, ValueError):
        total = 0
    cost = 0.0
    try:
        import litellm
        cost = float(litellm.completion_cost(completion_response=response) or 0.0)
    except Exception:
        pass
    return total, cost


def _arm_name(kwargs) -> str:
    """Which deployment actually served this request.

    LiteLLM exposes the deployment identity in several places depending on
    version and code path, so check them in order of specificity. Falling back
    to kwargs["model"] alone is wrong here: for a grouped router that is the
    GROUP name ("demo-router"), not the arm, and every posterior would collapse
    onto a single fictional arm.
    """
    lp = kwargs.get("litellm_params") or {}
    for src in (
        (lp.get("model_info") or {}).get("id"),
        (lp.get("metadata") or {}).get("model_info", {}).get("id")
        if isinstance((lp.get("metadata") or {}).get("model_info"), dict) else None,
        (lp.get("metadata") or {}).get("deployment_model_name"),
        (kwargs.get("standard_logging_object") or {}).get("model_id"),
        (kwargs.get("model_info") or {}).get("id"),
    ):
        if src and isinstance(src, str):
            return src
    return kwargs.get("model") or "unknown"


def _schedule(coro) -> bool:
    """Run the reward coroutine without ever blocking the response path."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        loop.create_task(coro)
        return True
    # Called from a worker thread with no running loop: run it to completion on
    # a private loop. The response has already been returned to the client by
    # this point, so this costs the caller nothing.
    try:
        asyncio.run(coro)
        return True
    except RuntimeError:
        coro.close()
        return False


def on_success(kwargs, response, start_time, end_time):
    """LiteLLM success callback. Fans the reward job out and returns at once.

    Failures are AUDITED rather than swallowed. An earlier version caught
    everything with a bare pass, and the result was a reward loop that silently
    never ran: 267 routing decisions, zero posterior updates, and a dashboard
    that looked alive because traffic was flowing.
    """
    try:
        arm = _arm_name(kwargs)
        messages = kwargs.get("messages") or []
        question = str(messages[-1].get("content", "")) if messages else ""
        try:
            answer = response.choices[0].message.content or ""
        except (AttributeError, IndexError, KeyError, TypeError):
            answer = ""
        latency_ms = (end_time - start_time).total_seconds() * 1000.0
        tokens, cost = _usage(response)
        tc = task_class_of(messages)

        if shadow.enabled():
            shadow.record_actual(arm, tc, cost, latency_ms)

        if not _schedule(score_and_update(
                arm, question, answer, latency_ms, cost, tokens, tc)):
            audit({"event": "reward_error", "arm": arm, "error": "no event loop"})
    except Exception as e:  # noqa: BLE001 - must never fail the request
        audit({"event": "reward_error", "error": f"{type(e).__name__}: {e}"})


def on_failure(kwargs, response, start_time, end_time):
    """Failure callback. Counts the error the dashboard must keep at zero."""
    try:
        STATE.total_errors += 1
        audit({"event": "failure", "arm": _arm_name(kwargs),
               "error": str(response)[:300]})
        _persist()
    except Exception as e:  # noqa: BLE001
        audit({"event": "failure_error", "error": f"{type(e).__name__}: {e}"})
