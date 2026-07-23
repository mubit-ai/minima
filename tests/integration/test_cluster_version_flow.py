"""Classifier program PR-2: the key-space version threads recommend → decision log,
and the v1 default remains byte-identical to the historical key space."""

from __future__ import annotations

from fastapi.testclient import TestClient

from minima.config import Settings
from minima.main import create_app
from tests.conftest import TEST_MUBIT_KEY


def _recommend(client):
    resp = client.post(
        "/v1/recommend",
        json={"task": {"task": "fix the bug in stats.py so the tests pass"}},
    )
    assert resp.status_code == 200
    return resp.json()


def _decision_row(client, rec_id):
    tenant = client.app.state.passthrough_runtime.resolve(TEST_MUBIT_KEY)
    return tenant.decision_log.get(rec_id)


def test_default_v1_mints_the_historical_unversioned_key(fake_memory):
    settings = Settings(mubit_api_key="test-key")
    app = create_app(settings=settings, memory=fake_memory, start_refresh=False)
    with TestClient(app, headers={"Authorization": f"Bearer {TEST_MUBIT_KEY}"}) as client:
        rec = _recommend(client)
        assert rec["cluster_key_version"] == "v1"
        row = _decision_row(client, rec["recommendation_id"])
        assert row.cluster.count(":") == 1  # code:medium — no version suffix, ever, at v1
        assert row.cluster_key_version == "v1"


def test_v2_setting_suffixes_every_minted_key(fake_memory):
    settings = Settings(mubit_api_key="test-key", minima_cluster_key_version="v2")
    app = create_app(settings=settings, memory=fake_memory, start_refresh=False)
    with TestClient(app, headers={"Authorization": f"Bearer {TEST_MUBIT_KEY}"}) as client:
        rec = _recommend(client)
        assert rec["cluster_key_version"] == "v2"
        row = _decision_row(client, rec["recommendation_id"])
        assert row.cluster.endswith(":v2")
        assert row.cluster_key_version == "v2"
