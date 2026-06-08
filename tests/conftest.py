"""Pytest fixtures: a fake Memory and a wired FastAPI test client."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from costit.config import Settings
from costit.main import create_app
from tests.factories import FakeMemory


@pytest.fixture(autouse=True)
def _hermetic_offline(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep offline tests independent of a developer's local ``.env``.

    A populated ``.env`` (e.g. ``COSTIT_REASONER_PROVIDER=gemini`` + a key) would
    otherwise leak into every ``Settings()`` a test doesn't fully override, building a
    real reasoner and calling the provider on escalation. Env vars outrank the ``.env``
    file, and explicit ``Settings(...)`` kwargs still outrank these — so reasoner tests
    that opt in via kwargs (escalation, registry, live) keep working.

    The model is cleared too: a live test may pin a *provider* without pinning a model,
    and must not inherit a foreign model id from ``.env`` (e.g. an Anthropic test ending
    up pointed at a Gemini model) — clearing it falls back to each provider's default.
    """
    monkeypatch.setenv("COSTIT_REASONER_PROVIDER", "none")
    monkeypatch.setenv("COSTIT_REASONER_MODEL", "")


@pytest.fixture
def settings() -> Settings:
    return Settings(mubit_api_key="test-key", costit_reflect_every_n=3)


@pytest.fixture
def fake_memory() -> FakeMemory:
    return FakeMemory()


@pytest.fixture
def app(settings: Settings, fake_memory: FakeMemory):
    return create_app(settings=settings, memory=fake_memory, start_refresh=False)


@pytest.fixture
def client(app) -> TestClient:
    with TestClient(app) as test_client:
        yield test_client
