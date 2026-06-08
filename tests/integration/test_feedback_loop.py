from __future__ import annotations

from tests.factories import make_evidence


def _recommend_haiku(client, fake_memory):
    fake_memory.evidence = [
        make_evidence("claude-haiku-4-5", 0.9, entry_id="e1", reference_id="r1"),
        make_evidence("claude-haiku-4-5", 0.9, entry_id="e2", reference_id="r2"),
        make_evidence("claude-haiku-4-5", 0.85, entry_id="e3"),
    ]
    resp = client.post(
        "/v1/recommend",
        json={
            "task": {
                "task": "refactor this recursive def foo()",
                "task_type": "code",
                "difficulty": "hard",
            },
            "constraints": {"candidate_models": ["claude-haiku-4-5", "claude-opus-4-8"]},
        },
    )
    return resp.json()


def test_feedback_writes_outcome_and_credits_neighbors(client, fake_memory):
    rec = _recommend_haiku(client, fake_memory)
    assert rec["recommended_model"]["model_id"] == "claude-haiku-4-5"

    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "quality_score": 0.95,
            "input_tokens": 1800,
            "output_tokens": 600,
        },
    ).json()

    assert fb["accepted"] is True
    assert set(fb["reinforced_entry_ids"]) == {"e1", "e2", "e3"}

    assert len(fake_memory.remembered) == 1
    written = fake_memory.remembered[0]
    assert written["upsert_key"] == "costit:om:code:hard:claude-haiku-4-5"
    assert written["record"].quality_score == 0.95
    assert written["source"] == "human"

    assert len(fake_memory.outcomes) == 1
    outcome = fake_memory.outcomes[0]
    assert set(outcome["entry_ids"]) == {"e1", "e2", "e3"}
    assert outcome["reference_id"] == "r1"
    assert outcome["signal"] == 1.0


def test_unknown_recommendation_is_rejected(client):
    fb = client.post(
        "/v1/feedback",
        json={"recommendation_id": "nope", "chosen_model_id": "x", "outcome": "success"},
    ).json()
    assert fb["accepted"] is False
    assert "unknown_recommendation" in fb["warnings"]


def test_reflection_triggers_on_cadence(client, fake_memory):
    rec = _recommend_haiku(client, fake_memory)
    rec_id = rec["recommendation_id"]
    triggers = []
    for _ in range(3):  # COSTIT_REFLECT_EVERY_N = 3 in the test settings
        fb = client.post(
            "/v1/feedback",
            json={
                "recommendation_id": rec_id,
                "chosen_model_id": "claude-haiku-4-5",
                "outcome": "success",
            },
        ).json()
        triggers.append(fb["reflection_triggered"])
    assert triggers == [False, False, True]
