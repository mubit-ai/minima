"""Tests for GET /v1/capabilities."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from minima.main import create_app
from minima.version import __version__
from tests.factories import FakeMemory


@pytest.fixture
def cap_client() -> TestClient:
    from minima.config import Settings

    app = create_app(
        settings=Settings(mubit_api_key="test-key"),
        memory=FakeMemory(),
        start_refresh=False,
    )
    return TestClient(app)


def test_capabilities_shape(cap_client: TestClient) -> None:
    resp = cap_client.get("/v1/capabilities")
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body["plan"], bool)
    assert isinstance(body["workflow"], bool)
    assert isinstance(body["api_version"], str)
    assert isinstance(body["honored_constraints"], list)


def test_capabilities_current_values(cap_client: TestClient) -> None:
    body = cap_client.get("/v1/capabilities").json()
    # plan ships False until PR C; workflow already exists.
    assert body["plan"] is False
    assert body["workflow"] is True
    assert body["api_version"] == __version__


def test_capabilities_honored_constraints_nonempty(cap_client: TestClient) -> None:
    body = cap_client.get("/v1/capabilities").json()
    hc = body["honored_constraints"]
    assert len(hc) > 0
    # These two are the most load-bearing constraints in the engine.
    assert "candidate_models" in hc
    assert "excluded_models" in hc


def test_capabilities_no_auth_required(cap_client: TestClient) -> None:
    """Capabilities must be readable without an API key."""
    resp = cap_client.get("/v1/capabilities")
    assert resp.status_code == 200
