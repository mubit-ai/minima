"""run_print/run_json surface provider errors instead of printing a silent blank line."""

from __future__ import annotations

import asyncio

from minima_harness.ai import AssistantMessage, TextContent
from minima_harness.ai.providers import register_faux_provider
from minima_harness.minima import HarnessConfig, MinimaAgent
from minima_harness.tui.run_modes import run_print


def _msg(text: str) -> AssistantMessage:
    return AssistantMessage(content=[TextContent(text=text)])


def _offline_cfg() -> HarnessConfig:
    # minima_url="" -> routing disabled -> runs the fixed model with no router needed.
    return HarnessConfig(minima_url="", candidates=["faux"], judge_every=0, allow_offline=True)


def test_run_print_reports_provider_error(capsys):
    with register_faux_provider() as reg:
        faux = reg.get_model()  # no responses queued -> provider error turn
        agent = MinimaAgent(_offline_cfg(), model=faux)
        rc = asyncio.run(run_print(agent, "hi"))
    captured = capsys.readouterr()
    assert rc == 1  # non-zero exit on failure
    assert captured.err.strip()  # the reason went to stderr
    assert captured.out.strip() == ""  # nothing misleading on stdout


def test_run_print_prints_answer_on_success(capsys):
    with register_faux_provider() as reg:
        reg.set_responses([_msg("the answer")])
        faux = reg.get_model()
        agent = MinimaAgent(_offline_cfg(), model=faux)
        rc = asyncio.run(run_print(agent, "hi"))
    captured = capsys.readouterr()
    assert rc == 0
    assert "the answer" in captured.out
