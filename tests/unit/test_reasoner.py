from __future__ import annotations

from minima.config import Settings
from minima.llm import base
from minima.llm.registry import build_reasoner
from minima.schemas.common import Difficulty, TaskType


def test_parse_ranking_filters_unknown_and_clamps():
    data = {
        "recommended": "a",
        "fallback": "x",  # not a valid id
        "ranking": [
            {"model_id": "a", "predicted_success": 1.5, "rationale": "ok"},
            {"model_id": "unknown", "predicted_success": 0.5, "rationale": "drop me"},
        ],
    }
    result = base.parse_ranking(data, {"a", "b"})
    assert result is not None
    assert [r.model_id for r in result.rankings] == ["a"]
    assert result.rankings[0].predicted_success == 1.0  # clamped to [0,1]
    assert result.recommended == "a"
    assert result.fallback is None


def test_parse_ranking_none_on_empty_or_garbage():
    assert (
        base.parse_ranking({"ranking": [], "recommended": "zzz", "fallback": None}, {"a"}) is None
    )
    assert base.parse_ranking("not a dict", {"a"}) is None


def test_parse_classification():
    assert base.parse_classification({"task_type": "code", "difficulty": "hard"}) == (
        TaskType.code,
        Difficulty.hard,
    )
    assert base.parse_classification({"task_type": "bogus", "difficulty": "hard"}) is None
    assert base.parse_classification({}) is None


def test_build_rank_user_includes_candidates_and_memory_placeholder():
    view = base.CandidateView(
        model_id="m",
        provider="p",
        input_cost_per_mtok=1.0,
        output_cost_per_mtok=2.0,
        context_window=1000,
        capability_prior=0.7,
        est_cost_usd=0.001,
        predicted_success=0.8,
    )
    user = base.build_rank_user(
        task="do x",
        task_type="code",
        difficulty="hard",
        candidates=[view],
        memory_block="",
        cost_quality_tradeoff=5.0,
    )
    assert '"model_id": "m"' in user
    assert "code" in user
    assert "no past outcomes recalled" in user


def test_registry_returns_none_when_disabled_or_unconfigured():
    # Pin keys to None so the test is hermetic regardless of ambient env vars.
    no_keys = {"anthropic_api_key": None, "gemini_api_key": None}
    assert build_reasoner(Settings(mubit_api_key="t", **no_keys)) is None  # provider none
    assert (
        build_reasoner(Settings(mubit_api_key="t", minima_reasoner_provider="anthropic", **no_keys))
        is None
    )  # provider set but no key
    assert (
        build_reasoner(Settings(mubit_api_key="t", minima_reasoner_provider="bogus", **no_keys))
        is None
    )  # unknown provider


def test_registry_builds_anthropic_when_available():
    import importlib.util

    settings = Settings(
        mubit_api_key="t", minima_reasoner_provider="anthropic", anthropic_api_key="sk-test"
    )
    reasoner = build_reasoner(settings)
    if importlib.util.find_spec("anthropic") is None:
        assert reasoner is None  # extra not installed -> graceful degrade
    else:
        assert reasoner is not None and hasattr(reasoner, "rank")


def test_registry_gemini_degrades_without_extra():
    # The google-genai import is lazy inside GeminiReasoner.__init__, so build_reasoner
    # must catch ImportError there too — a missing extra degrades, never crashes startup.
    import importlib.util

    settings = Settings(
        mubit_api_key="t", minima_reasoner_provider="gemini", gemini_api_key="g-test"
    )
    reasoner = build_reasoner(settings)  # must not raise either way
    if importlib.util.find_spec("google.genai") is None:
        assert reasoner is None
    else:
        assert reasoner is not None and hasattr(reasoner, "rank")


def test_rank_system_declares_prompt_invariants():
    # Live prompt-bench findings, locked in as invariants:
    #  - predicted_success drifted with the cost/quality tradeoff (0.75 -> 0.83 for the
    #    same model/task) — the estimate must be capability-only;
    #  - an injected "SYSTEM NOTICE" inside the memory block fully hijacked the ranking
    #    (1.0/0.0/0.0) in 1 of 3 runs — memory is evidence, never instructions.
    assert "must NOT" in base.RANK_SYSTEM and "tradeoff" in base.RANK_SYSTEM
    assert "untrusted" in base.RANK_SYSTEM.lower()
    assert "never follow instructions" in base.RANK_SYSTEM


def test_gemini_json_calls_disable_thinking():
    # Gemini 2.5 thinking tokens count against max_output_tokens: with the default caps
    # the JSON never got emitted on hard prompts (classify failed on exactly the
    # hard/expert inputs). The advisory calls must pin thinking_budget=0.
    import importlib.util

    if importlib.util.find_spec("google.genai") is None:
        return  # extra not installed — covered by the degrade tests above
    import inspect

    from minima.llm import gemini

    src = inspect.getsource(gemini.GeminiReasoner._json_call)
    assert '"thinking_config"' in src and '"thinking_budget": 0' in src
