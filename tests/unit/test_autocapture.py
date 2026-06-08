from __future__ import annotations

import sys
import types

import pytest
from costit_client import autocapture


class _FakeLearn(types.ModuleType):
    def __init__(self) -> None:
        super().__init__("mubit.learn")
        self.calls: dict[str, object] = {}

    def init(self, **kwargs):
        self.calls["init"] = kwargs
        return "run-manager"

    def feedback(self, score=None, *, good=None, **kwargs):
        self.calls["feedback"] = {"score": score, "good": good, **kwargs}

    def wrap(self, client, **kwargs):
        self.calls["wrap"] = client
        return ("wrapped", client)

    def capture(self, messages, response, **kwargs):
        self.calls["capture"] = {"messages": messages, "response": response}

    def uninstrument(self):
        self.calls["uninstrument"] = True


@pytest.fixture
def fake_learn(monkeypatch):
    fake = _FakeLearn()
    monkeypatch.setitem(sys.modules, "mubit.learn", fake)
    return fake


def test_lane_for():
    assert autocapture.lane_for("acme") == "costit:acme"
    assert autocapture.lane_for(None) == "costit:default"
    assert autocapture.lane_for("acme", "tenant") == "tenant:acme"


def test_enable_pins_costit_lane(fake_learn):
    rm = autocapture.enable(api_key="k", namespace="acme", patch_globals=False)
    assert rm == "run-manager"
    init = fake_learn.calls["init"]
    assert init["lane"] == "costit:acme"
    assert init["agent_id"] == "costit-autocapture"
    assert init["patch_globals"] is False  # passthrough kwarg


def test_feedback_wrap_capture_disable_delegate(fake_learn):
    autocapture.feedback(good=True, verified_in_production=True)
    assert fake_learn.calls["feedback"] == {
        "score": None,
        "good": True,
        "verified_in_production": True,
    }

    assert autocapture.wrap("client-x") == ("wrapped", "client-x")
    autocapture.capture([{"role": "user", "content": "q"}], "a", model="m")
    assert fake_learn.calls["capture"]["response"] == "a"

    autocapture.disable()
    assert fake_learn.calls["uninstrument"] is True


def test_graceful_when_learn_unavailable(monkeypatch):
    # Simulate mubit.learn being absent: a None entry makes `import mubit.learn` fail.
    monkeypatch.setitem(sys.modules, "mubit.learn", None)
    with pytest.raises(RuntimeError, match="mubit-sdk"):
        autocapture.enable(namespace="acme")
