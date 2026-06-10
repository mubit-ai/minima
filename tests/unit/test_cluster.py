from __future__ import annotations

from minima.memory.keys import (
    build_lesson_content,
    lesson_upsert_key,
    salient_signature,
    task_cluster,
)


def test_salient_signature_stable_and_order_independent():
    a = salient_signature("Refactor the recursive parser into an iterative loop")
    b = salient_signature("iterative loop: refactor recursive parser")  # same salient words
    assert a == b
    assert len(a) == 8


def test_salient_signature_differs_by_topic():
    parser = salient_signature("Refactor the recursive parser into an iterative loop")
    sentiment = salient_signature("Classify the sentiment of this product review")
    assert parser != sentiment


def test_salient_signature_empty_or_stopwords_only():
    assert salient_signature("") == "general"
    assert salient_signature("the and to of in is") == "general"


def test_task_cluster_coarse_vs_fine():
    assert task_cluster("code", "hard") == "code:hard"
    sig = salient_signature("Refactor the recursive parser")
    assert task_cluster("code", "hard", sig) == f"code:hard:{sig}"


def test_lesson_helpers():
    assert lesson_upsert_key("code:hard", "claude-haiku-4-5") == (
        "minima:lesson:code:hard:claude-haiku-4-5"
    )
    content = build_lesson_content("code:hard", "claude-haiku-4-5", 0.92)
    assert "code:hard" in content and "claude-haiku-4-5" in content and "92%" in content
