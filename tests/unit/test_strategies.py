from __future__ import annotations

from minima.schemas.strategies import Strategy


def test_from_emergent_snake_case():
    s = Strategy.from_emergent(
        {
            "strategy_id": "s1",
            "description": "Use haiku for code:easy.",
            "supporting_lesson_count": 4,
            "avg_confidence": 0.82,
            "avg_reinforcement": 3.5,
            "dominant_lesson_type": "success",
            "dominant_scope": "session",
            "lesson_ids": ["l1", "l2"],
        }
    )
    assert s.strategy_id == "s1"
    assert s.supporting_lesson_count == 4
    assert s.avg_confidence == 0.82
    assert s.lesson_ids == ["l1", "l2"]


def test_from_emergent_camel_case():
    s = Strategy.from_emergent(
        {
            "strategyId": "s2",
            "description": "Escalate code:expert to opus.",
            "supportingLessonCount": 9,
            "avgConfidence": 0.91,
            "dominantLessonType": "success",
            "lessonIds": ["a"],
        }
    )
    assert s.strategy_id == "s2"
    assert s.supporting_lesson_count == 9
    assert s.avg_confidence == 0.91
    assert s.dominant_lesson_type == "success"
    assert s.lesson_ids == ["a"]


def test_from_emergent_defaults_on_missing():
    s = Strategy.from_emergent({"description": "bare"})
    assert s.description == "bare"
    assert s.supporting_lesson_count == 0
    assert s.avg_confidence == 0.0
    assert s.lesson_ids == []
