"""Sync and async clients mirroring the Minima endpoints."""

from __future__ import annotations

from dataclasses import dataclass
from importlib import metadata as _importlib_metadata
from typing import Any, Literal

import httpx
from tenacity import (
    AsyncRetrying,
    Retrying,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

from minima.schemas.capabilities import CapabilitiesResponse
from minima.schemas.common import Constraints, OutcomeLabel, TaskInput
from minima.schemas.feedback import FeedbackRequest, FeedbackResponse
from minima.schemas.insight import DiagnoseRequest, DiagnoseResponse, MemoryHealthResponse
from minima.schemas.models_catalog import ModelsResponse
from minima.schemas.recommend import RecommendRequest, RecommendResponse
from minima.schemas.savings import CalibrationResponse, PolicyValueResponse, SavingsResponse
from minima.schemas.strategies import StrategiesResponse
from minima.schemas.workflow import WorkflowRequest, WorkflowResponse
from minima_client.errors import MinimaUnavailable, raise_for_status

EvidenceSource = Literal["gate", "judge", "human", "none"]
ErrorCause = Literal["infra", "quality"]


def _report_params(
    namespace: str | None, days: float | None, group_by: str | None = None
) -> dict[str, Any]:
    params: dict[str, Any] = {}
    if namespace is not None:
        params["namespace"] = namespace
    if days is not None:
        params["days"] = days
    if group_by is not None:
        params["group_by"] = group_by
    return params

TaskLike = str | TaskInput | dict[str, Any]


def _coerce_task(task: TaskLike) -> TaskInput:
    if isinstance(task, TaskInput):
        return task
    if isinstance(task, str):
        return TaskInput(task=task)
    if isinstance(task, dict):
        return TaskInput(**task)
    raise TypeError(f"unsupported task type: {type(task)!r}")


def _client_version() -> str:
    try:
        return _importlib_metadata.version("minima-cli")
    except _importlib_metadata.PackageNotFoundError:
        return "0.0.0-dev"


def _headers(api_key: str | None) -> dict[str, str]:
    version = _client_version()
    headers = {
        # Server-side compat gating (mirrors the TS client): new servers can
        # version-gate response shapes on this; old servers ignore it.
        "x-minima-client": version,
        "user-agent": f"minima-cli/{version} (python-httpx)",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


# Feedback retries: the server's reconcile replay guard makes /v1/feedback safe to
# retry, and a transiently lost label is a silent learning loss. Transport faults and
# 502/503/504 retry; 4xx (including 429) surface immediately.
_FEEDBACK_RETRY = {
    "retry": retry_if_exception(
        lambda exc: isinstance(exc, httpx.TransportError | MinimaUnavailable)
    ),
    "stop": stop_after_attempt(3),
    "wait": wait_exponential(multiplier=0.5, max=4),
    "reraise": True,
}


def _apply_phase(task: TaskInput, phase: str | None) -> TaskInput:
    """Reference-client convention: phase rides as a `phase:<value>` tag."""
    if not phase:
        return task
    tag = f"phase:{phase}"
    if tag in task.tags:
        return task
    return task.model_copy(update={"tags": [*task.tags, tag]})


@dataclass(slots=True)
class Usage:
    """Realized per-call usage — the single biggest accuracy lever of the loop.

    Report what the provider ACTUALLY billed (never echo Minima's own est_cost_usd
    back): these numbers are what let the cost basis climb estimate -> observed ->
    rescaled for your org. Fields default to None (= not measured); an explicit 0 is
    a real measurement and is reported as such.
    """

    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    latency_ms: int | None = None


def _feedback_request(
    recommendation_id: str,
    chosen_model_id: str,
    outcome: OutcomeLabel | str,
    usage: Usage | None = None,
    **kwargs: Any,
) -> FeedbackRequest:
    if usage is not None:
        if usage.input_tokens is not None:
            kwargs.setdefault("input_tokens", usage.input_tokens)
        if usage.output_tokens is not None:
            kwargs.setdefault("output_tokens", usage.output_tokens)
        if usage.cost_usd is not None:
            kwargs.setdefault("actual_cost_usd", usage.cost_usd)
        if usage.latency_ms is not None:
            kwargs.setdefault("latency_ms", usage.latency_ms)
    return FeedbackRequest(
        recommendation_id=recommendation_id,
        chosen_model_id=chosen_model_id,
        outcome=OutcomeLabel(outcome),
        **kwargs,
    )


class MinimaClient:
    def __init__(self, base_url: str, api_key: str | None = None, timeout: float = 10.0):
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"), headers=_headers(api_key), timeout=timeout
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> MinimaClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _post(self, path: str, model: Any) -> Any:
        resp = self._client.post(path, json=model.model_dump(mode="json"))
        raise_for_status(resp)
        return resp.json()

    def recommend(
        self,
        task: TaskLike,
        *,
        cost_quality_tradeoff: float = 5.0,
        constraints: Constraints | None = None,
        user_id: str | None = None,
        namespace: str | None = None,
        explain: bool = True,
        baseline_model_id: str | None = None,
        incumbent_model_id: str | None = None,
        max_candidates: int = 8,
        phase: str | None = None,
    ) -> RecommendResponse:
        req = RecommendRequest(
            task=_apply_phase(_coerce_task(task), phase),
            cost_quality_tradeoff=cost_quality_tradeoff,
            constraints=constraints or Constraints(),
            user_id=user_id,
            namespace=namespace,
            explain=explain,
            baseline_model_id=baseline_model_id,
            incumbent_model_id=incumbent_model_id,
            max_candidates=max_candidates,
        )
        return RecommendResponse.model_validate(self._post("/v1/recommend", req))

    def recommend_workflow(self, req: WorkflowRequest) -> WorkflowResponse:
        return WorkflowResponse.model_validate(self._post("/v1/recommend/workflow", req))

    def savings(
        self,
        namespace: str | None = None,
        days: float | None = None,
        group_by: str | None = None,
    ) -> SavingsResponse:
        """Counterfactual savings + routing health for your org (estimated AND realized)."""
        resp = self._client.get("/v1/savings", params=_report_params(namespace, days, group_by))
        raise_for_status(resp)
        return SavingsResponse.model_validate(resp.json())

    def calibration(
        self,
        namespace: str | None = None,
        days: float | None = None,
    ) -> CalibrationResponse:
        """Is predicted_success telling the truth? ECE, reliability, and drift flags."""
        resp = self._client.get("/v1/calibration", params=_report_params(namespace, days))
        raise_for_status(resp)
        return CalibrationResponse.model_validate(resp.json())

    def feedback(
        self,
        recommendation_id: str,
        chosen_model_id: str,
        outcome: OutcomeLabel | str,
        usage: Usage | None = None,
        *,
        quality_score: float | None = None,
        evidence_source: EvidenceSource | None = None,
        error_cause: ErrorCause | None = None,
        chosen_effort: str | None = None,
        iterations: int | None = None,
        **kwargs: Any,
    ) -> FeedbackResponse:
        for key, value in (
            ("quality_score", quality_score),
            ("evidence_source", evidence_source),
            ("error_cause", error_cause),
            ("chosen_effort", chosen_effort),
            ("iterations", iterations),
        ):
            if value is not None:
                kwargs.setdefault(key, value)
        req = _feedback_request(recommendation_id, chosen_model_id, outcome, usage, **kwargs)
        for attempt in Retrying(**_FEEDBACK_RETRY):
            with attempt:
                return FeedbackResponse.model_validate(self._post("/v1/feedback", req))
        raise AssertionError("unreachable")  # reraise=True guarantees the loop exits by raise

    def models(
        self,
        provider: str | None = None,
        task_type: str | None = None,
        max_cost: float | None = None,
        include_stale: bool = True,
    ) -> ModelsResponse:
        params = {
            k: v
            for k, v in {
                "provider": provider,
                "task_type": task_type,
                "max_cost": max_cost,
                "include_stale": include_stale,
            }.items()
            if v is not None
        }
        resp = self._client.get("/v1/models", params=params)
        raise_for_status(resp)
        return ModelsResponse.model_validate(resp.json())

    def strategies(
        self,
        namespace: str | None = None,
        max_strategies: int = 5,
        lesson_types: list[str] | None = None,
    ) -> StrategiesResponse:
        params: dict[str, Any] = {"max_strategies": max_strategies}
        if namespace is not None:
            params["namespace"] = namespace
        if lesson_types:
            params["lesson_types"] = lesson_types
        resp = self._client.get("/v1/strategies", params=params)
        raise_for_status(resp)
        return StrategiesResponse.model_validate(resp.json())

    def diagnose(
        self,
        error_text: str,
        *,
        error_type: str | None = None,
        limit: int = 5,
        namespace: str | None = None,
        user_id: str | None = None,
    ) -> DiagnoseResponse:
        """Failure lessons matching an error — 'here's how this failed before'."""
        req = DiagnoseRequest(
            error_text=error_text,
            error_type=error_type,
            limit=limit,
            namespace=namespace,
            user_id=user_id,
        )
        resp = self._client.post("/v1/diagnose", json=req.model_dump(exclude_none=True))
        raise_for_status(resp)
        return DiagnoseResponse.model_validate(resp.json())

    def memory_health(
        self, namespace: str | None = None, stale_threshold_days: int = 30
    ) -> MemoryHealthResponse:
        """Per-namespace memory hygiene: staleness, contradictions, promotion candidates."""
        params: dict[str, Any] = {"stale_threshold_days": stale_threshold_days}
        if namespace is not None:
            params["namespace"] = namespace
        resp = self._client.get("/v1/memory/health", params=params)
        raise_for_status(resp)
        return MemoryHealthResponse.model_validate(resp.json())

    def capabilities(self) -> CapabilitiesResponse:
        resp = self._client.get("/v1/capabilities")
        raise_for_status(resp)
        return CapabilitiesResponse.model_validate(resp.json())

    def policy_value(
        self,
        namespace: str | None = None,
        days: float | None = None,
    ) -> PolicyValueResponse:
        """Regret-vs-oracle: doubly-robust policy values over reconciled decisions."""
        resp = self._client.get("/v1/policy-value", params=_report_params(namespace, days))
        raise_for_status(resp)
        return PolicyValueResponse.model_validate(resp.json())

    def health(self) -> dict[str, Any]:
        resp = self._client.get("/v1/health")
        raise_for_status(resp)
        return resp.json()


class AsyncMinimaClient:
    def __init__(self, base_url: str, api_key: str | None = None, timeout: float = 10.0):
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"), headers=_headers(api_key), timeout=timeout
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> AsyncMinimaClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def _post(self, path: str, model: Any) -> Any:
        resp = await self._client.post(path, json=model.model_dump(mode="json"))
        raise_for_status(resp)
        return resp.json()

    async def recommend(
        self,
        task: TaskLike,
        *,
        cost_quality_tradeoff: float = 5.0,
        constraints: Constraints | None = None,
        user_id: str | None = None,
        namespace: str | None = None,
        explain: bool = True,
        baseline_model_id: str | None = None,
        incumbent_model_id: str | None = None,
        max_candidates: int = 8,
        phase: str | None = None,
    ) -> RecommendResponse:
        req = RecommendRequest(
            task=_apply_phase(_coerce_task(task), phase),
            cost_quality_tradeoff=cost_quality_tradeoff,
            constraints=constraints or Constraints(),
            user_id=user_id,
            namespace=namespace,
            explain=explain,
            baseline_model_id=baseline_model_id,
            incumbent_model_id=incumbent_model_id,
            max_candidates=max_candidates,
        )
        return RecommendResponse.model_validate(await self._post("/v1/recommend", req))

    async def recommend_workflow(self, req: WorkflowRequest) -> WorkflowResponse:
        return WorkflowResponse.model_validate(await self._post("/v1/recommend/workflow", req))

    async def savings(
        self,
        namespace: str | None = None,
        days: float | None = None,
        group_by: str | None = None,
    ) -> SavingsResponse:
        """Counterfactual savings + routing health for your org (estimated AND realized)."""
        resp = await self._client.get(
            "/v1/savings", params=_report_params(namespace, days, group_by)
        )
        raise_for_status(resp)
        return SavingsResponse.model_validate(resp.json())

    async def calibration(
        self,
        namespace: str | None = None,
        days: float | None = None,
    ) -> CalibrationResponse:
        """Is predicted_success telling the truth? ECE, reliability, and drift flags."""
        resp = await self._client.get("/v1/calibration", params=_report_params(namespace, days))
        raise_for_status(resp)
        return CalibrationResponse.model_validate(resp.json())

    async def feedback(
        self,
        recommendation_id: str,
        chosen_model_id: str,
        outcome: OutcomeLabel | str,
        usage: Usage | None = None,
        *,
        quality_score: float | None = None,
        evidence_source: EvidenceSource | None = None,
        error_cause: ErrorCause | None = None,
        chosen_effort: str | None = None,
        iterations: int | None = None,
        **kwargs: Any,
    ) -> FeedbackResponse:
        for key, value in (
            ("quality_score", quality_score),
            ("evidence_source", evidence_source),
            ("error_cause", error_cause),
            ("chosen_effort", chosen_effort),
            ("iterations", iterations),
        ):
            if value is not None:
                kwargs.setdefault(key, value)
        req = _feedback_request(recommendation_id, chosen_model_id, outcome, usage, **kwargs)
        async for attempt in AsyncRetrying(**_FEEDBACK_RETRY):
            with attempt:
                return FeedbackResponse.model_validate(await self._post("/v1/feedback", req))
        raise AssertionError("unreachable")  # reraise=True guarantees the loop exits by raise

    async def strategies(
        self,
        namespace: str | None = None,
        max_strategies: int = 5,
        lesson_types: list[str] | None = None,
    ) -> StrategiesResponse:
        params: dict[str, Any] = {"max_strategies": max_strategies}
        if namespace is not None:
            params["namespace"] = namespace
        if lesson_types:
            params["lesson_types"] = lesson_types
        resp = await self._client.get("/v1/strategies", params=params)
        raise_for_status(resp)
        return StrategiesResponse.model_validate(resp.json())

    async def models(
        self,
        provider: str | None = None,
        task_type: str | None = None,
        max_cost: float | None = None,
        include_stale: bool = True,
    ) -> ModelsResponse:
        params = {
            k: v
            for k, v in {
                "provider": provider,
                "task_type": task_type,
                "max_cost": max_cost,
                "include_stale": include_stale,
            }.items()
            if v is not None
        }
        resp = await self._client.get("/v1/models", params=params)
        raise_for_status(resp)
        return ModelsResponse.model_validate(resp.json())

    async def diagnose(
        self,
        error_text: str,
        *,
        error_type: str | None = None,
        limit: int = 5,
        namespace: str | None = None,
        user_id: str | None = None,
    ) -> DiagnoseResponse:
        """Failure lessons matching an error — 'here's how this failed before'."""
        req = DiagnoseRequest(
            error_text=error_text,
            error_type=error_type,
            limit=limit,
            namespace=namespace,
            user_id=user_id,
        )
        resp = await self._client.post("/v1/diagnose", json=req.model_dump(exclude_none=True))
        raise_for_status(resp)
        return DiagnoseResponse.model_validate(resp.json())

    async def memory_health(
        self, namespace: str | None = None, stale_threshold_days: int = 30
    ) -> MemoryHealthResponse:
        """Per-namespace memory hygiene: staleness, contradictions, promotion candidates."""
        params: dict[str, Any] = {"stale_threshold_days": stale_threshold_days}
        if namespace is not None:
            params["namespace"] = namespace
        resp = await self._client.get("/v1/memory/health", params=params)
        raise_for_status(resp)
        return MemoryHealthResponse.model_validate(resp.json())

    async def capabilities(self) -> CapabilitiesResponse:
        resp = await self._client.get("/v1/capabilities")
        raise_for_status(resp)
        return CapabilitiesResponse.model_validate(resp.json())

    async def policy_value(
        self,
        namespace: str | None = None,
        days: float | None = None,
    ) -> PolicyValueResponse:
        """Regret-vs-oracle: doubly-robust policy values over reconciled decisions."""
        resp = await self._client.get("/v1/policy-value", params=_report_params(namespace, days))
        raise_for_status(resp)
        return PolicyValueResponse.model_validate(resp.json())

    async def health(self) -> dict[str, Any]:
        resp = await self._client.get("/v1/health")
        raise_for_status(resp)
        return resp.json()
