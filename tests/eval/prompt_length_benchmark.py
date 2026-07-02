from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from statistics import fmean, median

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from minima.schemas.common import Difficulty, TaskInput, TaskType  # noqa: E402

DEFAULT_ENDPOINT = "http://localhost:8088/v1/recommend"
DEFAULT_LENGTHS: tuple[int, ...] = (32, 64, 128, 256, 512)
DEFAULT_SAMPLES = 10
DEFAULT_WARMUP = 2
DEFAULT_COST_QUALITY_TRADEOFF = 3.0
DEFAULT_TIMEOUT_SECONDS = 60.0

_TYPE_PATTERNS: list[tuple[TaskType, str]] = [
    (
        TaskType.code,
        r"```|\bdef \b|\bclass \b|\bfunction\b|\bimport \b|\bSELECT \b|regex|stack ?trace|"
        r"compile|refactor|implement|unit test|debug",
    ),
    (
        TaskType.translation,
        r"\btranslate\b|\bin (french|spanish|german|chinese|japanese|hindi)\b|\bto "
        r"(french|spanish|german)\b",
    ),
    (TaskType.summarization, r"\bsummari[sz]e\b|\btl;?dr\b|\bsummary\b|\bcondense\b|\bin brief\b"),
    (
        TaskType.extraction,
        r"\bextract\b|\bparse\b|\bpull out\b|\blist all\b|\bfind all\b|\bjson schema\b|\bfields?\b.*\bfrom\b",
    ),
    (
        TaskType.classification,
        r"\bclassif|\bcategori[sz]e\b|\blabel\b|\bsentiment\b|\bwhich (category|class|label)\b|\btrue or false\b",
    ),
    (
        TaskType.tool_use,
        r"\bcall the\b|\buse the tool\b|\bfunction call\b|\btool[_ ]?call\b|\bapi call\b",
    ),
    (
        TaskType.rag,
        r"\bbased on the (following|context|document)\b|\baccording to the\b|\bcontext:\b|\bgiven the passage\b",
    ),
    (TaskType.creative, r"\bwrite a (story|poem|song|essay)\b|\bcreative\b|\bimagine\b|\bbrainstorm\b"),
    (
        TaskType.reasoning,
        r"\bprove\b|\bcalculate\b|\bsolve\b|\bequation\b|\bstep[- ]by[- ]step\b|\breason(ing)?\b|\bderive\b|\bwhy (does|is|are)\b",
    ),
    (TaskType.qa, r"^\s*(what|who|when|where|why|how|which|is|are|does|can)\b|\?\s*$"),
]

_COMPLEXITY_MARKERS = r"\b(and then|after that|must|ensure|constraint|optimi[sz]e|edge case|step \d|\d\.\s)\b"
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


def _prompt_for_words(target_words: int) -> str:
    base = "Summarize this incident report into 3 bullets."
    filler = (
        "The incident report describes repeated timeouts during deployment, delayed retries, "
        "partial recovery, and a follow-up rollback across the payment service."
    )
    tokens = base.split() + filler.split()
    while len(tokens) < target_words:
        tokens.extend(filler.split())
    return " ".join(tokens[:target_words])


def infer_task_type(text: str) -> TaskType:
    for task_type, pattern in _TYPE_PATTERNS:
        if re.search(pattern, text, re.I):
            return task_type
    return TaskType.other


def infer_difficulty(text: str, task_type: TaskType) -> Difficulty:
    words = len(text.split())
    if words < 40:
        base = 1
    elif words < 150:
        base = 2
    elif words < 400:
        base = 3
    else:
        base = 4

    if len(re.findall(_COMPLEXITY_MARKERS, text, re.I)) >= 2:
        base += 1

    if task_type in _HARD_TYPES:
        base += 1
    elif task_type in _EASY_TYPES:
        base -= 1

    index = max(0, min(len(_ORDER) - 1, base))
    return _ORDER[index]


def legacy_classify(task: TaskInput) -> tuple[TaskType, Difficulty]:
    task_type = task.task_type or infer_task_type(task.task)
    difficulty = task.difficulty or infer_difficulty(task.task, task_type)
    return task_type, difficulty


