from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from minima.recommender.classify import classify as repo_classify  # noqa: E402
from minima.schemas.common import Difficulty, TaskInput, TaskType  # noqa: E402

_TYPE_PATTERNS: list[tuple[TaskType, re.Pattern[str]]] = [
    (
        TaskType.code,
        re.compile(
            (
                r"```|\bdef \b|\bclass \b|\bfunction\b|\bimport \b|\bSELECT \b|regex|stack ?trace|"
                r"compile|refactor|implement|unit test|debug"
            ),
            re.I,
        ),
    ),
    (
        TaskType.translation,
        re.compile(
            (
                r"\btranslate\b|\bin (french|spanish|german|chinese|japanese|hindi)\b|"
                r"\bto (french|spanish|german)\b"
            ),
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
            (
                r"\bextract\b|\bparse\b|\bpull out\b|\blist all\b|\bfind all\b|\bjson schema\b|"
                r"\bfields?\b.*\bfrom\b"
            ),
            re.I,
        ),
    ),
    (
        TaskType.classification,
        re.compile(
            (
                r"\bclassif|\bcategori[sz]e\b|\blabel\b|\bsentiment\b|"
                r"\bwhich (category|class|label)\b|\btrue or false\b"
            ),
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
            (
                r"\bbased on the (following|context|document)\b|\baccording to the\b|"
                r"\bcontext:\b|\bgiven the passage\b"
            ),
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
            (
                r"\bprove\b|\bcalculate\b|\bsolve\b|\bequation\b|\bstep[- ]by[- ]step\b|"
                r"\breason(ing)?\b|\bderive\b|\bwhy (does|is|are)\b"
            ),
            re.I,
        ),
    ),
    (
        TaskType.qa,
        re.compile(r"^\s*(what|who|when|where|why|how|which|is|are|does|can)\b|\?\s*$", re.I),
    ),
]

_COMPLEXITY_MARKERS = re.compile(
    r"\b(and then|after that|must|ensure|constraint|optimi[sz]e|edge case|step \d|\d\.\s)\b",
    re.I,
)
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

_PROMPTS = [
    "Please summarize this article in two bullets.",
    "Translate this to French: I need the invoice by Friday.",
    "def foo(): refactor this function to reduce duplication",
    "Classify the sentiment of this review as positive or negative.",
    "What is the capital of France?",
    "Call the weather API and return the temperature.",
    "Based on the following passage, answer the question with citations.",
    "Write a short poem about winter rain.",
    "Prove that the sum of two even numbers is even.",
    "Extract all email addresses from the text and return JSON.",
    "Arrange the colored blocks by their texture and weight.",
    "Given this equation, solve for x step by step and explain the result.",
]


def legacy_infer_task_type(text: str) -> TaskType:
    for task_type, pattern in _TYPE_PATTERNS:
        if pattern.search(text):
            return task_type
    return TaskType.other


def legacy_infer_difficulty(text: str, task_type: TaskType) -> Difficulty:
    words = len(text.split())
    if words < 40:
        base = 1
    elif words < 150:
        base = 2
    elif words < 400:
        base = 3
    else:
        base = 4

    if len(_COMPLEXITY_MARKERS.findall(text)) >= 2:
        base += 1

    if task_type in _HARD_TYPES:
        base += 1
    elif task_type in _EASY_TYPES:
        base -= 1

    index = max(0, min(len(_ORDER) - 1, base))
    return _ORDER[index]


def legacy_classify(task: TaskInput) -> tuple[TaskType, Difficulty]:
    task_type = task.task_type or legacy_infer_task_type(task.task)
    difficulty = task.difficulty or legacy_infer_difficulty(task.task, task_type)
    return task_type, difficulty


def _cases() -> list[TaskInput]:
    return [TaskInput(task=prompt) for prompt in _PROMPTS]


def _bench(fn, cases: list[TaskInput], loops: int) -> float:
    start = time.perf_counter_ns()
    for _ in range(loops):
        for case in cases:
            fn(case)
    elapsed = time.perf_counter_ns() - start
    return elapsed / (loops * len(cases))


def compare_results(cases: list[TaskInput]) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for case in cases:
        legacy = legacy_classify(case)
        repo = repo_classify(case)
        rows.append(
            {
                "task": case.task,
                "legacy_task_type": legacy[0].value,
                "legacy_difficulty": legacy[1].value,
                "repo_task_type": repo[0].value,
                "repo_difficulty": repo[1].value,
                "match": legacy == repo,
            }
        )
    return rows


def run_benchmark(*, loops: int = 20_000) -> dict[str, object]:
    cases = _cases()
    warmup = min(1_000, loops)
    for _ in range(warmup):
        for case in cases:
            legacy_classify(case)
            repo_classify(case)

    legacy_samples = [_bench(legacy_classify, cases, loops) for _ in range(5)]
    repo_samples = [_bench(repo_classify, cases, loops) for _ in range(5)]
    comparisons = compare_results(cases)
    return {
        "loops": loops,
        "cases": len(cases),
        "legacy_ns_per_call_median": round(median(legacy_samples), 1),
        "repo_ns_per_call_median": round(median(repo_samples), 1),
        "speedup_legacy_vs_repo": round(median(repo_samples) / median(legacy_samples), 3),
        "match_rate": round(sum(1 for row in comparisons if row["match"]) / len(comparisons), 3),
        "diffs": [row for row in comparisons if not row["match"]],
    }


def main() -> None:
    loops = int(sys.argv[1]) if len(sys.argv) > 1 else 20_000
    print(json.dumps(run_benchmark(loops=loops), indent=2))


def test_compare_results_smoke() -> None:
    rows = compare_results(_cases())
    assert len(rows) == len(_PROMPTS)
    assert any(row["legacy_task_type"] == "reasoning" for row in rows)


def test_benchmark_shape_smoke() -> None:
    result = run_benchmark(loops=100)
    assert result["cases"] == len(_PROMPTS)
    assert result["legacy_ns_per_call_median"] > 0
    assert result["repo_ns_per_call_median"] > 0
    assert result["speedup_legacy_vs_repo"] > 0


if __name__ == "__main__":
    main()
