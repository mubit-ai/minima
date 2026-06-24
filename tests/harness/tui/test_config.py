from __future__ import annotations

import stat

import pytest

from minima_harness.tui import config_cli, config_store


class _FakeKeyring:
    """In-memory stand-in for the keyring module (service, key) -> value."""

    def __init__(self) -> None:
        self.store: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, key: str) -> str | None:
        return self.store.get((service, key))

    def set_password(self, service: str, key: str, value: str) -> None:
        self.store[(service, key)] = value

    def delete_password(self, service: str, key: str) -> None:
        self.store.pop((service, key), None)


@pytest.fixture
def file_store(tmp_path, monkeypatch):
    """config_store wired to a temp file with NO keyring (file backend)."""
    monkeypatch.setattr(config_store, "CONFIG_FILE", tmp_path / "config.env")
    monkeypatch.setattr(config_store, "GLOBAL_DIR", tmp_path)
    monkeypatch.setattr(config_store, "_keyring", lambda: None)
    return config_store


@pytest.fixture
def keyring_store(tmp_path, monkeypatch):
    """config_store with a fake keyring backend present."""
    monkeypatch.setattr(config_store, "CONFIG_FILE", tmp_path / "config.env")
    monkeypatch.setattr(config_store, "GLOBAL_DIR", tmp_path)
    fake = _FakeKeyring()
    monkeypatch.setattr(config_store, "_keyring", lambda: fake)
    return config_store, fake


# --- masking ---------------------------------------------------------------------------


def test_mask_shows_only_last_four():
    assert config_store.mask("sk-abcdEFGH") == "••••EFGH"
    assert config_store.mask("xyz") == "•••"  # short secrets fully hidden
    assert config_store.mask("") == ""
    assert config_store.mask(None) == ""


# --- file backend round-trip + permissions --------------------------------------------


def test_file_backend_roundtrip_and_0600(file_store):
    assert file_store.set_value("ANTHROPIC_API_KEY", "sk-secret-1234") == "file"
    assert file_store.get("ANTHROPIC_API_KEY") == "sk-secret-1234"
    assert file_store.location("ANTHROPIC_API_KEY") == "file"

    mode = stat.S_IMODE(file_store.CONFIG_FILE.stat().st_mode)
    assert mode == 0o600  # owner-only

    file_store.unset("ANTHROPIC_API_KEY")
    assert file_store.get("ANTHROPIC_API_KEY") is None
    assert file_store.location("ANTHROPIC_API_KEY") == "—"


def test_secret_value_never_in_plaintext_when_keyring_present(keyring_store):
    store, fake = keyring_store
    assert store.set_value("MUBIT_API_KEY", "mubit-topsecret") == "keyring"
    # round-trips via keyring
    assert store.get("MUBIT_API_KEY") == "mubit-topsecret"
    assert store.location("MUBIT_API_KEY") == "keyring"
    # and the plaintext file must not contain it
    if store.CONFIG_FILE.is_file():
        assert "mubit-topsecret" not in store.CONFIG_FILE.read_text()
    assert ("minima-harness", "MUBIT_API_KEY") in fake.store


def test_nonsecret_always_goes_to_file_even_with_keyring(keyring_store):
    store, _fake = keyring_store
    assert store.set_value("MINIMA_URL", "https://api.minima.sh") == "file"
    assert store.location("MINIMA_URL") == "file"
    assert store.get("MINIMA_URL") == "https://api.minima.sh"


# --- env hydration ---------------------------------------------------------------------


def test_hydrate_env_sets_defaults_and_aliases(file_store, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    file_store.set_value("GEMINI_API_KEY", "g-123")
    file_store.hydrate_env()
    import os

    assert os.environ["GEMINI_API_KEY"] == "g-123"
    assert os.environ["GOOGLE_API_KEY"] == "g-123"  # alias mirrored


def test_hydrate_env_does_not_override_real_env(file_store, monkeypatch):
    monkeypatch.setenv("MUBIT_API_KEY", "from-shell")
    file_store.set_value("MUBIT_API_KEY", "from-store")
    file_store.hydrate_env()
    import os

    assert os.environ["MUBIT_API_KEY"] == "from-shell"  # setdefault → shell wins


# --- CLI surface -----------------------------------------------------------------------


def test_cli_set_get_list_unset(file_store, capsys):
    assert config_cli.config_cli(["set", "OPENAI_API_KEY", "sk-openai-WXYZ"]) == 0

    assert config_cli.config_cli(["get", "OPENAI_API_KEY"]) == 0
    out = capsys.readouterr().out
    assert "••••WXYZ" in out  # masked
    assert "sk-openai-WXYZ" not in out  # raw secret never printed

    assert config_cli.config_cli(["list"]) == 0
    out = capsys.readouterr().out
    assert "OPENAI_API_KEY" in out and "••••WXYZ" in out
    assert "sk-openai-WXYZ" not in out
    assert "MISSING" in out  # other required keys flagged

    assert config_cli.config_cli(["unset", "OPENAI_API_KEY"]) == 0
    assert config_cli.config_cli(["get", "OPENAI_API_KEY"]) == 1  # unset → nonzero


def test_cli_path_and_bad_usage(file_store, capsys):
    assert config_cli.config_cli(["path"]) == 0
    assert str(file_store.CONFIG_FILE) in capsys.readouterr().out
    assert config_cli.config_cli(["bogus"]) == 2


def test_cli_doctor_reports_presence_only(file_store, monkeypatch, capsys):
    import httpx

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    file_store.set_value("MUBIT_API_KEY", "mubit-doctor-secret")

    def _boom(*a, **k):
        raise httpx.ConnectError("no network in tests")

    monkeypatch.setattr(httpx, "get", _boom)
    assert config_cli.config_cli(["doctor"]) == 0
    out = capsys.readouterr().out
    assert "Mubit" in out and "present" in out
    assert "Anthropic" in out and "missing" in out
    assert "unreachable" in out
    assert "mubit-doctor-secret" not in out  # never echoes the value


# --- overlay ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_config_overlay_saves_changed_fields(file_store):
    from textual.app import App
    from textual.widgets import Input

    from minima_harness.tui.overlays import ConfigOverlay

    class _App(App):
        result: dict | None = "sentinel"  # type: ignore[assignment]

        def on_mount(self) -> None:
            self.push_screen(ConfigOverlay(), callback=lambda r: setattr(self, "result", r))

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#cfg-ANTHROPIC_API_KEY", Input).value = "sk-new-key-ABCD"
        await pilot.press("ctrl+s")
        await pilot.pause()

    assert app.result == {"ANTHROPIC_API_KEY": "sk-new-key-ABCD"}
    assert file_store.get("ANTHROPIC_API_KEY") == "sk-new-key-ABCD"


@pytest.mark.asyncio
async def test_config_overlay_cancel_returns_none(file_store):
    from textual.app import App

    from minima_harness.tui.overlays import ConfigOverlay

    class _App(App):
        result: dict | None = "sentinel"  # type: ignore[assignment]

        def on_mount(self) -> None:
            self.push_screen(ConfigOverlay(), callback=lambda r: setattr(self, "result", r))

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("escape")
        await pilot.pause()

    assert app.result is None
