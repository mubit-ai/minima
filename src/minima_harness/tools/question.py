"""The ``question`` tool — let the model ask the user a structured question mid-run.

When a request is ambiguous, the model would otherwise have to guess and be corrected on the
next turn — a full, billed round-trip (often on an expensive model). This tool turns that into
one cheap clarifying exchange: the model offers a few options, the user picks one (or types a
custom answer), and the choice comes back as the tool result.

Interactive-only: bound to a TUI callback via :func:`question_tool`. In headless modes the
factory is built with ``ask=None`` and the tool tells the model to proceed on its best
assumption rather than block.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from pydantic import BaseModel, Field

from minima_harness.agent.tools import AgentTool, ToolResult, ToolUpdate
from minima_harness.ai.types import TextContent

# The TUI provides this: show the question, return the chosen answer, or None if dismissed.
AskUser = Callable[["QuestionParams"], Awaitable[str | None]]


class QuestionOption(BaseModel):
    label: str = Field(description="A short answer the user can pick.")
    description: str = Field(
        default="", description="Optional one-line explanation of this option."
    )


class QuestionParams(BaseModel):
    question: str = Field(description="The question to ask the user.")
    header: str = Field(default="", description="Optional short topic label (a few words).")
    options: list[QuestionOption] = Field(
        default_factory=list, description="The choices to offer (ideally 2-4)."
    )
    allow_freetext: bool = Field(
        default=True, description="Let the user type a custom answer instead of picking an option."
    )


def question_tool(ask: AskUser | None = None) -> AgentTool:
    """Build the ``question`` tool. ``ask`` is the TUI callback that shows the prompt and returns
    the user's answer; pass ``None`` (headless) to make the tool a no-op that tells the model to
    proceed on its own."""

    async def _execute(
        tool_call_id: str,
        params,  # noqa: ANN001
        signal,  # noqa: ANN001
        on_update: ToolUpdate | None,
    ) -> ToolResult:
        assert isinstance(params, QuestionParams)
        if ask is None:
            return ToolResult(
                content=[
                    TextContent(
                        text="No interactive user is available to answer (headless mode). "
                        "Proceed with your best assumption and state the assumption you made."
                    )
                ],
                details={"answered": False, "reason": "headless"},
            )
        answer = await ask(params)
        if not answer:
            return ToolResult(
                content=[
                    TextContent(
                        text="The user dismissed the question without answering. "
                        "Proceed using your best judgment."
                    )
                ],
                details={"answered": False, "reason": "dismissed"},
            )
        return ToolResult(
            content=[TextContent(text=f"The user answered: {answer}")],
            details={"answered": True, "answer": answer},
        )

    return AgentTool(
        name="question",
        description=(
            "Ask the user a single clarifying question and wait for their answer. Use this ONLY "
            "when you are genuinely blocked by ambiguity or need a decision/confirmation you "
            "cannot resolve yourself — never for something you could determine by reading or "
            "searching the code. Offer 2-4 concrete `options` (each a short `label` with an "
            "optional `description`); the user picks one or types a custom answer. Keep `header` "
            "to a few words. Their answer is returned as the tool result; if no user is available "
            "or they dismiss it, proceed with your best judgment."
        ),
        parameters=QuestionParams,
        execute=_execute,
        execution_mode="sequential",
    )
