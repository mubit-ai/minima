from __future__ import annotations

import pytest
from textual.app import App, ComposeResult

from minima_harness.tui.history import History, append_history, load_history


def test_history_prev_next_cycle():
    h = History(["a", "b", "c"])
    assert h.prev() == "c"
    assert h.prev() == "b"
    assert h.prev() == "a"
    assert h.prev() == "a"  # clamp at oldest
    assert h.next() == "b"
    assert h.next() == "c"
    assert h.next() == ""  # back to the new/empty position
    assert h.next() is None  # already new


def test_history_add_resets_to_new():
    h = History(["a"])
    h.prev()  # browsing "a"
    h.add("b")
    assert h.prev() == "b"  # newly added is the latest


def test_load_append_history_roundtrip(tmp_path, monkeypatch):
    from minima_harness.tui import history as hmod

    monkeypatch.setattr(hmod, "GLOBAL_DIR", tmp_path / "h")
    append_history(tmp_path, "first")
    append_history(tmp_path, "second")
    assert load_history(tmp_path) == ["first", "second"]


@pytest.mark.asyncio
async def test_editor_up_down_recalls_history():
    from minima_harness.tui.widgets.editor import Editor

    class _App(App):
        def compose(self) -> ComposeResult:
            yield Editor()

        def on_mount(self) -> None:
            ed = self.query_one(Editor)
            ed.prompt_history = History(["hello there"])
            ed.focus()

    app = _App()
    async with app.run_test() as pilot:
        await pilot.press("up")
        await pilot.pause()
        assert app.query_one(Editor).text == "hello there"
        await pilot.press("down")
        await pilot.pause()
        assert app.query_one(Editor).text == ""


@pytest.mark.asyncio
async def test_load_session_rebuilds_context_and_transcript(tmp_path):
    from minima_harness.minima.config import HarnessConfig
    from minima_harness.minima.runtime import MinimaAgent
    from minima_harness.session import SessionStore
    from minima_harness.session.format import EntryType
    from minima_harness.tui.app import HarnessApp
    from minima_harness.tui.widgets.messages import ChatLog, MessageBubble

    store = SessionStore.file_backed(tmp_path / "s.jsonl")
    store.append(EntryType.USER, {"text": "hi"})
    store.append(EntryType.ASSISTANT, {"text": "hello"})

    cfg = HarnessConfig(allow_offline=True)
    agent = MinimaAgent(cfg, tools=[])
    app = HarnessApp(cfg, session=SessionStore.in_memory(), agent=agent, cwd=tmp_path)
    async with app.run_test() as pilot:
        await app._load_session(store)
        await pilot.pause()
        assert [m.text for m in app.agent.state.messages] == ["hi", "hello"]
        bubbles = [b.buffer for b in app.query_one(ChatLog).query(MessageBubble)]
        assert "hi" in bubbles and "hello" in bubbles


@pytest.mark.asyncio
async def test_session_picker_dismisses_with_chosen_path(tmp_path):
    from textual.widgets import Static

    from minima_harness.session.store import SessionSummary
    from minima_harness.tui.overlays import SessionPicker

    summary = SessionSummary(
        session_id="abc12345",
        path=tmp_path / "abc.jsonl",
        display_name=None,
        mtime=0.0,
        n_entries=3,
    )

    class _App(App):
        result: str | None = "x"

        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(
                SessionPicker([summary]), callback=lambda r: setattr(self, "result", r)
            )

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("enter")  # select the first (only) session
        await pilot.pause()
    assert app.result == str(tmp_path / "abc.jsonl")


@pytest.mark.asyncio
async def test_session_picker_row_shows_created_and_used_timestamps(tmp_path):
    import time

    from textual.app import App
    from textual.widgets import OptionList, Static

    from minima_harness.session.store import SessionSummary
    from minima_harness.tui.overlays import SessionPicker

    now = time.time()
    summary = SessionSummary(
        session_id="abc12345",
        path=tmp_path / "abc.jsonl",
        display_name=None,
        mtime=now - 2 * 3600,  # used 2h ago
        n_entries=3,
        created=now - 3 * 86400,  # created 3d ago
    )

    class _App(App):
        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(SessionPicker([summary]))

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        label = str(app.screen.query_one(OptionList).get_option_at_index(0).prompt)
    assert "3 entries" in label
    assert "used 2h ago" in label
    assert "created 3d ago" in label