def _curl_recommend(
    endpoint: str,
    prompt: str,
    *,
    cost_quality_tradeoff: float = DEFAULT_COST_QUALITY_TRADEOFF,
    allow_llm_escalation: bool = False,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> float:
    payload: dict[str, object] = {
        "task": {
            "task": prompt,
            "task_type": "summarization",
        },
        "cost_quality_tradeoff": cost_quality_tradeoff,
    }
    if not allow_llm_escalation:
        payload["allow_llm_escalation"] = False

    proc = subprocess.run(
        [
            "curl",
            "-s",
            "--show-error",
            "--output",
            "/dev/null",
            "--write-out",
            "%{http_code} %{time_total}",
            "--connect-timeout",
            "5",
            "--max-time",
            str(timeout_seconds),
            "-H",
            "content-type: application/json",
            "-d",
            "@-",
            endpoint,
        ],
        input=json.dumps(payload).encode("utf-8"),
        capture_output=True,
        check=False,
        timeout=timeout_seconds + 5.0,
    )
    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"curl failed for {endpoint}: {stderr or proc.stdout.decode('utf-8', errors='replace').strip()}")

    output = proc.stdout.decode("utf-8", errors="replace").strip()
    http_code, elapsed_s = output.split(maxsplit=1)
    if http_code != "200":
        stderr = proc.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"unexpected HTTP {http_code} from {endpoint}: {stderr}")
    return float(elapsed_s) * 1000.0


def _local_samples(prompt: str, samples: int) -> list[float]:
    task = TaskInput(task=prompt, task_type=TaskType.summarization)
    values: list[float] = []
    for _ in range(samples):
        start = time.perf_counter_ns()
        legacy_classify(task)
        values.append((time.perf_counter_ns() - start) / 1_000_000.0)
    return values


def _remote_samples(
    prompt: str,
    samples: int,
    *,
    endpoint: str,
    allow_llm_escalation: bool,
    curl_runner: Callable[..., float] = _curl_recommend,
) -> list[float]:
    values: list[float] = []
    for _ in range(samples):
        values.append(
            curl_runner(
                endpoint,
                prompt,
                allow_llm_escalation=allow_llm_escalation,
            )
        )
    return values


def run_benchmark(
    *,
    endpoint: str = DEFAULT_ENDPOINT,
    lengths: Sequence[int] = DEFAULT_LENGTHS,
    samples: int = DEFAULT_SAMPLES,
    warmup: int = DEFAULT_WARMUP,
    allow_llm_escalation: bool = False,
    curl_runner: Callable[..., float] = _curl_recommend,
) -> dict[str, object]:
    rows: list[dict[str, object]] = []
    if not lengths:
        raise ValueError("lengths must not be empty")

    warmup_prompt = _prompt_for_words(max(lengths))
    for _ in range(warmup):
        legacy_classify(TaskInput(task=warmup_prompt, task_type=TaskType.summarization))
        curl_runner(
            endpoint,
            warmup_prompt,
            allow_llm_escalation=allow_llm_escalation,
        )

    for length in lengths:
        prompt = _prompt_for_words(int(length))
        local = _local_samples(prompt, samples)
        remote = _remote_samples(
            prompt,
            samples,
            endpoint=endpoint,
            allow_llm_escalation=allow_llm_escalation,
            curl_runner=curl_runner,
        )
        local_mean = fmean(local)
        remote_mean = fmean(remote)
        rows.append(
            {
                "prompt_words": int(length),
                "prompt_chars": len(prompt),
                "approach1_mean_ms": round(local_mean, 4),
                "approach1_p50_ms": round(median(local), 4),
                "repo_mean_ms": round(remote_mean, 4),
                "repo_p50_ms": round(median(remote), 4),
                "repo_vs_approach1_ratio": round(remote_mean / local_mean, 3) if local_mean else None,
            }
        )

    return {
        "endpoint": endpoint,
        "samples": samples,
        "warmup": warmup,
        "allow_llm_escalation": allow_llm_escalation,
        "rows": rows,
    }


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--lengths", nargs="+", type=int, default=list(DEFAULT_LENGTHS))
    parser.add_argument("--samples", type=int, default=DEFAULT_SAMPLES)
    parser.add_argument("--warmup", type=int, default=DEFAULT_WARMUP)
    parser.add_argument(
        "--allow-llm-escalation",
        action="store_true",
        help="Include the repo's LLM reasoner path if the endpoint is configured for it.",
    )
    return parser.parse_args(list(argv))


def main(argv: Sequence[str] | None = None) -> None:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    result = run_benchmark(
        endpoint=args.endpoint,
        lengths=args.lengths,
        samples=args.samples,
        warmup=args.warmup,
        allow_llm_escalation=args.allow_llm_escalation,
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
