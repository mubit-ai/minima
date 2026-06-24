"""Mubit prompt optimization (Phase 3): Path A (server), Path B (local), overlay, fail-open."""

from __future__ import annotations

import pytest

from minima_harness.tui import mubit as mb


def test_optimize_prompt_none_when_uninitialized(monkeypatch):
    monkeypatch.setattr(mb, "_initialized", False)
    assert mb.optimize_prompt() is None


def test_propose_path_a_mubit(monkeypatch, tmp_path):
    monkeypatch.setattr(mb, "get_prompt", lambda: "OLD PROMPT that is fairly long. " * 6)
    monkeypatch.setattr(
        mb,
        "optimize_prompt",
        lambda: {
            "success": True,
            "activated": False,
            "confidence": 0.9,
            "optimization_summary": "Incorporated lesson 1 (exponential backoff on 429).",
            "candidate": {"content": "NEW SHORTER PROMPT", "status": "candidate"},
        },
    )
    opt = mb.propose_prompt_optimization(tmp_path)
    assert opt is not None
    assert opt.source == "mubit"
    assert opt.new_prompt == "NEW SHORTER PROMPT"
    assert opt.rationale == "Incorporated lesson 1 (exponential backoff on 429)."
    assert opt.est_savings == opt.current_tokens - opt.new_tokens
    assert opt.est_savings > 0  # the candidate is shorter here


def test_propose_path_b_local_dedup(monkeypatch, tmp_path):
    monkeypatch.setattr(mb, "optimize_prompt", lambda: None)  # Mubit unavailable
    monkeypatch.setattr(mb, "get_prompt", lambda: "line one\nDUP LINE\nDUP LINE\nline two")
    opt = mb.propose_prompt_optimization(tmp_path)
    assert opt is not None
    assert opt.source == "local"
    assert opt.new_prompt.count("DUP LINE") == 1
    assert opt.est_savings > 0


def test_propose_none_when_nothing_to_do(monkeypatch, tmp_path):
    monkeypatch.setattr(mb, "optimize_prompt", lambda: None)
    monkeypatch.setattr(mb, "get_prompt", lambda: "")  # no current Mubit prompt
    assert mb.propose_prompt_optimization(tmp_path) is None


def test_propose_falls_back_when_mubit_unsuccessful(monkeypatch, tmp_path):
    monkeypatch.setattr(mb, "optimize_prompt", lambda: {"success": False})
    dup = "this is a repeated instruction line of some length"
    monkeypatch.setattr(mb, "get_prompt", lambda: f"{dup}\n{dup}\nunique tail instruction")
    opt = mb.propose_prompt_optimization(tmp_path)
    assert opt is not None and opt.source == "local"


@pytest.mark.asyncio
async def test_optimization_overlay_apply():
    from textual.app import App, ComposeResult
    from textual.widgets import Static

    from minima_harness.tui.mubit import Optimization
    from minima_harness.tui.overlays import PromptOptimizationOverlay

    opt = Optimization("NEW PROMPT", 100, 60, 40, "removed cruft", "mubit")

    class _App(App):
        result: dict | None = None

        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(
                PromptOptimizationOverlay(opt),
                callback=lambda r: setattr(self, "result", r),
            )

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.action_apply()
        await pilot.pause()
    assert app.result == {"action": "apply", "content": "NEW PROMPT"}


@pytest.mark.asyncio
async def test_optimization_overlay_cancel():
    from textual.app import App, ComposeResult
    from textual.widgets import Static

    from minima_harness.tui.mubit import Optimization
    from minima_harness.tui.overlays import PromptOptimizationOverlay

    opt = Optimization("NEW", 10, 8, 2, "", "local")

    class _App(App):
        result: dict | None = "sentinel"  # type: ignore[assignment]

        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(
                PromptOptimizationOverlay(opt),
                callback=lambda r: setattr(self, "result", r),
            )

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("escape")
        await pilot.pause()
    assert app.result is None
