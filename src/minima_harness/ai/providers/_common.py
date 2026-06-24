"""Shared helpers for provider implementations."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pydantic import BaseModel


def resolve_api_key(options: dict[str, Any] | None, *env_vars: str) -> str | None:
    """Options value wins, then the first set environment variable."""
    if options and options.get("api_key"):
        return str(options["api_key"])
    for var in env_vars:
        value = os.environ.get(var)
        if value:
            return value
    return None


def to_json_schema(model_cls: type[BaseModel]) -> dict[str, Any]:
    """A provider-agnostic JSON Schema for a pydantic parameter model.

    Strips pydantic-only ``title`` noise and rewrites ``anyOf``/``const`` enum patterns
    (from ``Literal``) to plain ``enum`` lists so Google's constrained schema dialect
    accepts them.
    """
    schema = model_cls.model_json_schema()
    schema.pop("title", None)
    _clean_schema(schema)
    return schema


def _clean_schema(node: Any) -> None:
    if isinstance(node, dict):
        node.pop("title", None)
        # Literal -> pydantic emits {"anyOf":[{"const": v}, ...]}; flatten to {"enum":[...]}.
        any_of = node.get("anyOf")
        if isinstance(any_of, list) and all(isinstance(a, dict) and "const" in a for a in any_of):
            node["enum"] = [a["const"] for a in any_of]
            node.pop("anyOf", None)
        for value in node.values():
            _clean_schema(value)
    elif isinstance(node, list):
        for item in node:
            _clean_schema(item)
