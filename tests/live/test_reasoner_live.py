"""Live reasoner checks against real providers.

    ANTHROPIC_API_KEY=... uv run pytest -m live -k reasoner -q   # Anthropic
    GEMINI_API_KEY=...    uv run pytest -m live -k reasoner -q   # Gemini
"""

from __future__ import annotations

import os

import pytest

from minima.config import Settings
from minima.llm.base import CandidateView
from minima.llm.registry import build_reasoner

pytestmark = [pytest.mark.live]


def _candidates() -> list[CandidateView]:
    return [
        CandidateView(
            model_id="gpt-4o-mini",
            provider="openai",
            input_cost_per_mtok=0.15,
            output_cost_per_mtok=0.6,
            context_window=128_000,
            capability_prior=0.68,
            est_cost_usd=0.0005,
            predicted_success=0.68,
        ),
        CandidateView(
            model_id="claude-opus-4-8",
            provider="anthropic",
            input_cost_per_mtok=15.0,
            output_cost_per_mtok=75.0,
            context_window=200_000,
            capability_prior=0.95,
            est_cost_usd=0.05,
            predicted_success=0.95,
        ),
    ]


@pytest.mark.skipif(not os.getenv("GEMINI_API_KEY"), reason="needs GEMINI_API_KEY")
async def test_gemini_reasoner_ranks_live():
    settings = Settings(
        mubit_api_key="t",
        minima_reasoner_provider="gemini",
        gemini_api_key=os.environ["GEMINI_API_KEY"],
    )
    reasoner = build_reasoner(settings)
    assert reasoner is not None

    result = await reasoner.rank(
        task="Classify the sentiment of a product review as positive or negative.",
        task_type="classification",
        difficulty="easy",
        candidates=_candidates(),
        memory_block="",
        cost_quality_tradeoff=2.0,
    )
    if result is None:
        import google.genai as genai

        try:
            genai.Client(api_key=os.environ["GEMINI_API_KEY"]).models.generate_content(
                model=settings.minima_reasoner_model or "gemini-2.5-flash", contents="ok"
            )
        except Exception as exc:  # noqa: BLE001
            pytest.skip(f"gemini unreachable from this environment: {exc}")
        pytest.fail("gemini reasoner returned None despite a reachable provider")

    ids = {r.model_id for r in result.rankings}
    assert ids and ids <= {"gpt-4o-mini", "claude-opus-4-8"}
    assert all(0.0 <= r.predicted_success <= 1.0 for r in result.rankings)


@pytest.mark.skipif(not os.getenv("ANTHROPIC_API_KEY"), reason="needs ANTHROPIC_API_KEY")
async def test_anthropic_reasoner_ranks_live():
    settings = Settings(mubit_api_key="t", minima_reasoner_provider="anthropic")
    reasoner = build_reasoner(settings)
    assert reasoner is not None

    candidates = [
        CandidateView(
            model_id="claude-haiku-4-5",
            provider="anthropic",
            input_cost_per_mtok=1.0,
            output_cost_per_mtok=5.0,
            context_window=200_000,
            capability_prior=0.6,
            est_cost_usd=0.002,
            predicted_success=0.6,
        ),
        CandidateView(
            model_id="claude-opus-4-8",
            provider="anthropic",
            input_cost_per_mtok=15.0,
            output_cost_per_mtok=75.0,
            context_window=200_000,
            capability_prior=0.95,
            est_cost_usd=0.05,
            predicted_success=0.95,
        ),
    ]
    result = await reasoner.rank(
        task="Classify the sentiment of a product review as positive or negative.",
        task_type="classification",
        difficulty="easy",
        candidates=candidates,
        memory_block="",
        cost_quality_tradeoff=2.0,
    )
    if result is None:
        # The reasoner swallows all errors and returns None. Distinguish a genuine
        # code failure from an environment that can't reach/authenticate the provider:
        # any provider-side error (connection, timeout, 401/403/429) on a basic probe
        # means we can't positively verify here -> skip. Only a clean probe success
        # paired with a None result indicates a real bug.
        import anthropic

        try:
            anthropic.Anthropic(timeout=15.0).messages.create(
                model="claude-haiku-4-5",
                max_tokens=8,
                messages=[{"role": "user", "content": "ok"}],
            )
        except anthropic.APIError as exc:
            pytest.skip(f"provider unreachable/unusable from this environment: {exc}")
        pytest.fail("reasoner returned None despite a reachable provider")

    ids = {r.model_id for r in result.rankings}
    assert ids and ids <= {"claude-haiku-4-5", "claude-opus-4-8"}
    assert all(0.0 <= r.predicted_success <= 1.0 for r in result.rankings)
