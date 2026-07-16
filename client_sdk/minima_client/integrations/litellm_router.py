"""LiteLLM adapter: Minima as a custom routing strategy + a feedback logger.

Usage::

    import litellm
    from litellm import Router
    from minima_client import MinimaClient
    from minima_client.integrations.litellm_router import (
        MinimaFeedbackLogger,
        MinimaRoutingStrategy,
    )

    router = Router(model_list=[...])            # your deployments as usual
    minima = MinimaClient("https://api.minima.sh", api_key="<mubit-key>")
    strategy = MinimaRoutingStrategy(minima, router)
    router.set_custom_routing_strategy(strategy)
    litellm.callbacks = [MinimaFeedbackLogger(minima, strategy)]

Every ``router.completion(model="my-group", ...)`` then asks Minima which deployment
to run, and the logger reports realized cost back. Without a quality signal the
feedback is COST TELEMETRY only (``evidence_source="none"``) — pass ``quality_fn``
to grade responses and make the outcomes teach the success posterior too.
"""

from __future__ import annotations

import hashlib
import time
from collections import OrderedDict
from collections.abc import Callable
from typing import Any

from litellm.integrations.custom_logger import CustomLogger
from litellm.router import CustomRoutingStrategyBase

_CORRELATION_CAP = 512


def _task_text(messages: list[dict[str, str]] | None, fallback: str) -> str:
    for message in reversed(messages or []):
        if message.get("role") == "user" and message.get("content"):
            return str(message["content"])
    return fallback


def _bare_model(litellm_model: str) -> str:
    """'anthropic/claude-haiku-4-5' -> 'claude-haiku-4-5' (Minima catalog ids are bare)."""
    return litellm_model.rsplit("/", 1)[-1]


def _correlation_key(model_group: str, task: str) -> str:
    return hashlib.sha1(f"{model_group}:{task}".encode()).hexdigest()  # noqa: S324


class MinimaRoutingStrategy(CustomRoutingStrategyBase):
    """Pick the deployment Minima recommends; remember the rec_id for feedback."""

    def __init__(
        self,
        minima: Any,
        router: Any,
        *,
        cost_quality_tradeoff: float | None = None,
        namespace: str | None = None,
    ):
        self._minima = minima
        self._router = router
        self._slider = cost_quality_tradeoff
        self._namespace = namespace
        # (model_group, task-hash) -> (rec_id, minima_model_id, ts): the logger joins
        # its success/failure event back to the recommendation. Bounded LRU.
        self._pending: OrderedDict[str, tuple[str, str, float]] = OrderedDict()

    # -- correlation ----------------------------------------------------------
    def _remember(self, key: str, rec_id: str, model_id: str) -> None:
        self._pending[key] = (rec_id, model_id, time.time())
        self._pending.move_to_end(key)
        while len(self._pending) > _CORRELATION_CAP:
            self._pending.popitem(last=False)

    def take_recommendation(self, model_group: str, task: str) -> tuple[str, str] | None:
        entry = self._pending.pop(_correlation_key(model_group, task), None)
        return (entry[0], entry[1]) if entry else None

    # -- deployment selection --------------------------------------------------
    def _deployments(self, model_group: str) -> list[dict]:
        return self._router.get_model_list(model_name=model_group) or []

    def _pick(
        self,
        model_group: str,
        messages: list[dict[str, str]] | None,
    ) -> dict | None:
        deployments = self._deployments(model_group)
        if not deployments:
            return None
        by_bare = {
            _bare_model(str(d.get("litellm_params", {}).get("model", ""))): d
            for d in deployments
        }
        task = _task_text(messages, model_group)
        try:
            rec = self._minima.recommend(
                task,
                cost_quality_tradeoff=self._slider,
                constraints={"candidate_models": sorted(by_bare)},
                namespace=self._namespace,
            )
        except Exception:  # noqa: BLE001 — routing must fail open to LiteLLM's default
            return None
        model_id = rec.recommended_model.model_id
        deployment = by_bare.get(model_id)
        if deployment is None:
            return None
        self._remember(_correlation_key(model_group, task), rec.recommendation_id, model_id)
        return deployment

    async def async_get_available_deployment(
        self,
        model: str,
        messages: list[dict[str, str]] | None = None,
        input: list | str | None = None,  # noqa: A002 — LiteLLM's signature
        specific_deployment: bool | None = False,
        request_kwargs: dict | None = None,
    ):
        return self._pick(model, messages)

    def get_available_deployment(
        self,
        model: str,
        messages: list[dict[str, str]] | None = None,
        input: list | str | None = None,  # noqa: A002 — LiteLLM's signature
        specific_deployment: bool | None = False,
        request_kwargs: dict | None = None,
    ):
        return self._pick(model, messages)


class MinimaFeedbackLogger(CustomLogger):
    """Report realized cost/latency (and optional quality) back to Minima."""

    def __init__(
        self,
        minima: Any,
        strategy: MinimaRoutingStrategy,
        *,
        quality_fn: Callable[[Any], float | None] | None = None,
    ):
        super().__init__()
        self._minima = minima
        self._strategy = strategy
        self._quality_fn = quality_fn

    def _join(self, kwargs: dict) -> tuple[str, str] | None:
        group = str(kwargs.get("model", ""))
        task = _task_text(kwargs.get("messages"), group)
        return self._strategy.take_recommendation(group, task)

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time) -> None:
        joined = self._join(kwargs)
        if joined is None:
            return
        rec_id, model_id = joined
        usage = getattr(response_obj, "usage", None)
        quality = None
        if self._quality_fn is not None:
            try:
                quality = self._quality_fn(response_obj)
            except Exception:  # noqa: BLE001 — a broken grader must not break the call
                quality = None
        try:
            self._minima.feedback(
                rec_id,
                model_id,
                "success" if quality is None or quality >= 0.8 else "partial",
                quality_score=quality,
                # No grader => honest telemetry, not a fabricated success label.
                evidence_source="judge" if quality is not None else "none",
                input_tokens=getattr(usage, "prompt_tokens", None),
                output_tokens=getattr(usage, "completion_tokens", None),
                actual_cost_usd=kwargs.get("response_cost"),
                latency_ms=int((end_time - start_time).total_seconds() * 1000)
                if hasattr(end_time - start_time, "total_seconds")
                else None,
            )
        except Exception:  # noqa: BLE001 — feedback must never break the caller's run
            return

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time) -> None:
        joined = self._join(kwargs)
        if joined is None:
            return
        rec_id, model_id = joined
        try:
            self._minima.feedback(
                rec_id,
                model_id,
                "failure",
                evidence_source="none",
                error_cause="infra",
            )
        except Exception:  # noqa: BLE001
            return
