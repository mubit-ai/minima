from __future__ import annotations


def test_workflow_recommends_per_step(client):
    resp = client.post(
        "/v1/recommend/workflow",
        json={
            "steps": [
                {
                    "step_id": "s1",
                    "task": {"task": "classify the sentiment", "task_type": "classification"},
                },
                {
                    "step_id": "s2",
                    "task": {
                        "task": "refactor def foo()",
                        "task_type": "code",
                        "difficulty": "hard",
                    },
                },
            ]
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert [s["step_id"] for s in body["steps"]] == ["s1", "s2"]
    assert body["total_est_cost_usd"] >= 0
    assert body["total_est_cost_if_all_premium"] >= body["total_est_cost_usd"]
    assert all(s["recommendation"]["recommendation_id"] for s in body["steps"])


def test_models_endpoint(client):
    resp = client.get("/v1/models")
    assert resp.status_code == 200
    body = resp.json()
    assert body["models"]
    assert body["catalog_version"]


def test_models_provider_filter(client):
    resp = client.get("/v1/models", params={"provider": "anthropic"})
    assert resp.status_code == 200
    providers = {m["provider"] for m in resp.json()["models"]}
    assert providers == {"anthropic"}


def test_health_endpoint(client):
    resp = client.get("/v1/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["mubit"]["reachable"] is True
    assert body["catalog"]["models"] >= 1
    assert body["classifier"] == {"id": "regex-v1", "embed_loaded": False, "required": False}
