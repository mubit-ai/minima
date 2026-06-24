from __future__ import annotations

import json

from minima_harness.tui import customize


def test_load_file_themes_filters_to_palette_keys(tmp_path, monkeypatch):
    monkeypatch.setattr(customize, "GLOBAL_DIR", tmp_path / "global")
    th = tmp_path / "global" / "themes"
    th.mkdir(parents=True)
    (th / "nord.json").write_text(json.dumps({"user": "#1", "assistant": "#2", "junk": "x"}))
    assert customize.load_file_themes(tmp_path) == {"nord": {"user": "#1", "assistant": "#2"}}


def test_load_templates(tmp_path, monkeypatch):
    monkeypatch.setattr(customize, "GLOBAL_DIR", tmp_path / "global")
    prompts = tmp_path / "global" / "prompts"
    prompts.mkdir(parents=True)
    (prompts / "review.md").write_text("Review this code for {{focus}}.")
    assert customize.load_templates(tmp_path) == {"review": "Review this code for {{focus}}."}


def test_load_skills_discovers_skill_md(tmp_path, monkeypatch):
    monkeypatch.setattr(customize, "GLOBAL_DIR", tmp_path / "global")
    skill = tmp_path / "global" / "skills" / "debug"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("# Debug skill\nUse a debugger.")
    out = customize.load_skills(tmp_path)
    assert "debug" in out
    assert out["debug"].startswith("# Debug skill")
