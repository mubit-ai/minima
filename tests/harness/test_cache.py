"""Tests for the semantic response cache."""

from __future__ import annotations

from minima_harness.minima.cache import SemanticCache, jaccard


def test_jaccard_bounds():
    assert jaccard("a b c", "a b c") == 1.0
    assert jaccard("a b c", "x y z") == 0.0
    assert jaccard("", "") == 1.0
    assert jaccard("a", "") == 0.0
    assert 0.0 < jaccard("the quick brown fox", "the quick red fox") < 1.0


def test_exact_hit_and_miss():
    c = SemanticCache(threshold=0.95)
    assert c.get("write a parser") is None  # empty -> miss
    c.put("write a parser", "here is a parser")
    hit = c.get("write a parser")
    assert hit is not None and hit.response == "here is a parser" and hit.similarity == 1.0


def test_near_duplicate_threshold():
    c = SemanticCache(threshold=0.8)
    c.put("refactor the foo function into a loop", "done")
    # a near-identical prompt clears 0.8
    assert c.get("refactor the foo function into a loop now") is not None
    # an unrelated prompt does not
    assert c.get("explain quantum tunneling briefly") is None


def test_empty_response_not_stored():
    c = SemanticCache(threshold=0.5)
    c.put("q", "")
    assert c.get("q") is None


def test_lru_eviction():
    c = SemanticCache(threshold=1.0, max_entries=2)
    c.put("a a a", "ra")
    c.put("b b b", "rb")
    c.put("c c c", "rc")  # evicts the LRU ("a a a")
    assert c.get("a a a") is None
    assert c.get("c c c") is not None


def test_ttl_expiry():
    clock = {"t": 0.0}
    c = SemanticCache(threshold=1.0, now_fn=lambda: clock["t"], ttl_s=10.0)
    c.put("hello world", "hi")
    clock["t"] = 5.0
    assert c.get("hello world") is not None  # within TTL
    clock["t"] = 20.0
    assert c.get("hello world") is None  # expired


def test_pluggable_similarity_and_hit_rate():
    c = SemanticCache(threshold=0.5, similarity_fn=lambda a, b: 1.0)  # everything matches
    c.put("anything", "resp")
    assert c.get("totally different") is not None
    c2 = SemanticCache(threshold=2.0)  # impossible threshold -> always miss
    c2.put("x", "y")
    assert c2.get("x") is None
    assert c2.hit_rate == 0.0
