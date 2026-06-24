"""In-memory provider for hermetic tests and demos.

Minimal port of PI's ``registerFauxProvider``. Opt-in; not registered by default.
One deterministic scripted flow per registration.
Usage is estimated at roughly 1 token per 4 characters when not provided on the message.
"""

from __future__ import annotations

from collections import deque
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

from minima_harness.ai.events import (
    DoneEvent,
    ErrorEvent,
    StartEvent,
    TextDeltaEvent,
    TextEndEvent,
    TextStartEvent,
    ThinkingDeltaEvent,
    ThinkingEndEvent,
    ThinkingStartEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
)
from minima_harness.ai.providers.base import Provider, register_provider, unregister_provider
from minima_harness.ai.types import (
    AssistantMessage,
    Modality,
    Model,
    ModelCost,
    TextContent,
    ThinkingContent,
    ToolCall,
)
from minima_harness.ai.usage import attach_cost

if TYPE_CHECKING:
    from minima_harness.ai.events import Event


_FAUX_MODEL = Model(
    id="faux",
    provider="faux",
    api="faux",
    name="Faux (test)",
    cost=ModelCost(input=0.0, output=0.0),
    context_window=8192,
    max_tokens=4096,
    input=(Modality.text,),
    reasoning=False,
)

# Roughly 1 token per 4 characters, per PI's faux provider.
_CHARS_PER_TOKEN = 4


def _estimate_usage(msg: AssistantMessage) -> None:
    if msg.usage.input or msg.usage.output:
        return
    char_len = sum(
        len(b.text) if isinstance(b, TextContent) else len(getattr(b, "thinking", ""))
        for b in msg.content
        if not isinstance(b, str)
    )
    msg.usage.output = max(1, char_len // _CHARS_PER_TOKEN)


class FauxProviderState:
    """Observable per-registration state."""

    def __init__(self) -> None:
        self.call_count = 0
        self.responses: deque[AssistantMessage] = deque()

    @property
    def pending_response_count(self) -> int:
        return len(self.responses)


class FauxRegistration:
    """Handle returned by :func:`register_faux_provider`."""

    def __init__(self, *, models: list[Model] | None = None) -> None:
        self.models = models or [_FAUX_MODEL]
        self.state = FauxProviderState()
        self._provider = _FauxProvider(self.state, self.models)

    def get_model(self, model_id: str | None = None) -> Model:
        if model_id is None:
            return self.models[0]
        for m in self.models:
            if m.id == model_id:
                return m
        raise KeyError(model_id)

    def set_responses(self, messages: list[AssistantMessage]) -> None:
        self.state.responses = deque(messages)

    def append_responses(self, messages: list[AssistantMessage]) -> None:
        self.state.responses.extend(messages)

    def register(self) -> FauxRegistration:
        register_provider("faux", self._provider)
        return self

    def unregister(self) -> None:
        unregister_provider("faux")

    def __enter__(self) -> FauxRegistration:
        register_provider("faux", self._provider)
        return self

    def __exit__(self, *exc: object) -> None:
        unregister_provider("faux")


class _FauxProvider(Provider):
    def __init__(self, state: FauxProviderState, models: list[Model]) -> None:
        self.api_id = "faux"
        self.state = state
        self.models = models

    async def stream(
        self,
        model: Model,
        context: object,
        *,
        options: dict | None = None,
        signal: object | None = None,
    ) -> AsyncIterator[Event]:
        self.state.call_count += 1
        if not self.state.responses:
            err = AssistantMessage(
                content=[TextContent(text="")],
                stop_reason="error",
                error_message="No more faux responses queued",
            )
            err.model = model.id
            yield ErrorEvent(reason="error", error=err)
            return

        msg = self.state.responses.popleft()
        msg.model = model.id
        _estimate_usage(msg)
        attach_cost(model, msg.usage)

        yield StartEvent(partial=msg)
        for index, block in enumerate(msg.content):
            if isinstance(block, TextContent):
                yield TextStartEvent(content_index=index)
                if block.text:
                    yield TextDeltaEvent(delta=block.text, content_index=index)
                yield TextEndEvent(content=block.text, content_index=index)
            elif isinstance(block, ThinkingContent):
                yield ThinkingStartEvent(content_index=index)
                if block.thinking:
                    yield ThinkingDeltaEvent(delta=block.thinking, content_index=index)
                yield ThinkingEndEvent(content=block.thinking, content_index=index)
            elif isinstance(block, ToolCall):
                yield ToolCallStartEvent(content_index=index)
                yield ToolCallEndEvent(tool_call=block, content_index=index)
        yield DoneEvent(reason=msg.stop_reason, message=msg)


def register_faux_provider(*, models: list[Model] | None = None) -> FauxRegistration:
    """Register a temporary in-memory provider for tests/demos.

    Remember to call ``.unregister()`` (or use the provider as a context manager) so the
    faux api id does not leak across tests.
    """
    return FauxRegistration(models=models).register()
