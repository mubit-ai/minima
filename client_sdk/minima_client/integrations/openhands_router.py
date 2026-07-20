"""OpenHands SDK adapter: Minima as a RouterLLM.

Usage::

    from openhands.sdk.llm import LLM
    from minima_client.integrations.openhands_router import MinimaRouterLLM

    router = MinimaRouterLLM(
        llms_for_routing={
            "cheap": LLM(model="anthropic/claude-haiku-4-5", ...),
            "strong": LLM(model="anthropic/claude-sonnet-4-6", ...),
        },
        minima_url="https://api.minima.sh",
        minima_api_key="<mubit-key>",
    )
    # use `router` anywhere OpenHands accepts an LLM

Every completion asks Minima which of ``llms_for_routing`` to run (fail-open to the
first entry when Minima is unreachable) and reports realized cost/tokens/latency back
as COST TELEMETRY (``evidence_source="none"``) off the selected LLM's metrics deltas.
OpenHands has no built-in grader; to make outcomes teach the success posterior, call
``router.minima_client().feedback(...)`` with a real quality signal.
"""

from __future__ import annotations

import threading
from typing import Any

from openhands.sdk.llm.router import RouterLLM
from pydantic import Field

from minima_client.client import MinimaClient


def _bare_model(litellm_model: str) -> str:
    return litellm_model.rsplit("/", 1)[-1]


class MinimaRouterLLM(RouterLLM):
    """Routes each completion to the LLM Minima recommends; reports realized cost."""

    router_name: str = Field(default="minima_router")
    minima_url: str = Field(default="https://api.minima.sh")
    minima_api_key: str | None = Field(default=None)
    cost_quality_tradeoff: float | None = Field(default=None)
    minima_namespace: str | None = Field(default=None)
    # recommend() sits on the agent's hot path — keep its budget tight; telemetry
    # runs off-thread so it never adds step latency.
    minima_timeout: float = Field(default=5.0)

    # NOTE: RouterLLM.__getattr__ delegates every unknown attribute (private ones
    # included) to the wrapped LLM, so a pydantic PrivateAttr is unreachable here.
    # State is cached straight in the instance dict, which normal attribute lookup
    # finds BEFORE __getattr__ fires.
    def minima_client(self) -> MinimaClient:
        try:
            return object.__getattribute__(self, "_minima_client_obj")
        except AttributeError:
            client = MinimaClient(
                self.minima_url, api_key=self.minima_api_key, timeout=self.minima_timeout
            )
            object.__setattr__(self, "_minima_client_obj", client)
            return client

    def set_minima_client(self, client: object) -> None:
        """Dependency-injection seam (tests, custom transports)."""
        object.__setattr__(self, "_minima_client_obj", client)

    def select_llm(self, messages: list[Any]) -> str:
        keys = list(self.llms_for_routing)
        by_bare = {
            _bare_model(str(getattr(llm, "model", key))): key
            for key, llm in self.llms_for_routing.items()
        }
        task = _last_user_text(messages)
        try:
            rec = self.minima_client().recommend(
                task or "agent step",
                cost_quality_tradeoff=self.cost_quality_tradeoff,
                constraints={"candidate_models": sorted(by_bare)},
                namespace=self.minima_namespace,
            )
        except Exception:  # noqa: BLE001 — routing must fail open, never break the agent
            object.__setattr__(self, "_minima_pending", None)
            return keys[0]
        model_id = rec.recommended_model.model_id
        key = by_bare.get(model_id)
        if key is None:
            # Minima's pick isn't in the routing set — fall back, and DON'T report
            # feedback for a model that never ran.
            object.__setattr__(self, "_minima_pending", None)
            return keys[0]
        object.__setattr__(self, "_minima_pending", (rec.recommendation_id, model_id))
        return key

    def completion(self, messages: list[Any], **kwargs: Any) -> Any:
        # super().completion() runs select_llm (which sets _minima_pending) and then
        # the selected LLM; per-key snapshots taken here let us diff the winner after.
        before = {key: _metrics_lengths(llm) for key, llm in self.llms_for_routing.items()}
        response = super().completion(messages=messages, **kwargs)
        pending = getattr(self, "_minima_pending", None)
        if pending is not None:
            object.__setattr__(self, "_minima_pending", None)
            rec_id, model_id = pending
            selected = getattr(self, "active_llm", None)
            key = next(
                (k for k, llm in self.llms_for_routing.items() if llm is selected), None
            )
            telemetry = (
                _metrics_delta(selected, before[key]) if key is not None else None
            )
            # Fire-and-forget: telemetry must never add latency to (or break) the step.
            threading.Thread(
                target=self._send_telemetry,
                args=(rec_id, model_id, telemetry),
                daemon=True,
            ).start()
        return response

    def _send_telemetry(
        self, rec_id: str, model_id: str, telemetry: dict[str, Any] | None
    ) -> None:
        try:
            self.minima_client().feedback(
                rec_id,
                model_id,
                "success",
                evidence_source="none",
                **(telemetry or {}),
            )
        except Exception:  # noqa: BLE001 — feedback must never break the caller's run
            return


def _metrics_lengths(llm: Any) -> tuple[int, int, int]:
    metrics = getattr(llm, "metrics", None)
    return (
        len(getattr(metrics, "costs", []) or []),
        len(getattr(metrics, "token_usages", []) or []),
        len(getattr(metrics, "response_latencies", []) or []),
    )


def _metrics_delta(llm: Any, baseline: tuple[int, int, int]) -> dict[str, Any] | None:
    """Realized usage of THIS call: whatever the selected LLM's metrics appended."""
    metrics = getattr(llm, "metrics", None)
    if metrics is None:
        return None
    telemetry: dict[str, Any] = {}
    costs = getattr(metrics, "costs", []) or []
    if len(costs) > baseline[0]:
        telemetry["actual_cost_usd"] = float(
            sum(getattr(c, "cost", 0.0) for c in costs[baseline[0] :])
        )
    usages = getattr(metrics, "token_usages", []) or []
    if len(usages) > baseline[1]:
        last = usages[-1]
        telemetry["input_tokens"] = getattr(last, "prompt_tokens", None)
        telemetry["output_tokens"] = getattr(last, "completion_tokens", None)
    latencies = getattr(metrics, "response_latencies", []) or []
    if len(latencies) > baseline[2]:
        telemetry["latency_ms"] = int(1000 * float(getattr(latencies[-1], "latency", 0.0)))
    return telemetry or None


def _last_user_text(messages: list[Any]) -> str:
    for message in reversed(messages or []):
        role = getattr(message, "role", None) or (
            message.get("role") if isinstance(message, dict) else None
        )
        if role != "user":
            continue
        content = getattr(message, "content", None) or (
            message.get("content") if isinstance(message, dict) else None
        )
        if isinstance(content, str) and content:
            return content
        if isinstance(content, list):
            texts = [getattr(c, "text", None) or str(c) for c in content]
            joined = " ".join(t for t in texts if t)
            if joined:
                return joined
    return ""
