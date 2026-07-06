"""Gemini-backed reasoner (best-effort, secondary provider).

Uses google-genai structured output. Any error degrades gracefully to None.

Gemini's ``response_schema`` is a constrained dialect of JSON Schema (a single ``type``
per field plus a ``nullable`` flag; no ``type: [...]`` unions and no
``additionalProperties``), so the Anthropic/strict-JSON schemas in ``llm.base`` can't be
reused verbatim — these Gemini-native equivalents below are what the API accepts.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

from minima.llm.base import (
    CLASSIFY_SYSTEM,
    RANK_SYSTEM,
    CandidateView,
    ReasonerResult,
    build_rank_user,
    parse_classification,
    parse_ranking,
)
from minima.logging import get_logger
from minima.schemas.common import Difficulty, TaskType

log = get_logger("minima.llm.gemini")

DEFAULT_MODEL = "gemini-2.5-flash"

_GEMINI_RANKING_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "recommended": {"type": "string"},
        "fallback": {"type": "string", "nullable": True},
        "ranking": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "model_id": {"type": "string"},
                    "predicted_success": {"type": "number"},
                    "rationale": {"type": "string"},
                },
                "required": ["model_id", "predicted_success", "rationale"],
            },
        },
    },
    "required": ["recommended", "ranking"],
}

_GEMINI_CLASSIFY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "task_type": {"type": "string", "enum": [t.value for t in TaskType]},
        "difficulty": {"type": "string", "enum": [d.value for d in Difficulty]},
    },
    "required": ["task_type", "difficulty"],
}


class GeminiReasoner:
    def __init__(self, *, model: str, api_key: str, timeout_ms: int, max_tokens: int):
        import google.genai as genai  # lazy; optional extra

        self._genai = genai
        self._model = model
        self._max_tokens = max_tokens
        # Bound the call so a hung provider can't stall a recommendation (genai timeout
        # is in milliseconds). Without this the Gemini client would wait indefinitely.
        self._client = genai.Client(api_key=api_key, http_options={"timeout": timeout_ms})

    async def _json_call(self, *, system: str, user: str, schema: dict) -> Any | None:
        try:
            resp = await self._client.aio.models.generate_content(
                model=self._model,
                contents=user,
                config={
                    "system_instruction": system,
                    "response_mime_type": "application/json",
                    "response_schema": schema,
                    "max_output_tokens": self._max_tokens,
                    # Gemini 2.5 models think by default and thinking tokens count against
                    # max_output_tokens — on hard prompts the budget was consumed before any
                    # JSON was emitted (observed live: classify failed on exactly the
                    # hard/expert prompts, rank flaked near the cap). These are small
                    # advisory JSON calls on a 15s deadline; disable thinking outright.
                    "thinking_config": {"thinking_budget": 0},
                },
            )
            text = getattr(resp, "text", None)
            if not text:
                return None
            return json.loads(text)
        except Exception as exc:  # noqa: BLE001 — reasoner must never break a recommendation
            log.warning("reasoner_call_failed", model=self._model, error=str(exc))
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
        data = await self._json_call(system=RANK_SYSTEM, user=user, schema=_GEMINI_RANKING_SCHEMA)
        if data is None:
            return None
        return parse_ranking(data, {c.model_id for c in candidates})

    async def classify(self, *, task: str) -> tuple[TaskType, Difficulty] | None:
        data = await self._json_call(
            system=CLASSIFY_SYSTEM, user=task[:2000], schema=_GEMINI_CLASSIFY_SCHEMA
        )
        if data is None:
            return None
        return parse_classification(data)
