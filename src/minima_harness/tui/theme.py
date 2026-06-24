from __future__ import annotations

from enum import StrEnum
from pathlib import Path

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
    # Footer/status emphasis: amber for $ value (legible against green/blue), a brighter
    # dim than `muted` for de-emphasized metrics. .get()-accessed so JSON themes can omit them.
    "footer_accent": "#e0af68",
    "footer_dim": "#9aa0a6",
}

LIGHT: Palette = {
    "user": "#1f4de0",
    "assistant": "#222222",
    "tool": "#7c3aed",
    "warning": "#c0152e",
    "muted": "#7a7a7a",
    "accent": "#0f7b3a",
    "footer_accent": "#b45309",
    "footer_dim": "#6b7280",
}

THEMES: dict[ThemeName, Palette] = {ThemeName.DARK: DARK, ThemeName.LIGHT: LIGHT}

# Registry of usable themes: the two built-ins plus any loaded from JSON files.
_registry: dict[str, Palette] = {"dark": DARK, "light": LIGHT}
_active: str = "dark"


def available_themes() -> dict[str, Palette]:
    """All themes usable by name right now (built-ins + loaded file themes)."""
    return dict(_registry)


def register_theme(name: str, palette: Palette) -> None:
    _registry[name] = palette


def reload_file_themes(cwd: Path) -> None:
    """Re-discover ``*.json`` theme files and merge into the registry (hot-reload)."""
    from minima_harness.tui.customize import load_file_themes

    for name, palette in load_file_themes(cwd).items():
        register_theme(name, palette)


def current_theme() -> str:
    return _active


def set_theme(name: str) -> Palette:
    global _active
    if name not in _registry:
        raise KeyError(f"unknown theme: {name}")
    _active = name
    return _registry[name]


def get_theme(name: str) -> Palette:
    if name not in _registry:
        raise KeyError(f"unknown theme: {name}")
    return _registry[name]
