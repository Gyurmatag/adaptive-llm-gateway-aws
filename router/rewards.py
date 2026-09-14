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

from router.state import STATE, GLOBAL_CLASS
from router import shadow

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

_AUDIT_PATH = os.environ.get("ROUTER_AUDIT_PATH", "router/state/audit.jsonl")


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
        import litellm

        resp = await litellm.acompletion(
            model=JUDGE_MODEL,
            messages=[{"role": "user", "content": JUDGE_PROMPT.format(
                question=question[:2000], answer=answer[:2000])}],
            max_tokens=32,
            temperature=0.0,
        )
        return _extract_score(resp.choices[0].message.content or "")
    except Exception:
        # A judge failure must not fail the user's request or corrupt the
        # posteriors. Returning None means "no reward this time".
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


def on_success(kwargs, response, start_time, end_time):
    """LiteLLM success callback. Fans the reward job out and returns at once."""
    try:
        arm = (kwargs.get("litellm_params", {}).get("metadata", {}) or {}).get(
            "deployment_model_name") or kwargs.get("model") or "unknown"
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

        loop = asyncio.get_event_loop()
        loop.create_task(score_and_update(
            arm, question, answer, latency_ms, cost, tokens, tc))
    except Exception:
        pass


def on_failure(kwargs, response, start_time, end_time):
    """Failure callback. Counts the error the dashboard must keep at zero."""
    try:
        arm = kwargs.get("model") or "unknown"
        STATE.total_errors += 1
        audit({"event": "failure", "arm": arm, "error": str(response)[:300]})
    except Exception:
        pass
