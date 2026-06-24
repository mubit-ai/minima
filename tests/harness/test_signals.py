"""Phase B: CodeHealthExtractor + the discrimination gate (the go/no-go for code-aware
routing). If these signals can't separate trivial/medium/complex tasks, code-quality-aware
routing isn't ready and we pivot to memory/cost-first."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from minima.schemas.common import DecisionBasis, Difficulty, TaskType
from minima.schemas.recommend import RankedModel, RecommendResponse
from minima_harness.minima import CodeHealthExtractor, MinimaRouter, SignalBundle
from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.signals import extract_or_none

_TRIVIAL = """def add(a, b):
    return a + b


def greet(name):
    return f"hi {name}"
"""

_MEDIUM = (
    """
def process(items, opts):
    result = []
    for it in items:
        if it.active:
            if it.kind == "a" or it.kind == "b":
                result.append(it)
            elif it.kind == "c":
                if opts.strict and it.flag:
                    continue
                result.append(it)
        elif it.pending:
            for sub in it.subs:
                if sub and sub.ok:
                    result.append(sub)
    return result
"""
    * 3
)

_COMPLEX = (
    """
def handle(req):
    if req.type == "x":
        for i, item in enumerate(req.items):
            if item and item.kind in ("a", "b", "c"):
                if item.priority > 5 and not item.skip:
                    try:
                        if item.sub and item.sub.ok:
                            for s in item.sub.children:
                                if s and s.active and not s.deleted:
                                    if s.role == "admin" or s.role == "owner":
                                        if can_access(s, req.user):
                                            process(s)
                                        elif s.role == "guest":
                                            continue
                    except ValueError:
                        if opts.strict:
                            raise
                        elif opts.fallback:
                            handle_fallback(item)
            elif item.kind == "d":
                while item.next and item.depth < 10:
                    if check(item):
                        break
