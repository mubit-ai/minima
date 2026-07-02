from __future__ import annotations

from minima.memory import keys
from minima.recommender.classify import classify, infer_difficulty, infer_task_type
from minima.schemas.common import Difficulty, TaskInput, TaskType


def test_infer_task_type():
    assert infer_task_type("Please summarize this article") == TaskType.summarization
    assert infer_task_type("Translate this to French") == TaskType.translation
    assert infer_task_type("def foo(): refactor this function") == TaskType.code
    assert infer_task_type("Classify the sentiment of this review") == TaskType.classification
    assert infer_task_type("What is the capital of France?") == TaskType.qa


def test_code_detection():
    assert infer_task_type("def foo(): pass") == TaskType.code


def test_infer_difficulty_code_harder_than_classification():
    text = " ".join(["task"] * 80)  # ~medium length, no complexity markers
    assert infer_difficulty(text, TaskType.code) == Difficulty.hard
    assert infer_difficulty(text, TaskType.classification) == Difficulty.easy


def test_caller_hints_win():
    task = TaskInput(task="x", task_type=TaskType.reasoning, difficulty=Difficulty.expert)
    assert classify(task) == (TaskType.reasoning, Difficulty.expert)


def test_fingerprint_stable_under_whitespace_and_case():
    a = keys.task_fingerprint("Hello   World")
    b = keys.task_fingerprint("hello world")
    assert a == b


def test_cluster_and_upsert_key():
    assert keys.task_cluster("code", "hard") == "code:hard"
    assert (
        keys.outcome_upsert_key("code:hard", "claude-haiku-4-5")
        == "minima:om:code:hard:claude-haiku-4-5"
    )


def test_build_content_prefixes_type_and_difficulty():
    content = keys.build_content("code", "hard", "do the thing")
    assert content.startswith("[code/hard]")


def test_idempotency_key_deterministic():
    a = keys.outcome_idempotency_key("rec1", "m")
    b = keys.outcome_idempotency_key("rec1", "m")
    assert a == b and a.startswith("oc:")


# --- regressions from the 2026-07-02 live E2E (first-match-wins misrouting) -----------


def test_coding_task_with_trailing_summarize_is_code_not_summarization():
    # Observed live: this exact shape classified summarization/trivial and was priced
    # like a one-liner. Four coding cues must outvote one incidental "summarize".
    text = (
        "There is a failing test in this project. Run the tests with: python3 -m pytest -q, "
        "find the bug, fix it, and re-run the tests to confirm they all pass. "
        "Then summarize the fix in one sentence."
    )
    assert infer_task_type(text) == TaskType.code
    # StrEnum compares alphabetically — assert exact membership, not >=.
    assert infer_difficulty(text, TaskType.code) in {Difficulty.medium, Difficulty.hard}


def test_systems_design_prompt_is_reasoning_and_hard():
    # Observed live: classified other/easy despite lock-free/concurrency/memory-ordering.
    text = (
        "Design a lock-free concurrent LRU cache eviction strategy for a multi-tenant "
        "inference gateway where tenants have different SLAs. Explain the memory-ordering "
        "constraints and the ABA-problem mitigation in under 150 words."
    )
    assert infer_task_type(text) == TaskType.reasoning
    assert infer_difficulty(text, TaskType.reasoning) in {Difficulty.hard, Difficulty.expert}


def test_pure_summarization_still_wins():
    assert infer_task_type("Summarize this article in three sentences.") == TaskType.summarization
    assert infer_task_type("TL;DR of the meeting notes please") == TaskType.summarization


def test_file_extension_and_bug_vocabulary_signal_code():
    assert infer_task_type("Fix the bug in stats.py so the tests pass") == TaskType.code
    assert infer_task_type("Why does src/main.rs not compile?") == TaskType.code


def test_summarize_a_code_file_prefers_code_capability():
    # Ambiguous on purpose: routing to a code-capable model is the safe choice.
    assert infer_task_type("Summarize what utils.py does, refactor notes welcome") == TaskType.code


def test_qa_still_wins_for_plain_questions():
    assert infer_task_type("What is the capital of France?") == TaskType.qa
