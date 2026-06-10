"""
MuBit Auto-Capture Item Builder.

Helper utilities to transform LLM interactions into MuBit IngestItems
with intelligent intent classification.
"""

import json
import uuid
from typing import Any, Dict, List, Union


def _strip_memory_context(text: str) -> str:
    """Remove any injected ``<memory_context>…</memory_context>`` span from a
    message before it is ingested.

    The learn layer injects recalled lessons into the prompt; the auto layer
    captures the *same* messages afterwards. Without this strip, injected
    lessons get re-ingested as fresh traces on every call — a feedback-
    amplification loop. We remove only the tagged span (and its separators),
    preserving any genuine surrounding prompt text.
    """
    from mubit.learn._injection import MEMORY_TAG, MEMORY_TAG_END

    if not text or MEMORY_TAG not in text:
        return text
    while MEMORY_TAG in text:
        start = text.find(MEMORY_TAG)
        end = text.find(MEMORY_TAG_END, start)
        if end == -1:
            text = text[:start]
            break
        text = text[:start] + text[end + len(MEMORY_TAG_END):]
    # Tidy the separators/instructions the injectors add around the block.
    for sep in ("\n\n---\n\n", "\n\n---\n", "\n---\n"):
        text = text.replace(sep, "\n")
    text = text.replace(
        "Use the above memory context to inform your response.", ""
    )
    return text.strip()


def build_items(
    messages: List[Dict[str, Any]],
    assistant_text: str,
    model: str,
    latency_ms: float,
    capture: str,  # "all" | "output_only" | "input_only"
    min_length: int,
    user_id: str,
) -> List[Dict[str, Any]]:
    """Build a list of MuBit IngestItems from an LLM interaction."""
    items = []
    trace_id = uuid.uuid4().hex[:16]

    # Process inputs (messages)
    if capture in ("all", "input_only"):
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            
            # Handle list content (multimodal/structured)
            if isinstance(content, list):
                parts = [
                    p.get("text", "") for p in content if isinstance(p, dict)
                ]
                content = " ".join(filter(None, parts))
            elif not isinstance(content, str):
                content = str(content)

            # Drop injected lesson context so it isn't re-ingested as new memory.
            content = _strip_memory_context(content)

            if not content or len(content) < min_length:
                continue

            items.append(
                {
                    "item_id": f"auto-{uuid.uuid4().hex[:12]}",
                    "content_type": "text",
                    "text": content,
                    "intent": _classify_input(role, content),
                    "metadata_json": json.dumps(
                        {
                            "role": role,
                            "model": model,
                            "source": "mubit.auto",
                            "direction": "input",
                            "trace_id": trace_id,
                        }
                    ),
                    "user_id": user_id,
                }
            )

    # Process output (assistant response)
    if capture in ("all", "output_only") and assistant_text:
        if len(assistant_text) >= min_length:
            items.append(
                {
                    "item_id": f"auto-{uuid.uuid4().hex[:12]}",
                    "content_type": "text",
                    "text": assistant_text,
                    "intent": _classify_output(assistant_text),
                    "metadata_json": json.dumps(
                        {
                            "role": "assistant",
                            "model": model,
                            "source": "mubit.auto",
                            "direction": "output",
                            "trace_id": trace_id,
                            "latency_ms": round(latency_ms, 1),
                        }
                    ),
                    "user_id": user_id,
                }
            )

    return items


def _classify_input(role: str, text: str) -> str:
    """Classify input intent based on role and content."""
    if role in ("user", "system"):
        return "context"
    if role == "tool":
        return "tool_output"
    return "trace"


def _classify_output(text: str) -> str:
    """Classify output intent based on content heuristics."""
    lower = text.lower()
    # Heuristic lesson detection
    lesson_keywords = [
        "always ",
        "never ",
        "rule:",
        "lesson:",
        "important:",
        "remember to",
        "i learned that",
    ]
    if any(kw in lower for kw in lesson_keywords):
        return "lesson"
    return "trace"