"""
    * 6
)


def _write(tmp_path: Path, name: str, body: str) -> Path:
    p = tmp_path / name
    p.write_text(body)
    return p


# ------------------------------------------------------------- extractor + gate


def test_extractor_signals_trivial_medium_complex(tmp_path):
    ext = CodeHealthExtractor()
    trivial = _write(tmp_path, "trivial.py", _TRIVIAL)
    medium = _write(tmp_path, "medium.py", _MEDIUM)
    complex_ = _write(tmp_path, "complex.py", _COMPLEX)

    bt = asyncio.run(ext.extract("edit trivial", [trivial]))
    bm = asyncio.run(ext.extract("edit medium", [medium]))
    bc = asyncio.run(ext.extract("edit complex", [complex_]))

    # Monotonic complexity ordering (the falsifiable discrimination check).
    assert bt.total_complexity < bm.total_complexity < bc.total_complexity
    assert bt.total_loc < bm.total_loc < bc.total_loc
    # Distinct difficulty bands (tiers actually separate).
    assert {bt.difficulty, bm.difficulty, bc.difficulty} == {
        bt.difficulty,
        bm.difficulty,
        bc.difficulty,
    }
    assert bt.difficulty in ("trivial", "easy")
    assert bc.difficulty in ("hard", "expert")
    assert bt.difficulty != bc.difficulty


def test_extractor_tags_structure(tmp_path):
    ext = CodeHealthExtractor()
    src = _write(tmp_path, "svc.py", _MEDIUM)
    b = asyncio.run(ext.extract("refactor svc", [src]))
    assert b.tags
    assert any(t.startswith("complexity:") for t in b.tags)
    assert any(t.startswith("loc:") for t in b.tags)
    assert ("no_tests" in b.tags) or ("has_tests" in b.tags)
    assert "files:1" in b.tags
    assert b.expected_input_tokens == b.total_loc * 10


def test_sibling_test_detected_on_disk(tmp_path):
    ext = CodeHealthExtractor()
    src = _write(tmp_path, "calc.py", _TRIVIAL)
    _write(tmp_path, "test_calc.py", "def test_it(): assert True")
    b = asyncio.run(ext.extract("edit calc", [src]))  # test file NOT passed in
    assert b.has_tests is True
    assert "has_tests" in b.tags


def test_no_tests_when_absent(tmp_path):
    ext = CodeHealthExtractor()
    src = _write(tmp_path, "solo.py", _MEDIUM)
    b = asyncio.run(ext.extract("edit solo", [src]))
    assert b.has_tests is False
    assert "no_tests" in b.tags


def test_unreadable_file_skipped(tmp_path):
    ext = CodeHealthExtractor()
    missing = tmp_path / "nope.py"
    b = asyncio.run(ext.extract("edit", [missing]))
    assert isinstance(b, SignalBundle)
    assert b.files == 0  # nothing read; bundle still returned (empty)


# --------------------------------------------------------------- extract_or_none


async def _stub_extract(task, files):
    return SignalBundle(tags=["complexity:high"], difficulty="hard", expected_input_tokens=999)


def test_extract_or_none_skips_when_no_extractor_or_files():
    async def run() -> None:
        assert await extract_or_none(None, "t", [Path("x")]) is None
        assert await extract_or_none(_stub_extract, "t", None) is None  # type: ignore[arg-type]
        assert await extract_or_none(_stub_extract, "t", []) is None  # type: ignore[arg-type]

    asyncio.run(run())


def test_extract_or_none_runs_and_normalizes_sync_or_async():
    class _Sync:
        def extract(self, task, files):
            return SignalBundle(tags=["complexity:low"], difficulty="easy")

    class _Async:
        async def extract(self, task, files):
            return SignalBundle(tags=["complexity:high"], difficulty="hard")

    async def run() -> None:
        sync_bundle = await extract_or_none(_Sync(), "t", [Path("x")])  # type: ignore[arg-type]
        assert sync_bundle is not None and sync_bundle.difficulty == "easy"
        async_bundle = await extract_or_none(_Async(), "t", [Path("x")])  # type: ignore[arg-type]
        assert async_bundle is not None and async_bundle.difficulty == "hard"

    asyncio.run(run())


def test_extract_or_none_swallows_broken_extractor():
    class _Boom:
        async def extract(self, task, files):
            raise RuntimeError("boom")

    async def run() -> None:
        assert await extract_or_none(_Boom(), "t", [Path("x")]) is None  # type: ignore[arg-type]

    asyncio.run(run())


# ------------------------------------------------------- router payload plumbing


def _client_recording(payloads: list) -> object:
    ranked = RankedModel(
        model_id="claude-haiku-4-5",
        provider="anthropic",
        predicted_success=0.9,
        est_cost_usd=0.001,
        score=0.9,
    )
    rec = RecommendResponse(
        recommendation_id="rec-1",
        recommended_model=ranked,
        ranked=[ranked],
        confidence=0.5,
        decision_basis=DecisionBasis.prior,
        threshold_used=0.7,
        classified_task_type=TaskType.code,
        classified_difficulty=Difficulty.medium,
        catalog_version="v1",
    )

    class _Client:
        async def recommend(self, task, **kw):
            payloads.append(task)
            return rec

        async def feedback(self, *a, **k):
            return None

    return _Client()


def test_router_passes_bare_string_when_no_signals():
    payloads: list = []
    router = MinimaRouter(
        _client_recording(payloads), HarnessConfig(candidates=["claude-haiku-4-5"])
    )  # type: ignore[arg-type]
    asyncio.run(router.recommend("just text", task_type=None))
    assert payloads == ["just text"]


def test_router_passes_enriched_dict_with_signals(tmp_path):
    payloads: list = []
    router = MinimaRouter(
        _client_recording(payloads), HarnessConfig(candidates=["claude-haiku-4-5"])
    )  # type: ignore[arg-type]
    src = _write(tmp_path, "svc.py", _COMPLEX)
    bundle = asyncio.run(CodeHealthExtractor().extract("refactor", [src]))
    asyncio.run(
        router.recommend(
            "refactor",
            task_type="code",
            tags=bundle.tags,
            difficulty=bundle.difficulty,
            expected_input_tokens=bundle.expected_input_tokens,
        )
    )
    assert len(payloads) == 1
    sent = payloads[0]
    assert isinstance(sent, dict)
    assert sent["task"] == "refactor"
    assert sent["task_type"] == "code"
    assert sent["difficulty"] == "hard" or sent["difficulty"] == "expert"
    assert "complexity:high" in sent["tags"]
    assert sent["expected_input_tokens"] > 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
