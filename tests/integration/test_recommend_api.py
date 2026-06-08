from __future__ import annotations


def test_recommend_cold_start(client):
    resp = client.post(
        "/v1/recommend",
        json={
            "task": {
                "task": "Write a python function to add two numbers",
                "task_type": "code",
                "difficulty": "easy",
            }
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["decision_basis"] == "prior"
    assert "cold_start" in body["warnings"]
    assert body["recommended_model"]["model_id"]
    assert body["recommendation_id"]
    assert body["ranked"]


def test_recommend_no_candidates_returns_422(client):
    resp = client.post(
        "/v1/recommend",
        json={"task": {"task": "hi"}, "constraints": {"candidate_models": ["does-not-exist"]}},
    )
    assert resp.status_code == 422


def test_recommend_cheapest_eligible_with_memory(client, fake_memory):
    from tests.factories import make_evidence

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
    assert resp.status_code == 200
    body = resp.json()
    # Haiku clears the bar via memory and is far cheaper than Opus.
    assert body["recommended_model"]["model_id"] == "claude-haiku-4-5"
    assert body["recommended_model"]["decision_basis"] == "memory"
