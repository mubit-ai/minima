"""Anthropic-backed reasoner (Claude Haiku by default).

Uses forced tool use for guaranteed structured output (most robust across SDK
versions): a single `submit_*` tool with a strict schema, read back from the
tool_use block's already-parsed `input`. Haiku does not support effort/thinking,
so neither is set. Any error degrades gracefully to None (caller keeps the
deterministic recommendation).
"""

from __future__ import annotations

from collections.abc import Sequence

from anthropic import AsyncAnthropic

from costit.llm.base import (
    CLASSIFY_SCHEMA,
    CLASSIFY_SYSTEM,
    RANK_SYSTEM,
    RANKING_SCHEMA,
    CandidateView,
    ReasonerResult,
    build_rank_user,
    parse_classification,
    parse_ranking,
)
from costit.logging import get_logger
from costit.schemas.common import Difficulty, TaskType

log = get_logger("costit.llm.anthropic")

DEFAULT_MODEL = "claude-haiku-4-5"


class AnthropicReasoner:
    def __init__(self, *, model: str, api_key: str, timeout_ms: int, max_tokens: int):
        self._model = model
        self._max_tokens = max_tokens
        self._client = AsyncAnthropic(api_key=api_key, timeout=timeout_ms / 1000.0)

    async def _tool_call(
        self, *, system: str, user: str, tool_name: str, schema: dict
    ) -> dict | None:
        try:
            resp = await self._client.messages.create(
                model=self._model,
                max_tokens=self._max_tokens,
                system=system,
                messages=[{"role": "user", "content": user}],
                tools=[
                    {
                        "name": tool_name,
                        "description": "Submit the structured result.",
                        "strict": True,
                        "input_schema": schema,
                    }
                ],
                tool_choice={"type": "tool", "name": tool_name},
            )
        except Exception as exc:  # noqa: BLE001 — reasoner must never break a recommendation
            log.warning("reasoner_call_failed", model=self._model, error=str(exc))
            return None
        for block in resp.content:
            if getattr(block, "type", None) == "tool_use":
                # Access via getattr: the SDK's ContentBlock is a union and only the
                # tool_use variant carries `input` (type-narrowing on `.type` isn't seen
                # by the checker). Runtime guard above guarantees it's present.
                data = getattr(block, "input", None)
                return data if isinstance(data, dict) else None
        return None

    async def rank(
        self,
        *,
        task: str,
        task_type: str,
        difficulty: str,
        candidates: Sequence[CandidateView],
        memory_block: str,
        cost_quality_tradeoff: float,
    ) -> ReasonerResult | None:
        user = build_rank_user(
            task=task,
            task_type=task_type,
            difficulty=difficulty,
            candidates=candidates,
            memory_block=memory_block,
            cost_quality_tradeoff=cost_quality_tradeoff,
        )
        data = await self._tool_call(
            system=RANK_SYSTEM, user=user, tool_name="submit_ranking", schema=RANKING_SCHEMA
        )
        if data is None:
            return None
        return parse_ranking(data, {c.model_id for c in candidates})

    async def classify(self, *, task: str) -> tuple[TaskType, Difficulty] | None:
        data = await self._tool_call(
            system=CLASSIFY_SYSTEM,
            user=f"Classify this task:\n\n{task[:2000]}",
            tool_name="submit_classification",
            schema=CLASSIFY_SCHEMA,
        )
        if data is None:
            return None
        return parse_classification(data)
