"""Phase B runtime integration: MinimaAgent wires files= through the extractor into
recommend() (code-quality signals reach Minima), and is a no-op without files/extractor."""

from __future__ import annotations

import asyncio

from minima_harness.ai import AssistantMessage, TextContent, get_model
from minima_harness.ai.providers import register_faux_provider
from minima_harness.ai.types import Usage
from minima_harness.minima import CodeHealthExtractor, HarnessConfig, MinimaAgent
from minima_harness.minima.judge import DeterministicJudge
from minima_harness.minima.router import RoutingResult


class _RecordingRouter:
    def __init__(self, model):
        self.model = model
        self.calls: list[dict] = []
        from minima_harness.minima import ModelMapping

        self.mapping = ModelMapping()

    async def recommend(
        self,
        task,
        *,
        task_type=None,
        slider=None,
        tags=None,
        difficulty=None,
        expected_input_tokens=None,
        candidates=None,
    ):
        self.calls.append(
            {
                "task": task,
                "task_type": task_type,
                "tags": tags,
                "difficulty": difficulty,
                "exp": expected_input_tokens,
            }
        )
        return RoutingResult(
            recommendation_id="rec-1",
            chosen_model_id="claude-haiku-4-5",
            model=self.model,
            est_cost_usd=0.001,
            decision_basis="memory",
        )

    async def feedback(self, *a, **k):
        return None


_COMPLEX = (
    "def h(r):\n  if r.x:\n    for i in r.items:\n      if i and i.k in ('a','b'):\n        pass\n"
) * 12


def _text_msg(text):
    m = AssistantMessage(content=[TextContent(text=text)])
    m.usage = Usage(input=5, output=5)
    return m


def test_agent_passes_code_signals_to_router(tmp_path):
    complex_file = tmp_path / "svc.py"
    complex_file.write_text(_COMPLEX)
    with register_faux_provider() as reg:
        router = _RecordingRouter(reg.get_model())
        agent = MinimaAgent(
            HarnessConfig(candidates=["claude-haiku-4-5"], judge_every=1),
            router=router,
            judge=DeterministicJudge(lambda t: 0.9),
            model=get_model("anthropic", "claude-haiku-4-5"),
            extractor=CodeHealthExtractor(),
        )
        asyncio.run(agent.prompt("refactor svc", task_type="code", files=[complex_file]))

    call = router.calls[0]
    assert call["tags"] is not None and "complexity:high" in call["tags"]
    assert call["difficulty"] in ("hard", "expert")
    assert call["exp"] and call["exp"] > 0


def test_agent_without_files_sends_no_signals(tmp_path):
    with register_faux_provider() as reg:
        router = _RecordingRouter(reg.get_model())
        agent = MinimaAgent(
            HarnessConfig(candidates=["claude-haiku-4-5"], judge_every=1),
            router=router,
            judge=DeterministicJudge(lambda t: 0.9),
            model=get_model("anthropic", "claude-haiku-4-5"),
            extractor=CodeHealthExtractor(),
        )
        asyncio.run(agent.prompt("just a question"))  # no files=

    call = router.calls[0]
    assert call["tags"] is None
    assert call["difficulty"] is None
    assert call["exp"] is None


def test_agent_without_extractor_sends_no_signals(tmp_path):
    complex_file = tmp_path / "svc.py"
    complex_file.write_text(_COMPLEX)
    with register_faux_provider() as reg:
        router = _RecordingRouter(reg.get_model())
        agent = MinimaAgent(
            HarnessConfig(candidates=["claude-haiku-4-5"], judge_every=1),
            router=router,
            judge=DeterministicJudge(lambda t: 0.9),
            model=get_model("anthropic", "claude-haiku-4-5"),
            # no extractor
        )
        asyncio.run(agent.prompt("refactor svc", files=[complex_file]))

    assert router.calls[0]["tags"] is None
