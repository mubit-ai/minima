"""Heuristic task classification: type and difficulty from the prompt text.

Cheap and deterministic. Caller-supplied ``task_type``/``difficulty`` always win.
A cheap-LLM classifier is layered in a later phase when confidence is low.
"""

from __future__ import annotations

import re

from costit.schemas.common import Difficulty, TaskInput, TaskType

# Ordered most-specific-first; the first matching pattern wins.
_TYPE_PATTERNS: list[tuple[TaskType, re.Pattern[str]]] = [
    (
        TaskType.code,
        re.compile(
            r"```|\bdef \b|\bclass \b|\bfunction\b|\bimport \b|\bSELECT \b|regex|stack ?trace|compile|refactor|implement|unit test|debug",
            re.I,
        ),
    ),
    (
        TaskType.translation,
        re.compile(
            r"\btranslate\b|\bin (french|spanish|german|chinese|japanese|hindi)\b|\bto (french|spanish|german)\b",
            re.I,
        ),
    ),
    (
        TaskType.summarization,
        re.compile(r"\bsummari[sz]e\b|\btl;?dr\b|\bsummary\b|\bcondense\b|\bin brief\b", re.I),
    ),
    (
        TaskType.extraction,
        re.compile(
            r"\bextract\b|\bparse\b|\bpull out\b|\blist all\b|\bfind all\b|\bjson schema\b|\bfields?\b.*\bfrom\b",
            re.I,
        ),
    ),
    (
        TaskType.classification,
        re.compile(
            r"\bclassif|\bcategori[sz]e\b|\blabel\b|\bsentiment\b|\bwhich (category|class|label)\b|\btrue or false\b",
            re.I,
        ),
    ),
    (
        TaskType.tool_use,
        re.compile(
            r"\bcall the\b|\buse the tool\b|\bfunction call\b|\btool[_ ]?call\b|\bapi call\b", re.I
        ),
    ),
    (
        TaskType.rag,
        re.compile(
            r"\bbased on the (following|context|document)\b|\baccording to the\b|\bcontext:\b|\bgiven the passage\b",
            re.I,
        ),
    ),
    (
        TaskType.creative,
        re.compile(
            r"\bwrite a (story|poem|song|essay)\b|\bcreative\b|\bimagine\b|\bbrainstorm\b", re.I
        ),
    ),
    (
        TaskType.reasoning,
        re.compile(
            r"\bprove\b|\bcalculate\b|\bsolve\b|\bequation\b|\bstep[- ]by[- ]step\b|\breason(ing)?\b|\bderive\b|\bwhy (does|is|are)\b",
            re.I,
        ),
    ),
    (
        TaskType.qa,
        re.compile(r"^\s*(what|who|when|where|why|how|which|is|are|does|can)\b|\?\s*$", re.I),
    ),
]

_COMPLEXITY_MARKERS = re.compile(
    r"\b(and then|after that|must|ensure|constraint|optimi[sz]e|edge case|step \d|\d\.\s)\b", re.I
)

# Task types that tend to need more capability for the same text length.
_HARD_TYPES = {TaskType.code, TaskType.reasoning}
_EASY_TYPES = {
    TaskType.classification,
    TaskType.extraction,
    TaskType.summarization,
    TaskType.translation,
}

_ORDER = [
    Difficulty.trivial,
    Difficulty.easy,
    Difficulty.medium,
    Difficulty.hard,
    Difficulty.expert,
]


def infer_task_type(text: str) -> TaskType:
    for task_type, pattern in _TYPE_PATTERNS:
        if pattern.search(text):
            return task_type
    return TaskType.other


def infer_difficulty(text: str, task_type: TaskType) -> Difficulty:
    words = len(text.split())
    if words < 40:
        base = 1  # easy
    elif words < 150:
        base = 2  # medium
    elif words < 400:
        base = 3  # hard
    else:
        base = 4  # expert

    if len(_COMPLEXITY_MARKERS.findall(text)) >= 2:
        base += 1  # multiple multi-step / constraint markers

    if task_type in _HARD_TYPES:
        base += 1
    elif task_type in _EASY_TYPES:
        base -= 1

    index = max(0, min(len(_ORDER) - 1, base))
    return _ORDER[index]


def classify(task: TaskInput) -> tuple[TaskType, Difficulty]:
    task_type = task.task_type or infer_task_type(task.task)
    difficulty = task.difficulty or infer_difficulty(task.task, task_type)
    return task_type, difficulty
