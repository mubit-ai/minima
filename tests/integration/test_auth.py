"""Front-door auth format gate (FIX #86).

The recommend path serves from local priors without a Mubit round-trip, so before
this gate a garbage bearer like ``Bearer not-a-key`` returned a full 200. These tests
pin that any bearer token that is not in the canonical ``mbt_...`` Mubit key format is
rejected with a 401 *before* anything is served, while well-formed keys still reach the
handler and the operator-configured single-tenant fallback keeps working.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from minima.api.auth import is_mubit_key_format

_TASK = {"task": {"task": "Write a python function to add two numbers", "task_type": "code"}}


@pytest.mark.parametrize(
    "token",
    ["not-a-key", "test-key", "t", "abcdef123456", "Bearer", "mbt", "mbt_", "sk-live-xyz"],
)
def test_garbage_bearer_rejected_before_serving(app, token: str) -> None:
    with TestClient(app) as client:
        resp = client.post(
            "/v1/recommend",
            json=_TASK,
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 401
    body = resp.json()
    assert body["status"] == 401
    assert body["title"] == "Unauthorized"
    assert resp.headers["content-type"].startswith("application/problem+json")


@pytest.mark.parametrize("token", ["mbt_test_kid_secret", "mbt_local_admin", "mbt_acme_k_s"])
def test_wellformed_mubit_bearer_reaches_handler(app, token: str) -> None:
    with TestClient(app) as client:
        resp = client.post(
            "/v1/recommend",
            json=_TASK,
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 200
    assert resp.json()["recommendation_id"]


def test_is_mubit_key_format() -> None:
    assert is_mubit_key_format("mbt_test_kid_secret")
    assert is_mubit_key_format("mbt_local_admin")
    assert is_mubit_key_format("mbt_x")
    assert not is_mubit_key_format("mbt_")
    assert not is_mubit_key_format("mbt")
    assert not is_mubit_key_format("not-a-key")
    assert not is_mubit_key_format("test-key")
    assert not is_mubit_key_format("")
