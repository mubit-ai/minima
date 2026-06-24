from __future__ import annotations

import json
from pathlib import Path

GLOBAL_DIR = Path.home() / ".minima-harness"
PACKAGES_DIR = GLOBAL_DIR / "packages"

# Theme palette keys a theme JSON file may set.
_THEME_KEYS = ("user", "assistant", "tool", "warning", "muted", "accent")


def package_roots() -> list[Path]:
    """Installed package roots (``~/.minima-harness/packages/*/``)."""
    if not PACKAGES_DIR.is_dir():
        return []
    return [d for d in sorted(PACKAGES_DIR.iterdir()) if d.is_dir()]


def _theme_dirs(cwd: Path) -> list[Path]:
    return [GLOBAL_DIR / "themes", cwd / ".pi" / "themes", *(p / "themes" for p in package_roots())]


def _prompt_dirs(cwd: Path) -> list[Path]:
    return [
        GLOBAL_DIR / "prompts",
        cwd / ".pi" / "prompts",
        *(p / "prompts" for p in package_roots()),
    ]


def _skill_dirs(cwd: Path) -> list[Path]:
    # Agent Skills standard: ~/.agents/skills and .agents/skills (cwd); plus our dirs + packages.
    return [
        GLOBAL_DIR / "skills",
        Path.home() / ".agents" / "skills",
        cwd / ".agents" / "skills",
        cwd / ".pi" / "skills",
        *(p / "skills" for p in package_roots()),
    ]


def load_file_themes(cwd: Path) -> dict[str, dict[str, str]]:
    """Discover ``*.json`` theme files → {name: palette} (palettes keyed by _THEME_KEYS)."""
    out: dict[str, dict[str, str]] = {}
    for base in _theme_dirs(cwd):
        if not base.is_dir():
            continue
        for f in sorted(base.glob("*.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001 - one bad file must not break themes
                continue
            if isinstance(data, dict):
                palette = {k: str(v) for k, v in data.items() if k in _THEME_KEYS}
                if palette:
                    out[f.stem] = palette
    return out


def load_templates(cwd: Path) -> dict[str, str]:
    """Discover ``*.md`` prompt templates → {name (stem): body}."""
    out: dict[str, str] = {}
    for base in _prompt_dirs(cwd):
        if not base.is_dir():
            continue
        for f in sorted(base.glob("*.md")):
            try:
                body = f.read_text(encoding="utf-8").strip()
            except Exception:  # noqa: BLE001
                continue
            if body:
                out[f.stem] = body
    return out


def load_skills(cwd: Path) -> dict[str, str]:
    """Discover ``<dir>/<name>/SKILL.md`` skill packages → {name: body}."""
    out: dict[str, str] = {}
    for base in _skill_dirs(cwd):
        if not base.is_dir():
            continue
        for d in sorted(base.iterdir()):
            if not d.is_dir():
                continue
            skill = d / "SKILL.md"
            if d.name in out or not skill.is_file():
                continue
            try:
                body = skill.read_text(encoding="utf-8").strip()
            except Exception:  # noqa: BLE001
                continue
            if body:
                out[d.name] = body
    return out
