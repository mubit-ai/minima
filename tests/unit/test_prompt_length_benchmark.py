from __future__ import annotations

from tests.eval.prompt_length_benchmark import _prompt_for_words, run_benchmark


def test_prompt_builder_hits_requested_length():
    prompt = _prompt_for_words(64)
    assert len(prompt.split()) == 64
    assert prompt.startswith("Summarize this incident report into 3 bullets.")


def test_run_benchmark_shapes_rows_and_calls_curl_runner():
    calls: list[tuple[str, int, bool]] = []

    def fake_curl_runner(
        endpoint: str,
        prompt: str,
        *,
        allow_llm_escalation: bool = False,
    ) -> float:
        calls.append((endpoint, len(prompt.split()), allow_llm_escalation))
        return float(len(prompt.split())) / 10.0

    result = run_benchmark(
        endpoint="http://localhost:8088/v1/recommend",
        lengths=(32, 64),
        samples=3,
        warmup=1,
        allow_llm_escalation=False,
        curl_runner=fake_curl_runner,
    )

    assert result["endpoint"] == "http://localhost:8088/v1/recommend"
    assert result["samples"] == 3
    assert result["warmup"] == 1
    assert result["allow_llm_escalation"] is False
    assert len(result["rows"]) == 2
    assert result["rows"][0]["prompt_words"] == 32
    assert result["rows"][1]["prompt_words"] == 64
    assert result["rows"][0]["repo_mean_ms"] > result["rows"][0]["approach1_mean_ms"]
    assert len(calls) == 1 + (2 * 3)
    assert all(call[0] == "http://localhost:8088/v1/recommend" for call in calls)
    assert all(call[2] is False for call in calls)
