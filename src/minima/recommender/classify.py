"""Heuristic task classification: type and difficulty from the prompt text.

Cheap and deterministic. Caller-supplied ``task_type``/``difficulty`` always win.
A cheap-LLM classifier is layered in a later phase when confidence is low.
"""

from __future__ import annotations

import re

from minima.schemas.common import Difficulty, TaskInput, TaskType

# Ordered most-specific-first; the ORDER is the tie-break — classification itself is by
# STRONGEST signal (most pattern hits), not first match. First-match-wins misrouted real
# coding-agent prompts: "find the bug, fix it, run the tests... then summarize the fix"
# has one incidental "summarize" but four coding cues, and used to classify as
# summarization/trivial (observed live), pricing the task like a one-liner.
_TYPE_PATTERNS: list[tuple[TaskType, re.Pattern[str]]] = [
    (
        TaskType.code,
        re.compile(
            r"```|\bdef \b|\bclass \b|\bfunction\b|\bimport \b|\bSELECT \b|regex|stack ?trace"
            r"|\btraceback\b|compile|refactor|implement|debug"
            # coding-agent vocabulary: bugs, tests, builds, repos, tooling
            r"|\bbugs?\b|\bfix(es|ed|ing)? (the |a |this |it\b)|\bfix it\b"
            r"|\b(failing|unit|integration|broken) tests?\b|\btests? (pass|fail|suite)\b"
            r"|\brun the tests\b|\bpytest\b|\bnpm (test|run)\b|\blint(er)?\b|\btype-?check"
            r"|\bcodebase\b|\brepo(sitory)?\b|\bgit (commit|branch|diff|rebase)\b"
            r"|\bcompil(er|ation) error\b|\bexit code\b"
            # file-path/extension mentions are strong code signals
            r"|\b[\w/.-]+\.(py|ts|tsx|js|jsx|go|rs|java|rb|cpp|cs|sh|sql|yaml|yml|toml|json)\b",
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
            r"\bprove\b|\bcalculate\b|\bsolve\b|\bequation\b|\bstep[- ]by[- ]step\b|\breason(ing)?\b|\bderive\b|\bwhy (does|is|are)\b"
            # design/architecture prompts are reasoning-heavy even without math verbs
            r"|\bdesign an?\b|\barchitect(ure)?\b|\btrade-?offs?\b|\balgorithm\b|\bdata structures?\b"
            r"|\block-free\b|\bconcurren(t|cy)\b|\bdistributed\b|\bconsensus\b"
            r"|\brace condition\b|\bdeadlock\b|\bmemory[- ]ordering\b|\binvariants?\b",
            re.I,
        ),
    ),
    (
        TaskType.qa,
        re.compile(r"^\s*(what|who|when|where|why|how|which|is|are|does|can)\b|\?\s*$", re.I),
    ),
]

_COMPLEXITY_MARKERS = re.compile(
    r"\b(and then|after that|must|ensure|constraint|optimi[sz]e|edge case|step \d|\d\.\s"
    # systems-hardness cues: concurrency/distribution/compat push real difficulty up
    r"|lock-free|concurren(t|cy)|thread-?safe|race condition|deadlock|distributed"
    r"|memory[- ]ordering|multi-tenant|SLAs?|backwards?[- ]compatib|migration|atomic)\b",
    re.I,
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
    """Strongest signal wins; pattern-list order only breaks ties.

    A single incidental verb ("...then summarize the fix") must not outvote several
    domain cues (bug/tests/pytest) — that misclassification prices a multi-turn coding
    task like a one-line summary and was observed routing live traffic wrong.
    """
    best: TaskType | None = None
    best_score = 0
    for task_type, pattern in _TYPE_PATTERNS:
        hits = len(pattern.findall(text))
        # Question FORM is one weak signal, not two: "How do you say X in Spanish?" hits
        # the qa pattern twice (leading interrogative + trailing "?") and would outvote
        # the actual domain cue. Cap it so a single domain hit ties, and the tie-break
        # (specificity order) sends it to the domain type.
        if task_type is TaskType.qa:
            hits = min(hits, 1)
        # Strictly-greater keeps the earlier (more specific) pattern on ties, since we
        # iterate in specificity order.
        if hits > best_score:
            best = task_type
            best_score = hits
    return best or TaskType.other


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


def classify_from_neighbors(
    votes: list[tuple[str, float]], *, min_neighbors: int = 2, min_share: float = 0.5
) -> TaskType | None:
    """Disambiguate an `other` classification from ANN-recalled semantic neighbors.

    ``votes`` is ``(neighbor_task_type, similarity)`` over recalled outcomes. Returns the
    similarity-weighted plurality type when it is non-`other`, has >= ``min_neighbors``
    supporters, and holds >= ``min_share`` of the weighted vote; else None. This is the free,
    semantic alternative to a paid LLM-classify call for prompts the regex can't place.
    """
    weighted: dict[str, float] = {}
    counts: dict[str, int] = {}
    total = 0.0
    for tt, weight in votes:
        if not tt or tt == TaskType.other.value:
            continue
        w = max(0.0, weight)
        weighted[tt] = weighted.get(tt, 0.0) + w
        counts[tt] = counts.get(tt, 0) + 1
        total += w
    if total <= 0.0:
        return None
    best = max(weighted, key=weighted.__getitem__)
    if counts[best] < min_neighbors or (weighted[best] / total) < min_share:
        return None
    try:
        return TaskType(best)
    except ValueError:
        return None
