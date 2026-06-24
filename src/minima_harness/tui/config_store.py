"""Per-user credential store for the harness — keyring-first, 0600-file fallback.

Mirrors how best-in-class coding-agent CLIs persist secrets (Claude Code: macOS Keychain,
else ``~/.<tool>/...`` at mode 0600). Secrets go to the OS keyring when a real backend is
available; otherwise they fall back to ``~/.minima-harness/config.env`` written 0600.
Non-secret config (URLs) always lives in the file — no point keychaining a URL.

The harness itself reads everything from environment variables (provider keys via
``resolve_api_key``, Mubit via ``os.environ``), so :func:`hydrate_env` materialises stored
values into ``os.environ`` at startup with ``setdefault`` — keeping the store the *lowest*
precedence (real shell env and project ``.env`` files still win).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from minima_harness.tui.customize import GLOBAL_DIR

CONFIG_FILE = GLOBAL_DIR / "config.env"
KEYRING_SERVICE = "minima-harness"


def _keyring():  # noqa: ANN202 - the keyring module type is optional/dynamic
    """Return the keyring module iff a *real* (non-fail) backend is available, else None."""
    try:
        import keyring
        from keyring.backends import fail

        if isinstance(keyring.get_keyring(), fail.Keyring):
            return None
        return keyring
    except Exception:  # noqa: BLE001 - keyring is optional; any failure → file fallback
        return None


@dataclass(frozen=True, slots=True)
class Field:
    """One configurable value. ``secret`` fields are masked + keyring-eligible."""

    key: str
    label: str
    secret: bool = True
    optional: bool = False
    default: str = ""
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Section:
    title: str
    note: str
    fields: tuple[Field, ...] = field(default_factory=tuple)


SECTIONS: tuple[Section, ...] = (
    Section(
        title="LLM provider keys",
        note="Used by the harness to RUN the chosen model.",
        fields=(
            Field("ANTHROPIC_API_KEY", "Anthropic (Claude) API key"),
            Field("GEMINI_API_KEY", "Google Gemini API key", aliases=("GOOGLE_API_KEY",)),
            Field("OPENAI_API_KEY", "OpenAI API key", optional=True),
        ),
    ),
    Section(
        title="Mubit / Minima routing",
        note="Mubit memory backend + the Minima recommender endpoint.",
        fields=(
            Field("MUBIT_API_KEY", "Mubit API key (memory + routing auth)"),
            Field(
                "MINIMA_URL",
                "Minima endpoint URL",
                secret=False,
                optional=True,
                default="https://api.minima.sh",
            ),
            Field(
                "MINIMA_API_KEY",
                "Minima auth (optional; falls back to MUBIT_API_KEY)",
                optional=True,
            ),
            Field("MUBIT_ENDPOINT", "Mubit endpoint URL", secret=False, optional=True),
        ),
    ),
)


def all_fields() -> list[Field]:
    return [f for section in SECTIONS for f in section.fields]


def field_for(key: str) -> Field | None:
    return next((f for f in all_fields() if f.key == key), None)


def backend_name() -> str:
    """The active secrets backend label, for display."""
    return "keyring" if _keyring() is not None else "file"


def mask(value: str | None) -> str:
    """Show only the last 4 chars of a secret (never the whole thing)."""
    if not value:
        return ""
    if len(value) <= 4:
        return "•" * len(value)
    return "•" * 4 + value[-4:]


# --- file backend (env-format, mode 0600) ---------------------------------------------


def _read_file() -> dict[str, str]:
    out: dict[str, str] = {}
    if not CONFIG_FILE.is_file():
        return out
    for raw in CONFIG_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _write_file(data: dict[str, str]) -> None:
    GLOBAL_DIR.mkdir(parents=True, exist_ok=True)
    lines = [f"{k}={v}" for k, v in sorted(data.items()) if v != ""]
    body = "\n".join(["# minima-harness config — managed by `minima-harness config`", *lines])
    # O_CREAT with 0600 so the file is owner-only from the moment it exists.
    fd = os.open(CONFIG_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, (body + "\n").encode("utf-8"))
    finally:
        os.close(fd)
    try:  # tighten perms even if the file pre-existed with looser ones
        os.chmod(CONFIG_FILE, 0o600)
    except OSError:
        pass


def _file_set(key: str, value: str) -> None:
    data = _read_file()
    data[key] = value
    _write_file(data)


def _file_delete(key: str) -> None:
    data = _read_file()
    if key in data:
        del data[key]
        _write_file(data)


# --- public get / set / unset ----------------------------------------------------------


def get(key: str) -> str | None:
    """Read a stored value: keyring first for secrets, then the file."""
    f = field_for(key)
    secret = f.secret if f else True
    if secret:
        kr = _keyring()
        if kr is not None:
            try:
                val = kr.get_password(KEYRING_SERVICE, key)
                if val:
                    return val
            except Exception:  # noqa: BLE001
                pass
    return _read_file().get(key)


def set_value(key: str, value: str) -> str:
    """Persist ``value``. Returns the backend used: ``"keyring"`` or ``"file"``."""
    f = field_for(key)
    secret = f.secret if f else True
    if secret:
        kr = _keyring()
        if kr is not None:
            try:
                kr.set_password(KEYRING_SERVICE, key, value)
                _file_delete(key)  # don't leave a stale plaintext copy behind
                return "keyring"
            except Exception:  # noqa: BLE001
                pass
    _file_set(key, value)
    return "file"


def unset(key: str) -> None:
    kr = _keyring()
    if kr is not None:
        try:
            kr.delete_password(KEYRING_SERVICE, key)
        except Exception:  # noqa: BLE001
            pass
    _file_delete(key)


def location(key: str) -> str:
    """Where ``key`` is stored: ``"keyring"`` | ``"file"`` | ``"—"`` (unset)."""
    f = field_for(key)
    secret = f.secret if f else True
    if secret:
        kr = _keyring()
        if kr is not None:
            try:
                if kr.get_password(KEYRING_SERVICE, key):
                    return "keyring"
            except Exception:  # noqa: BLE001
                pass
    return "file" if key in _read_file() else "—"


def hydrate_env() -> None:
    """Load stored config into ``os.environ`` (setdefault → real env / project files win)."""
    for f in all_fields():
        val = get(f.key)
        if not val:
            continue
        os.environ.setdefault(f.key, val)
        for alias in f.aliases:
            os.environ.setdefault(alias, val)
