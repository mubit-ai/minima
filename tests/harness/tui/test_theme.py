from __future__ import annotations

from minima_harness.tui.theme import THEMES, ThemeName, get_theme


def test_dark_and_light_exist():
    assert ThemeName.DARK in THEMES and ThemeName.LIGHT in THEMES


def test_get_theme_returns_palette():
    t = get_theme(ThemeName.DARK)
    assert t["user"].startswith("#")
    assert t["assistant"].startswith("#")
    assert t["tool"].startswith("#")
