from __future__ import annotations

from minima_harness.ai import Context, Message, complete
from minima_harness.ai.types import Model
from minima_harness.tui.context import SUMMARY_SYSTEM, SUMMARY_USER


async def summarize(messages: list[Message], model: Model, *, instructions: str = "") -> str:
    """Summarize ``messages`` into a compact context note via ``complete``."""
    convo = list(messages)
    convo.append(Message(role="user", content=instructions.strip() or SUMMARY_USER))
    resp = await complete(
        model,
        Context(system_prompt=SUMMARY_SYSTEM, messages=convo),
        options={"timeout": 60.0},
    )
    return resp.text.strip()
