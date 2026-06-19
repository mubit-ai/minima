from __future__ import annotations

from enum import StrEnum

Palette = dict[str, str]


class ThemeName(StrEnum):
    DARK = "dark"
    LIGHT = "light"


DARK: Palette = {
    "user": "#7aa2f7",
    "assistant": "#e0e0e0",
    "tool": "#bb9af7",
    "warning": "#f7768e",
    "muted": "#665c6e",
    "accent": "#9ece6a",
}

LIGHT: Palette = {
    "user": "#1f4de0",
    "assistant": "#222222",
    "tool": "#7c3aed",
    "warning": "#c0152e",
    "muted": "#7a7a7a",
    "accent": "#0f7b3a",
}

THEMES: dict[ThemeName, Palette] = {ThemeName.DARK: DARK, ThemeName.LIGHT: LIGHT}


def get_theme(name: ThemeName | str) -> Palette:
    return THEMES[ThemeName(name)]
