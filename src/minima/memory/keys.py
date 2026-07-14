"""Deterministic builders for Mubit keys, lanes, fingerprints, and content gists."""

from __future__ import annotations

import hashlib
import re


def normalize_task_text(text: str, max_chars: int = 512) -> str:
    """Collapse whitespace and truncate, so paraphrases embed similarly."""
    collapsed = " ".join(text.split())
    return collapsed[:max_chars]


def task_fingerprint(text: str) -> str:
    """Stable hash of the normalized task text (non-cryptographic use)."""
    norm = " ".join(text.lower().split())
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()  # noqa: S324


# Common low-signal tokens dropped before building a fine-cluster signature, so the
# bucket reflects the task's salient nouns/verbs rather than filler.
_STOPWORDS = frozenset(
    """
    a an and are as at be by can could do does for from given has have how i if in
    into is it its me my of on or please that the their then there these this to
    use using want was we what when where which who why will with would you your
    """.split()
)
_WORD = re.compile(r"[a-z0-9]+")


def salient_signature(text: str, max_tokens: int = 4) -> str:
    """A short, stable bucket id derived from a task's most salient tokens.

    Lowercases, drops stopwords and very short tokens, keeps the longest distinct
    tokens (longer words carry more topic signal), sorts for order-independence, and
    hashes. Paraphrases that share salient vocabulary land in the same bucket; this
    is a deterministic, embedding-free approximation of a topic cluster.
    """
    tokens = [t for t in _WORD.findall(text.lower()) if len(t) >= 4 and t not in _STOPWORDS]
    if not tokens:
        return "general"
    # Distinct, longest-first, then alphabetical for a stable top-k selection.
    ranked = sorted(set(tokens), key=lambda t: (-len(t), t))[:max_tokens]
    key = " ".join(sorted(ranked))
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:8]  # noqa: S324


def task_cluster(task_type: str, difficulty: str, signature: str | None = None) -> str:
    """Cluster used as the upsert grouping key, e.g. ``code:hard`` (coarse) or
    ``code:hard:1a2b3c4d`` (fine, when a keyword signature is supplied)."""
    base = f"{task_type}:{difficulty}"
    return f"{base}:{signature}" if signature else base


def build_content(task_type: str, difficulty: str, text: str, max_chars: int = 512) -> str:
    """The text Mubit embeds: a task gist prefixed with type/difficulty tags."""
    return f"[{task_type}/{difficulty}] {normalize_task_text(text, max_chars)}"


def outcome_upsert_key(cluster: str, model_id: str) -> str:
    """One durable outcome record per (task-cluster, model)."""
    return f"minima:om:{cluster}:{model_id}"


def outcome_idempotency_key(recommendation_id: str, model_id: str) -> str:
    raw = f"{recommendation_id}:{model_id}"
    return "oc:" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]  # noqa: S324


def lesson_upsert_key(cluster: str, model_id: str) -> str:
    """One durable lesson per (task-cluster, model) so repeated verified-prod wins
    reinforce a single lesson rather than flooding LTM."""
    return f"minima:lesson:{cluster}:{model_id}"


def build_lesson_content(cluster: str, model_id: str, quality: float | None) -> str:
    """A compact NL lesson gist, embedded so reflect()/surface_strategies can cluster it."""
    verified = (
        f"verified in production at ~{quality:.0%} quality"
        if quality is not None
        else "deterministically verified in production"
    )
    return f"For {cluster} tasks, {model_id} is a reliable, cost-effective choice ({verified})."
