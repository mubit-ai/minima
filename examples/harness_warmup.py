"""Warmup demo: run the task corpus through MinimaAgent, closing the loop.

Two modes:

  demo (default) -- in-process Minima (FakeMemory) + a fake model provider. Zero API
                    keys, zero external services. Runs anywhere; shows the full
                    recommend -> run -> judge -> feedback loop end to end.

  live (--live)  -- real Minima at $MINIMA_URL (default http://localhost:8080, `make run`)
                    + real providers. Needs provider API keys; judging uses each task's
                    deterministic quality_fn (no extra judge LLM required).

Run:
    uv run python examples/harness_warmup.py            # demo (no keys)
    uv run python examples/harness_warmup.py --live     # real (needs make run + keys)
    uv run python examples/harness_warmup.py --rounds 3
"""

from __future__ import annotations

import argparse
import asyncio
import os
import random
import sys
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

# Demo mode reuses the repo's in-process test doubles (FakeMemory); make the repo root
# importable when this script is run directly (`python examples/...` puts examples/ on
# sys.path, not the repo root).
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from minima_harness.minima import (  # noqa: E402
    HarnessConfig,
    MinimaAgent,
    MinimaRouter,
    RoutingResult,
)
from minima_harness.minima.judge import DeterministicJudge  # noqa: E402
from minima_harness.tasks import TASKS, Task  # noqa: E402

ROUNDS_DEFAULT = 2
SEED = 7
# Demo candidate must be known to Minima's catalog AND mapped in the harness registry.
DEMO_CANDIDATES = ["claude-haiku-4-5"]


# ---------------------------------------------------------------------------
# Per-task bookkeeping + printed table
# ---------------------------------------------------------------------------


def _quality_of(task: Task, agent: MinimaAgent) -> float | None:
    last = agent._last_assistant()  # noqa: SLF001
    if last is None or task.quality_fn is None:
        return None
    try:
        return max(0.0, min(1.0, float(task.quality_fn(last.text))))
    except Exception:  # noqa: BLE001
        return 0.0


def _row(task: Task, routing: RoutingResult | None, agent: MinimaAgent) -> dict[str, Any]:
    quality = _quality_of(task, agent)
    if quality is None:
        outcome = "n/a"
    elif quality >= 0.8:
        outcome = "success"
    elif quality >= 0.4:
        outcome = "partial"
    else:
        outcome = "failure"
    last = agent._last_assistant()  # noqa: SLF001
    out_tok = last.usage.output if last is not None else 0
    cost = last.usage.cost.total if last is not None else 0.0
    return {
        "label": task.label,
        "model": routing.chosen_model_id if routing else "(offline)",
        "basis": routing.decision_basis if routing else "-",
        "quality": f"{quality:.2f}" if quality is not None else "-",
        "outcome": outcome,
        "out_tok": str(out_tok),
        "cost$": f"{cost:.6f}",
    }


