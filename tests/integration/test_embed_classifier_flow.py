"""Classifier program PR-5, end to end: the flag serves the embed head's label, decision
rows stamp the artifact's classifier_id, and minima_classifier_required refuses to start
a deploy that would silently run regex."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from minima.config import Settings
from minima.main import create_app
from minima.recommender.classify_embed import ClassifierUnavailable
from tests.conftest import TEST_MUBIT_KEY
from tests.factories import make_classifier_artifact


@pytest.fixture(scope="module")
def artifact(tmp_path_factory):
    return make_classifier_artifact(tmp_path_factory.mktemp("clf-flow"))


def _client(fake_memory, settings) -> TestClient:
    app = create_app(settings=settings, memory=fake_memory, start_refresh=False)
    return TestClient(app, headers={"Authorization": f"Bearer {TEST_MUBIT_KEY}"})


def test_embed_head_serves_and_stamps(fake_memory, artifact):
    settings = Settings(
        mubit_api_key="test-key",
        minima_embed_classifier=True,
        minima_classifier_artifact=str(artifact),
    )
    with _client(fake_memory, settings) as client:
        rec = client.post("/v1/recommend", json={"task": {"task": "write a poem story"}}).json()
        assert rec["classified_task_type"] == "creative"
        assert rec["classification_profile"]["task_type_source"] == "embedding"
        tenant = client.app.state.passthrough_runtime.resolve(TEST_MUBIT_KEY)
        row = tenant.decision_log.get(rec["recommendation_id"])
        assert row.classifier_id == "fixture-classifier-0001"
        assert row.abstained is False


def test_abstain_serves_regex_with_provenance(fake_memory, artifact):
    settings = Settings(
        mubit_api_key="test-key",
        minima_embed_classifier=True,
        minima_classifier_artifact=str(artifact),
    )
    with _client(fake_memory, settings) as client:
        rec = client.post(
            "/v1/recommend", json={"task": {"task": "Fix the flaky test in the stats module"}}
        ).json()
        assert rec["classified_task_type"] == "code"  # regex assigned after abstain
        assert rec["classification_profile"]["task_type_source"] == "embedding_abstain"
        tenant = client.app.state.passthrough_runtime.resolve(TEST_MUBIT_KEY)
        row = tenant.decision_log.get(rec["recommendation_id"])
        assert row.abstained is True


def test_flag_off_never_touches_the_artifact(fake_memory, artifact):
    settings = Settings(mubit_api_key="test-key", minima_classifier_artifact=str(artifact))
    with _client(fake_memory, settings) as client:
        rec = client.post("/v1/recommend", json={"task": {"task": "write a poem story"}}).json()
        assert rec["classification_profile"]["task_type_source"] == "heuristic"
        tenant = client.app.state.passthrough_runtime.resolve(TEST_MUBIT_KEY)
        row = tenant.decision_log.get(rec["recommendation_id"])
        assert row.classifier_id == "regex-v1"


def test_required_fails_loud_on_missing_artifact(fake_memory, tmp_path):
    settings = Settings(
        mubit_api_key="test-key",
        minima_embed_classifier=True,
        minima_classifier_required=True,
        minima_classifier_artifact=str(tmp_path / "missing"),
    )
    app = create_app(settings=settings, memory=fake_memory, start_refresh=False)
    with pytest.raises(ClassifierUnavailable):
        # The runtime is built at lifespan startup — exactly where a prod deploy dies.
        with TestClient(app, headers={"Authorization": f"Bearer {TEST_MUBIT_KEY}"}):
            pass


def test_health_reports_loaded_classifier(fake_memory, artifact):
    settings = Settings(
        mubit_api_key="test-key",
        minima_embed_classifier=True,
        minima_classifier_required=True,
        minima_classifier_artifact=str(artifact),
    )
    with _client(fake_memory, settings) as client:
        body = client.get("/v1/health").json()
        assert body["classifier"] == {
            "id": "fixture-classifier-0001",
            "embed_loaded": True,
            "required": True,
        }


def test_unrequired_missing_artifact_degrades_to_regex(fake_memory, tmp_path):
    settings = Settings(
        mubit_api_key="test-key",
        minima_embed_classifier=True,
        minima_classifier_artifact=str(tmp_path / "missing"),
    )
    with _client(fake_memory, settings) as client:
        rec = client.post("/v1/recommend", json={"task": {"task": "write a poem story"}}).json()
        assert rec["classification_profile"]["task_type_source"] == "heuristic"
