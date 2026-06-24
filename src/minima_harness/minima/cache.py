"""Semantic response cache — a free 'recommendation' when a near-duplicate prompt repeats.

A cache HIT returns a prior response with ZERO LLM cost (and ~no latency). Similarity
defaults to a cheap, dependency-free normalized-token Jaccard, which catches exact and
near-duplicate coding prompts (the realistic hit case for a coding agent); inject
``similarity_fn`` (e.g. embedding cosine via Mubit's ANN) for true semantic matching.
Bounded LRU with an optional TTL. Disabled by default at the call site
(``HarnessConfig.cache_enabled``); a too-loose threshold risks stale hits, so it ships off.
"""

from __future__ import annotations

import re
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

_WORD = re.compile(r"[a-z0-9_]+")


def _tokens(text: str) -> set[str]:
    return set(_WORD.findall(text.lower()))


def jaccard(a: str, b: str) -> float:
    """Token-set Jaccard similarity in [0, 1] (cheap, dependency-free, paraphrase-blind)."""
    ta, tb = _tokens(a), _tokens(b)
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


@dataclass(slots=True)
class CacheHit:
    response: str
    similarity: float
    prompt: str


SimilarityFn = Callable[[str, str], float]


class SemanticCache:
    """Bounded prompt->response cache keyed by similarity. ``get`` returns the best stored
    response whose similarity clears ``threshold`` (or None)."""

    def __init__(
        self,
        *,
        threshold: float = 0.95,
        max_entries: int = 512,
        similarity_fn: SimilarityFn | None = None,
        now_fn: Callable[[], float] | None = None,
        ttl_s: float | None = None,
    ) -> None:
        self.threshold = threshold
        self.max_entries = max_entries
        self._sim = similarity_fn or jaccard
        self._now = now_fn
        self._ttl = ttl_s
        self._store: OrderedDict[str, tuple[str, float]] = OrderedDict()
        self.hits = 0
        self.misses = 0

    def get(self, prompt: str) -> CacheHit | None:
        self._expire()
        best_prompt: str | None = None
        best_resp = ""
        best_sim = 0.0
        for p, (resp, _ts) in self._store.items():
            sim = self._sim(prompt, p)
            if sim > best_sim:
                best_sim, best_prompt, best_resp = sim, p, resp
        if best_prompt is not None and best_sim >= self.threshold:
            self.hits += 1
            self._store.move_to_end(best_prompt)
            return CacheHit(response=best_resp, similarity=best_sim, prompt=best_prompt)
        self.misses += 1
        return None

    def put(self, prompt: str, response: str) -> None:
        if not response:
            return
        ts = self._now() if self._now is not None else 0.0
        self._store[prompt] = (response, ts)
        self._store.move_to_end(prompt)
        while len(self._store) > self.max_entries:
            self._store.popitem(last=False)

    def _expire(self) -> None:
        if self._ttl is None or self._now is None:
            return
        cutoff = self._now() - self._ttl
        for p in [p for p, (_r, ts) in self._store.items() if ts < cutoff]:
            self._store.pop(p, None)

    @property
    def hit_rate(self) -> float:
        total = self.hits + self.misses
        return self.hits / total if total else 0.0