def _print_table(rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    cols = ["label", "model", "basis", "quality", "outcome", "out_tok", "cost$"]
    widths = {c: max(len(c), max(len(str(r[c])) for r in rows)) for c in cols}
    header = "  ".join(c.ljust(widths[c]) for c in cols)
    print(header)
    print("-" * len(header))
    for r in rows:
        print("  ".join(str(r[c]).ljust(widths[c]) for c in cols))


async def _run_corpus(
    agent: MinimaAgent, rounds: int, *, pre_task: Callable[[Task], None] | None = None
) -> list[dict[str, Any]]:
    rng = random.Random(SEED)
    rows: list[dict[str, Any]] = []
    for run_idx in range(rounds):
        print(f"\n=== run {run_idx + 1}/{rounds} ===")
        order = list(TASKS)
        rng.shuffle(order)
        for task in order:
            if pre_task is not None:
                pre_task(task)
            if task.quality_fn is not None:
                agent.judge = DeterministicJudge(task.quality_fn)
            try:
                routing = await agent.prompt(
                    task.prompt, task_type=task.task_type, slider=task.slider
                )
            except Exception as exc:  # noqa: BLE001
                print(f"  {task.label}: ERROR {exc}")
                continue
            row = _row(task, routing, agent)
            rows.append(row)
            print(
                f"  {row['label']:>16}  model={row['model']}  basis={row['basis']}  "
                f"quality={row['quality']}  outcome={row['outcome']}"
            )
    return rows


def _print_summary(rows: list[dict[str, Any]], *, remembered: int | None = None) -> None:
    print("\n=== summary ===")
    _print_table(rows)
    if rows:
        ok = sum(1 for r in rows if r["outcome"] == "success")
        print(f"\n{ok}/{len(rows)} successes")
    if remembered is not None:
        print(f"{remembered} outcomes written to Minima memory")


# ---------------------------------------------------------------------------
# Demo mode: in-process Minima + fake Anthropic provider
# ---------------------------------------------------------------------------


_current_answer = {"text": ""}


def _passing_answer(task: Task) -> str:
    """Synthesize an output the task's quality_fn grades highly (demo only)."""
    if task.expected:
        return task.expected
    if "binary search" in task.prompt.lower():
        return (
            "def binary_search(arr, x):\n"
            "    lo, hi = 0, len(arr) - 1\n"
            "    while lo <= hi:\n"
            "        mid = (lo + hi) // 2\n"
            "        ...\n\n"
            "assert binary_search([1, 2, 3], 2) == 1"
        )
    # length-based rubric -> return something substantial.
    return (
        "Use exponential backoff with full jitter: "
        "delay = random.uniform(0, min(cap, base * 2**n)). Full jitter avoids "
        "synchronization thundering herds while bounding worst-case wait. "
    ) * 12


def _fake_anthropic_client() -> Any:
    """A stand-in AsyncAnthropic whose stream echoes the current task's passing answer."""

    class _Stream:
        def __init__(self, text: str) -> None:
            self._text = text

        def __aiter__(self):
            async def _gen():
                yield SimpleNamespace(
                    type="message_start",
                    message=SimpleNamespace(
                        usage=SimpleNamespace(
                            input_tokens=42,
                            cache_read_input_tokens=0,
                            cache_creation_input_tokens=0,
                        )
                    ),
                )
                yield SimpleNamespace(
                    type="content_block_start",
                    index=0,
                    content_block=SimpleNamespace(type="text"),
                )
                yield SimpleNamespace(
                    type="content_block_delta",
                    index=0,
                    delta=SimpleNamespace(type="text_delta", text=self._text),
                )
                yield SimpleNamespace(type="content_block_stop", index=0)
                yield SimpleNamespace(
                    type="message_delta",
                    delta=SimpleNamespace(stop_reason="end_turn"),
                    usage=SimpleNamespace(output_tokens=max(1, len(self._text) // 4)),
                )
                yield SimpleNamespace(type="message_stop")

            return _gen()

    class _Mgr:
        def __init__(self, text: str) -> None:
            self._text = text

        async def __aenter__(self):
            return _Stream(self._text)

        async def __aexit__(self, *exc: object) -> None:
            return None

    class _Messages:
        def stream(self, **kwargs):
            return _Mgr(_current_answer["text"])

    class _Client:
        def __init__(self):
            self.messages = _Messages()

    return _Client()


async def run_demo(rounds: int) -> None:
    import httpx
    from minima_client import AsyncMinimaClient

    from minima.config import Settings
    from minima.main import create_app
    from minima_harness.ai import get_model
    from minima_harness.ai.providers import (
        ensure_providers_registered,
        get_provider,
        register_provider,
    )
    from minima_harness.ai.providers.anthropic import AnthropicProvider
    from tests.factories import FakeMemory

    print("[demo] in-process Minima (FakeMemory) + fake Anthropic provider — no keys needed")

    # Keep the demo hermetic + deterministic: neutralize a developer's .env the same way
    # the pytest suite does (autouse fixture), and quiet the ASGI client's request logs.
    os.environ.setdefault("MINIMA_REASONER_PROVIDER", "none")
    os.environ.setdefault("MINIMA_DURABLE_FASTPATH", "off")
    import logging

    logging.getLogger("httpx").setLevel(logging.WARNING)

    memory = FakeMemory()
    app = create_app(
        settings=Settings(mubit_api_key="demo-key"), memory=memory, start_refresh=False
    )
    ensure_providers_registered()
    original = get_provider("anthropic-messages")
    register_provider("anthropic-messages", AnthropicProvider(client=_fake_anthropic_client()))

    rows: list[dict[str, Any]] = []
    try:
        async with app.router.lifespan_context(app):
            client = AsyncMinimaClient("http://testserver", "demo-key", timeout=30.0)
            client._client = httpx.AsyncClient(  # noqa: SLF001
                transport=httpx.ASGITransport(app=app),
                base_url="http://testserver",
                headers={"Authorization": "Bearer demo-key"},
                timeout=30.0,
            )
            config = HarnessConfig(
                minima_url="http://testserver",
                minima_api_key="demo-key",
                candidates=DEMO_CANDIDATES,
                judge_every=1,
            )
            agent = MinimaAgent(
                config,
                router=MinimaRouter(client, config),
                judge=DeterministicJudge(lambda t: 0.5),
                model=get_model("anthropic", "claude-haiku-4-5"),
            )
            rows = await _run_corpus(
                agent,
                rounds,
                pre_task=lambda t: _current_answer.__setitem__("text", _passing_answer(t)),
            )
    finally:
        register_provider("anthropic-messages", original)

    _print_summary(rows, remembered=len(memory.remembered))


# ---------------------------------------------------------------------------
# Live mode: real Minima + real providers
# ---------------------------------------------------------------------------


async def run_live(rounds: int) -> None:
    url = os.environ.get("MINIMA_URL", "http://localhost:8080")
    key = os.environ.get("MUBIT_API_KEY") or os.environ.get("MINIMA_API_KEY")
    print(f"[live] Minima at {url} — needs provider API keys for the candidate models")
    config = HarnessConfig.from_env(minima_url=url, minima_api_key=key)
    agent = MinimaAgent(config)
    rows = await _run_corpus(agent, rounds)
    _print_summary(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Minima harness warmup demo")
    parser.add_argument("--live", action="store_true", help="use real Minima + providers")
    parser.add_argument("--rounds", type=int, default=ROUNDS_DEFAULT)
    args = parser.parse_args()

    if args.live:
        asyncio.run(run_live(args.rounds))
    else:
        asyncio.run(run_demo(args.rounds))


if __name__ == "__main__":
    sys.exit(main())
