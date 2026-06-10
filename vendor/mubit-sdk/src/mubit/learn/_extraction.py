"""
MuBit Learn Auto-Extraction.

Heuristic extraction of structured memory items from LLM interactions.
Identifies facts, preferences, rules, and lessons without requiring
an LLM call — zero-latency classification from conversation patterns.
"""

import re
import uuid
from typing import Any, Dict, List, Optional


# Patterns that indicate a rule or constraint
_RULE_PATTERNS = [
    re.compile(r"\b(always|never|must|should not|must not|do not|don't)\b", re.IGNORECASE),
    re.compile(r"\b(required|forbidden|mandatory|prohibited)\b", re.IGNORECASE),
    re.compile(r"\brule:\s", re.IGNORECASE),
]

# Patterns that indicate a lesson (learned from experience)
_LESSON_PATTERNS = [
    re.compile(r"\b(learned|discovered|found that|realized|turns out)\b", re.IGNORECASE),
    re.compile(r"\b(the fix was|the solution was|what worked was)\b", re.IGNORECASE),
    re.compile(r"\b(caused by|root cause|the issue was)\b", re.IGNORECASE),
    re.compile(r"\blesson:\s", re.IGNORECASE),
    re.compile(r"\b(important|remember to|note that)\b", re.IGNORECASE),
]

# Patterns that indicate a preference
_PREFERENCE_PATTERNS = [
    re.compile(r"\b(prefer|prefers|wants|likes|favors)\b", re.IGNORECASE),
    re.compile(r"\b(style preference|coding style|formatting)\b", re.IGNORECASE),
]

# Patterns that indicate a factual assertion
_FACT_PATTERNS = [
    re.compile(r"\b(the .+ is|the .+ are|there are \d+|the limit is|the rate is)\b", re.IGNORECASE),
    re.compile(r"\b(version \d|api endpoint|configuration|timeout|port \d)\b", re.IGNORECASE),
]

# Patterns that indicate an observation / high-level summary
# (candidate for consolidation into mental models)
_OBSERVATION_PATTERNS = [
    re.compile(r"\b(overall|in summary|to summarize|in conclusion|to sum up)\b", re.IGNORECASE),
    re.compile(r"\b(generally|typically|usually|most of the time|as a whole)\b", re.IGNORECASE),
    re.compile(r"\b(this person|this entity|this user|they are|he is|she is)\b", re.IGNORECASE),
    re.compile(r"\b(key takeaway|main point|the gist|essentially)\b", re.IGNORECASE),
]

# Minimum sentence length to consider for extraction
_MIN_SENTENCE_LENGTH = 20


def extract_structured_items(
    messages: List[Dict[str, Any]],
    assistant_text: str,
    model: str = "unknown",
    latency_ms: float = 0.0,
    user_id: str = "",
) -> List[Dict[str, Any]]:
    """Analyze an LLM interaction and extract structured memory items.

    Beyond raw trace ingestion, identifies:
    - Rules: constraints and requirements ("always", "never", "must")
    - Lessons: learned experiences ("discovered", "the fix was", "caused by")
    - Preferences: behavioral patterns ("prefers", "wants")
    - Facts: declarative knowledge ("the API rate limit is", "version 2.1")

    Uses heuristic extraction (no LLM call) for zero-latency.

    Args:
        messages: The conversation messages (for context).
        assistant_text: The assistant's response text.
        model: The LLM model name.
        latency_ms: Response latency.
        user_id: Optional user ID for scoping.

    Returns:
        List of ingest items with structured intent tags.
        Empty list if no structured items are extracted.
    """
    if not assistant_text or len(assistant_text) < _MIN_SENTENCE_LENGTH:
        return []

    items: List[Dict[str, Any]] = []
    sentences = _split_sentences(assistant_text)

    for sentence in sentences:
        if len(sentence) < _MIN_SENTENCE_LENGTH:
            continue

        item = _classify_sentence(sentence, user_id)
        if item:
            items.append(item)

    return items


def _split_sentences(text: str) -> List[str]:
    """Split text into sentences, handling common patterns."""
    # Split on sentence boundaries, bullet points, and numbered lists
    parts = re.split(r'(?<=[.!?])\s+|(?<=\n)[-*•]\s+|(?<=\n)\d+[.)]\s+', text)
    return [p.strip() for p in parts if p.strip()]


def _classify_sentence(sentence: str, user_id: str = "") -> Optional[Dict[str, Any]]:
    """Classify a single sentence and return an ingest item if it matches a pattern."""

    # Check for rules (highest priority)
    for pattern in _RULE_PATTERNS:
        if pattern.search(sentence):
            return _build_item(
                text=sentence,
                intent="rule",
                metadata={
                    "auto_extracted": True,
                    "extraction_method": "heuristic",
                    "pattern": "rule",
                },
                user_id=user_id,
            )

    # Check for lessons
    for pattern in _LESSON_PATTERNS:
        if pattern.search(sentence):
            # Determine lesson type from context
            lesson_type = "observation"
            if any(
                kw in sentence.lower()
                for kw in ("fix", "solution", "worked", "resolved")
            ):
                lesson_type = "success"
            elif any(
                kw in sentence.lower()
                for kw in ("caused by", "issue", "bug", "error", "fail")
            ):
                lesson_type = "failure"

            return _build_item(
                text=sentence,
                intent="lesson",
                metadata={
                    "auto_extracted": True,
                    "extraction_method": "heuristic",
                    "pattern": "lesson",
                    "lesson_type": lesson_type,
                    "lesson_scope": "session",
                    "lesson_importance": "medium",
                },
                user_id=user_id,
            )

    # Check for preferences
    for pattern in _PREFERENCE_PATTERNS:
        if pattern.search(sentence):
            return _build_item(
                text=sentence,
                intent="fact",
                metadata={
                    "auto_extracted": True,
                    "extraction_method": "heuristic",
                    "pattern": "preference",
                    "source": "preference",
                },
                user_id=user_id,
            )

    # Check for observations / summaries (feed consolidation pipeline)
    for pattern in _OBSERVATION_PATTERNS:
        if pattern.search(sentence):
            return _build_item(
                text=sentence,
                intent="observation",
                metadata={
                    "auto_extracted": True,
                    "extraction_method": "heuristic",
                    "pattern": "observation",
                    "consolidation_candidate": True,
                },
                user_id=user_id,
            )

    # Check for factual assertions (lowest priority — many false positives)
    for pattern in _FACT_PATTERNS:
        if pattern.search(sentence):
            return _build_item(
                text=sentence,
                intent="fact",
                metadata={
                    "auto_extracted": True,
                    "extraction_method": "heuristic",
                    "pattern": "factual_assertion",
                },
                user_id=user_id,
            )

    return None


def _build_item(
    text: str,
    intent: str,
    metadata: Dict[str, Any],
    user_id: str = "",
) -> Dict[str, Any]:
    """Build an ingest item dict matching the IngestWorker format."""
    item = {
        "item_id": f"extract-{uuid.uuid4().hex[:12]}",
        "content_type": "text",
        "text": text,
        "intent": intent,
        "metadata_json": "",  # Will be set by caller if needed
        "user_id": user_id,
    }

    # Encode metadata into the item for the ingest worker
    import json
    item["metadata_json"] = json.dumps(metadata)

    return item
