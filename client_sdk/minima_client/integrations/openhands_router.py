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
first entry when Minima is unreachable). Feedback is COST TELEMETRY by default —
OpenHands has no built-in grader; wire your own by calling
``router.minima_client().feedback(...)`` with a real quality signal.
"""

from __future__ import annotations

from typing import Any

from openhands.sdk.llm.router import RouterLLM
from pydantic import Field

from minima_client.client import MinimaClient


def _bare_model(litellm_model: str) -> str:
    return litellm_model.rsplit("/", 1)[-1]


class MinimaRouterLLM(RouterLLM):
    """Routes each completion to the LLM Minima recommends."""

    router_name: str = Field(default="minima_router")
    minima_url: str = Field(default="https://api.minima.sh")
    minima_api_key: str | None = Field(default=None)
    cost_quality_tradeoff: float | None = Field(default=None)
    minima_namespace: str | None = Field(default=None)

    # NOTE: RouterLLM.__getattr__ delegates every unknown attribute (private ones
    # included) to the wrapped LLM, so a pydantic PrivateAttr is unreachable here.
    # The client is cached straight in the instance dict, which normal attribute
    # lookup finds BEFORE __getattr__ fires.
    def minima_client(self) -> MinimaClient:
        try:
            return object.__getattribute__(self, "_minima_client_obj")
        except AttributeError:
            client = MinimaClient(self.minima_url, api_key=self.minima_api_key)
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
            return keys[0]
        return by_bare.get(rec.recommended_model.model_id, keys[0])


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
