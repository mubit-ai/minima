from __future__ import annotations

import json

from minima_harness.agent.events import (
    AgentEndEvent,
    AgentStartEvent,
    MessageUpdateEvent,
    ToolExecutionStartEvent,
)
from minima_harness.ai.events import TextDeltaEvent

# run_modes ---------------------------------------------------------------------
from minima_harness.tui import extra_models, packages
from minima_harness.tui.run_modes import event_to_dict


def test_event_to_dict_text_delta():
    e = MessageUpdateEvent(assistant_message_event=TextDeltaEvent(delta="hi"))
    assert event_to_dict(e) == {"type": "text_delta", "delta": "hi"}


def test_event_to_dict_tool_start_and_bookends():
    assert event_to_dict(ToolExecutionStartEvent(tool_name="bash")) == {
        "type": "tool_start",
        "name": "bash",
    }
    assert event_to_dict(AgentStartEvent())["type"] == "start"
    assert event_to_dict(AgentEndEvent())["type"] == "done"


# extra_models ------------------------------------------------------------------


def test_load_extra_models(tmp_path, monkeypatch):
    monkeypatch.setattr(extra_models, "GLOBAL_DIR", tmp_path / "global")
    mj = tmp_path / "global" / "models.json"
    mj.parent.mkdir(parents=True)
    mj.write_text(
        json.dumps(
            {
                "models": [
                    {
                        "id": "llama",
                        "provider": "ollama",
                        "base_url": "http://localhost:11434/v1",
                        "context_window": 128000,
                        "max_tokens": 4096,
                        "input_cost": 0,
                        "output_cost": 0,
                    }
                ]
            }
        )
    )
    models = extra_models.load_extra_models(tmp_path)
    assert len(models) == 1
    assert models[0].id == "llama"
    assert models[0].api == "openai-completions"
    assert models[0].base_url == "http://localhost:11434/v1"


# packages ----------------------------------------------------------------------


def test_slug():
    assert packages._slug("git:github.com/u/repo") == "repo"
    assert packages._slug("https://x/y/repo.git") == "repo"


def test_list_and_remove(tmp_path, monkeypatch):
    monkeypatch.setattr(packages, "PACKAGES_DIR", tmp_path / "pkg")
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "alpha").mkdir()
    assert packages.list_packages() == 0
    assert packages.remove("alpha") == 0
    assert packages.remove("missing") == 1


def test_skill_discovered_in_package(tmp_path, monkeypatch):
    from minima_harness.tui import customize

    monkeypatch.setattr(customize, "GLOBAL_DIR", tmp_path / "global")
    monkeypatch.setattr(customize, "PACKAGES_DIR", tmp_path / "global" / "packages")
    sk = tmp_path / "global" / "packages" / "pkgA" / "skills" / "demo"
    sk.mkdir(parents=True)
    (sk / "SKILL.md").write_text("demo skill body")
    out = customize.load_skills(tmp_path)
    assert "demo" in out
