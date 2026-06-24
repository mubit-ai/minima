"""Tool argument validation — the pydantic analogue of PI's TypeBox ``validateToolCall``.

Tools declare their parameters as a pydantic ``BaseModel`` subclass. The agent loop
auto-validates before execution; failures are returned to the model as tool errors so it
can retry (matching PI's behaviour).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ValidationError

from minima_harness.ai.types import Tool, ToolCall


class ToolParamError(ValueError):
    """Raised when a tool call's arguments fail schema validation."""


class UnknownToolError(KeyError):
    """Raised when a tool call targets a name absent from the tool set."""


def find_tool(tools: list[Tool], name: str) -> Tool:
    for t in tools:
        if t.name == name:
            return t
    raise UnknownToolError(name)


def validate_tool_call(tools: list[Tool], call: ToolCall) -> BaseModel:
    """Validate ``call.arguments`` against the named tool's parameter model.

    Returns the parsed model instance on success; raises :class:`ToolParamError` on
    failure so the caller can surface the error message to the model.
    """
    tool = find_tool(tools, call.name)
    return _parse(tool.parameters, call.arguments)


def _parse(model_cls: type[BaseModel], arguments: dict[str, Any]) -> BaseModel:
    try:
        return model_cls.model_validate(arguments)
    except ValidationError as exc:
        # Flatten pydantic errors into a compact, model-readable message.
        parts = []
        for err in exc.errors():
            loc = ".".join(str(x) for x in err["loc"]) or "<root>"
            parts.append(f"{loc}: {err['msg']}")
        raise ToolParamError("; ".join(parts)) from exc
