"""
MuBit Learn Context Injection.

Pure functions for injecting context blocks into LLM message arrays.
Supports both OpenAI and Anthropic message formats.
"""

from typing import Any, Dict, List, Optional, Union


# Public markers wrapping injected lessons. build_items() strips this span
# before ingesting traces so injected memory is never re-ingested as new memory
# (feedback amplification). Keep the private aliases for back-compat.
MEMORY_TAG = "<memory_context>"
MEMORY_TAG_END = "</memory_context>"
_MEMORY_TAG = MEMORY_TAG
_MEMORY_TAG_END = MEMORY_TAG_END


def inject_context_openai(
    messages: List[Dict[str, Any]],
    context_block: str,
    position: str = "system",
) -> List[Dict[str, Any]]:
    """Inject a context block into an OpenAI-format message array.

    Args:
        messages: The original messages list (not mutated).
        context_block: Pre-formatted context string from get_context().
        position: "system" | "prepend" | "last_system".

    Returns:
        A new messages list with context injected.
    """
    if not context_block or not context_block.strip():
        return messages

    messages = [dict(m) for m in messages]  # shallow copy
    memory_text = f"\n\n---\n{_MEMORY_TAG}\n{context_block}\n{_MEMORY_TAG_END}"

    if position == "system":
        if messages and messages[0].get("role") == "system":
            messages[0] = dict(messages[0])
            messages[0]["content"] = messages[0]["content"] + memory_text
        else:
            messages.insert(0, {"role": "system", "content": memory_text.strip()})

    elif position == "prepend":
        messages.insert(0, {"role": "system", "content": memory_text.strip()})

    elif position == "last_system":
        inserted = False
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].get("role") == "user":
                messages.insert(i, {"role": "system", "content": memory_text.strip()})
                inserted = True
                break
        if not inserted:
            messages.insert(0, {"role": "system", "content": memory_text.strip()})

    return messages


def inject_context_anthropic(
    system: Optional[Union[str, List[Dict[str, Any]]]],
    context_block: str,
) -> Union[str, List[Dict[str, Any]]]:
    """Inject a context block into an Anthropic system parameter.

    Anthropic separates system from messages. The system param is either
    a string or a list of text blocks.

    Args:
        system: The original system parameter (may be None).
        context_block: Pre-formatted context string from get_context().

    Returns:
        The modified system parameter with context appended.
    """
    if not context_block or not context_block.strip():
        return system

    memory_text = f"\n\n---\n{_MEMORY_TAG}\n{context_block}\n{_MEMORY_TAG_END}"

    if system is None:
        return memory_text.strip()

    if isinstance(system, str):
        return system + memory_text

    if isinstance(system, list):
        # List of text blocks: append a new text block
        return system + [{"type": "text", "text": memory_text.strip()}]

    return system


def extract_query(messages: List[Dict[str, Any]], max_length: int = 200) -> str:
    """Extract a query from the last user message for context retrieval.

    Args:
        messages: OpenAI or Anthropic format messages.
        max_length: Truncation limit for the query string.

    Returns:
        The last user message content, truncated.
    """
    for msg in reversed(messages):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, str):
                return content[:max_length]
            if isinstance(content, list):
                # Multi-part content (e.g., Anthropic text blocks)
                parts = []
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        parts.append(part.get("text", ""))
                    elif isinstance(part, str):
                        parts.append(part)
                return " ".join(parts)[:max_length]
    return ""
