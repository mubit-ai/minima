from __future__ import annotations

from minima_harness.tui.context import BASE_SYSTEM, build_system_prompt


def test_base_when_no_files(tmp_path, monkeypatch):
    monkeypatch.setattr("minima_harness.tui.context.GLOBAL_DIR", tmp_path / "global")
    assert build_system_prompt(tmp_path) == BASE_SYSTEM


def test_agents_md_appended(tmp_path, monkeypatch):
    monkeypatch.setattr("minima_harness.tui.context.GLOBAL_DIR", tmp_path / "global")
    (tmp_path / "AGENTS.md").write_text("# Rules\nUse ruff.")
    prompt = build_system_prompt(tmp_path)
    assert BASE_SYSTEM in prompt
    assert "Use ruff." in prompt
    assert "Project context" in prompt


def test_system_md_replaces_base(tmp_path, monkeypatch):
    monkeypatch.setattr("minima_harness.tui.context.GLOBAL_DIR", tmp_path / "global")
    (tmp_path / "SYSTEM.md").write_text("CUSTOM PROMPT")
    prompt = build_system_prompt(tmp_path)
    assert prompt.startswith("CUSTOM PROMPT")
    assert BASE_SYSTEM not in prompt


def test_append_system_md(tmp_path, monkeypatch):
    monkeypatch.setattr("minima_harness.tui.context.GLOBAL_DIR", tmp_path / "global")
    (tmp_path / "APPEND_SYSTEM.md").write_text("EXTRA RULES")
    prompt = build_system_prompt(tmp_path)
    assert BASE_SYSTEM in prompt and "EXTRA RULES" in prompt


def test_parent_walk(tmp_path, monkeypatch):
    monkeypatch.setattr("minima_harness.tui.context.GLOBAL_DIR", tmp_path / "global")
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "AGENTS.md").write_text("PARENT RULES")
    sub = proj / "sub"
    sub.mkdir()
    assert "PARENT RULES" in build_system_prompt(sub)
