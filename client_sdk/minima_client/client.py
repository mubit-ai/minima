"""Sync and async clients mirroring the Minima endpoints."""

from __future__ import annotations

from typing import Any

import httpx

from minima.schemas.common import Constraints, OutcomeLabel, TaskInput
from minima.schemas.feedback import FeedbackRequest, FeedbackResponse
from minima.schemas.models_catalog import ModelsResponse
from minima.schemas.recommend import RecommendRequest, RecommendResponse
from minima.schemas.strategies import StrategiesResponse
from minima.schemas.workflow import WorkflowRequest, WorkflowResponse
from minima_client.errors import raise_for_status

TaskLike = str | TaskInput | dict[str, Any]


def _coerce_task(task: TaskLike) -> TaskInput:
    if isinstance(task, TaskInput):
        return task
    if isinstance(task, str):
        return TaskInput(task=task)
    if isinstance(task, dict):
        return TaskInput(**task)
    raise TypeError(f"unsupported task type: {type(task)!r}")


def _headers(api_key: str | None) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


def _feedback_request(
    recommendation_id: str,
    chosen_model_id: str,
    outcome: OutcomeLabel | str,
    **kwargs: Any,
) -> FeedbackRequest:
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
        allow_llm_escalation: bool = True,
        explain: bool = True,
    ) -> RecommendResponse:
        req = RecommendRequest(
            task=_coerce_task(task),
            cost_quality_tradeoff=cost_quality_tradeoff,
            constraints=constraints or Constraints(),
            user_id=user_id,
            namespace=namespace,
            allow_llm_escalation=allow_llm_escalation,
            explain=explain,
        )
        return RecommendResponse.model_validate(self._post("/v1/recommend", req))

    def recommend_workflow(self, req: WorkflowRequest) -> WorkflowResponse:
        return WorkflowResponse.model_validate(self._post("/v1/recommend/workflow", req))

    def feedback(
        self,
        recommendation_id: str,
        chosen_model_id: str,
        outcome: OutcomeLabel | str,
        **kwargs: Any,
    ) -> FeedbackResponse:
        req = _feedback_request(recommendation_id, chosen_model_id, outcome, **kwargs)
        return FeedbackResponse.model_validate(self._post("/v1/feedback", req))

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
        allow_llm_escalation: bool = True,
        explain: bool = True,
    ) -> RecommendResponse:
        req = RecommendRequest(
            task=_coerce_task(task),
            cost_quality_tradeoff=cost_quality_tradeoff,
            constraints=constraints or Constraints(),
            user_id=user_id,
            namespace=namespace,
            allow_llm_escalation=allow_llm_escalation,
            explain=explain,
        )
        return RecommendResponse.model_validate(await self._post("/v1/recommend", req))

    async def recommend_workflow(self, req: WorkflowRequest) -> WorkflowResponse:
        return WorkflowResponse.model_validate(await self._post("/v1/recommend/workflow", req))

    async def feedback(
        self,
        recommendation_id: str,
        chosen_model_id: str,
        outcome: OutcomeLabel | str,
        **kwargs: Any,
    ) -> FeedbackResponse:
        req = _feedback_request(recommendation_id, chosen_model_id, outcome, **kwargs)
        return FeedbackResponse.model_validate(await self._post("/v1/feedback", req))

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

    async def health(self) -> dict[str, Any]:
        resp = await self._client.get("/v1/health")
        raise_for_status(resp)
        return resp.json()
