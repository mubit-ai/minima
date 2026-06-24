"""A safe arithmetic calculator tool — an example of extending the harness toolset.

Unlike ``bash``, this evaluates only numeric arithmetic via ``ast`` (no names, calls, or
attribute access), so it is hermetic and deterministic — handy for demos/tests of multi-turn
tool flows. Register it alongside the default tools or use standalone.
"""

from __future__ import annotations

import ast
import operator as _op
from collections.abc import Callable

from pydantic import BaseModel

from minima_harness.agent.tools import AgentTool, ToolResult, error_result
from minima_harness.ai.types import TextContent

_BIN_OPS: dict[type[ast.operator], Callable[[float, float], float]] = {
    ast.Add: _op.add,
    ast.Sub: _op.sub,
    ast.Mult: _op.mul,
    ast.Div: _op.truediv,
    ast.FloorDiv: _op.floordiv,
    ast.Mod: _op.mod,
    ast.Pow: _op.pow,
}
_UNARY_OPS: dict[type[ast.unaryop], Callable[[float], float]] = {
    ast.UAdd: _op.pos,
    ast.USub: _op.neg,
}


class CalcParams(BaseModel):
    expression: str


def _eval(node: ast.AST) -> float:
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            raise ValueError("only numeric constants allowed")
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN_OPS:
        return _BIN_OPS[type(node.op)](_eval(node.left), _eval(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPS:
        return _UNARY_OPS[type(node.op)](_eval(node.operand))
    raise ValueError(f"unsupported expression element: {type(node).__name__}")


async def _execute(tool_call_id, params, signal, on_update) -> ToolResult:  # noqa: ANN001
    assert isinstance(params, CalcParams)
    try:
        tree = ast.parse(params.expression, mode="eval")
        result = _eval(tree)
    except (ValueError, SyntaxError, ZeroDivisionError, OverflowError) as exc:
        return error_result(f"calc: could not evaluate {params.expression!r}: {exc}")
    return ToolResult(
        content=[TextContent(text=f"{params.expression} = {result}")],
        details={"result": result, "expression": params.expression},
    )


def calc_tool() -> AgentTool:
    return AgentTool(
        name="calc",
        description=(
            "Evaluate a numeric math expression (supports + - * / // % ** and parentheses). "
            "Returns the exact numeric result."
        ),
        parameters=CalcParams,
        execute=_execute,
    )
