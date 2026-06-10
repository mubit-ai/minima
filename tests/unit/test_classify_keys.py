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
