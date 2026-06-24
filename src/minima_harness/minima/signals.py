"""Code-quality signal extraction for code-aware routing (Phase B, the wedge).

Minima's recall is otherwise text-similarity-based. Extracting lightweight, code-quality
signals from the files a task touches and feeding them as ``tags`` / ``difficulty`` /
``expected_input_tokens`` into ``recommend`` makes routing *code-aware* — the Triage-style
wedge (route by CodeHealth + file metadata, not just prompt text).

The default :class:`CodeHealthExtractor` is language-agnostic and dependency-free: a proxy
McCabe (decision-keyword count), non-blank LOC, and sibling-test-file detection. It's a
deliberately rough signal — precise, per-language complexity (radon/tree-sitter) can plug
into the same :class:`ContextExtractor` protocol later. The discrimination gate
(``tests/harness/test_signals.py``) is the falsifiable check that this signal separates
task tiers at all; if it can't, code-aware routing isn't ready and we pivot to memory/cost.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, runtime_checkable

_log = logging.getLogger("minima_harness.signals")

# Decision keywords across common languages (each ~ one McCabe branch). `and`/`or` cover
# Python/Ruby/JS boolean ops; `&&`/`||` cover C-family. Word-boundary matches keep false
# hits low (an identifier named "format" won't match "for").
_DECISION_RE = re.compile(r"\b(if|elif|for|while|case|catch|except|switch|and|or|not)\b|&&|\|\|")

# Files that look like tests (name conventions across languages).
_TEST_NAME_RE = re.compile(
    r"(^|[/_])(test_|_test\.|[a-z0-9_]+_test\.)|(tests?/)|(_spec\.|spec/)", re.IGNORECASE
)

# Approx tokens per non-blank source line (code is denser than prose).
_TOKENS_PER_LOC = 10


@dataclass(slots=True)
class FileHealth:
    path: str
    loc: int
    complexity: int


@dataclass(slots=True)
class SignalBundle:
    """The enrichment handed to ``router.recommend``."""

    tags: list[str] = field(default_factory=list)
    difficulty: str | None = None
    expected_input_tokens: int | None = None
    # Raw signals (inspection / logging / the discrimination gate):
    files: int = 0
    total_loc: int = 0
    max_file_loc: int = 0
    total_complexity: int = 0
    max_complexity: int = 0
    avg_complexity: float = 0.0
    has_tests: bool = False


@runtime_checkable
class ContextExtractor(Protocol):
    async def extract(self, task: str, files: list[Path]) -> SignalBundle:
        """Compute code-quality signals for ``files`` to enrich a recommendation."""
        ...


# extract() may be sync or async; normalize so callers can ``await`` either.
ExtractFn = Callable[[str, list[Path]], Awaitable[SignalBundle] | SignalBundle]


def _band(value: float, lo: float, hi: float) -> str:
    if value <= lo:
        return "low"
    if value <= hi:
        return "med"
    return "high"


class CodeHealthExtractor:
    """Language-agnostic heuristic extractor (proxy McCabe + LOC + sibling tests)."""

    def __init__(self, *, tokens_per_loc: int = _TOKENS_PER_LOC) -> None:
        self._tokens_per_loc = tokens_per_loc

    async def extract(self, task: str, files: list[Path]) -> SignalBundle:
        per_file: list[FileHealth] = []
        test_files: set[Path] = set()
        all_paths = {f.resolve() for f in files}
        for f in files:
            try:
                text = Path(f).read_text(encoding="utf-8", errors="replace")
            except OSError as exc:
                _log.debug("signal_skip_unreadable path=%s err=%s", f, exc)
                continue
            name = Path(f).name
            is_test = bool(_TEST_NAME_RE.search(name)) or name.startswith("test")
            fh = FileHealth(path=str(f), loc=_loc(text), complexity=_decisions(text))
            if is_test:
                test_files.add(Path(f).resolve())
            per_file.append(fh)

        source = [h for h in per_file if Path(h.path).resolve() not in test_files]
        if not source:
            source = per_file  # a pure test-edit task still gets signals

        bundle = SignalBundle(
            files=len(per_file),
            total_loc=sum(h.loc for h in source),
            max_file_loc=max((h.loc for h in source), default=0),
            total_complexity=sum(h.complexity for h in source),
            max_complexity=max((h.complexity for h in source), default=0),
            has_tests=_has_tests(source, all_paths),
        )
        n = len(source) or 1
        bundle.avg_complexity = bundle.total_complexity / n
        bundle.difficulty = _difficulty(bundle)
        bundle.expected_input_tokens = bundle.total_loc * self._tokens_per_loc
        bundle.tags = _tags(bundle)
        return bundle


def _loc(text: str) -> int:
    return sum(1 for line in text.splitlines() if line.strip())


def _decisions(text: str) -> int:
    return len(_DECISION_RE.findall(text))


def _has_tests(source: list[FileHealth], all_paths: set[Path]) -> bool:
    # A source file "has tests" if a test file is in the provided set, or a sibling test
    # file exists on disk (test_<stem>.py / <stem>_test.py|go conventions).
    if any(p for p in all_paths if _TEST_NAME_RE.search(p.name) or p.name.startswith("test")):
        return True
    for h in source:
        stem = Path(h.path).stem
        parent = Path(h.path).parent
        for candidate in (
            parent / f"test_{stem}.py",
            parent / f"{stem}_test.py",
            parent / f"{stem}_test.go",
            parent / f"test_{stem}.go",
        ):
            if candidate.resolve() in all_paths or candidate.exists():
                return True
    return False


def _difficulty(b: SignalBundle) -> str:
    if b.max_file_loc > 800 or b.avg_complexity > 30:
        return "expert"
    if (
        b.max_complexity >= 15
        or b.max_file_loc > 400
        or (not b.has_tests and b.avg_complexity > 10)
    ):
        return "hard"
    if b.avg_complexity >= 5 or b.max_file_loc > 150:
        return "medium"
    if b.total_loc > 20:
        return "easy"
    return "trivial"


def _tags(b: SignalBundle) -> list[str]:
    return [
        f"complexity:{_band(b.avg_complexity, 5, 15)}",
        f"loc:{_band(float(b.max_file_loc), 150, 400)}",
        "has_tests" if b.has_tests else "no_tests",
        f"files:{b.files}",
    ]


async def extract_or_none(
    extractor: ContextExtractor | None, task: str, files: list[Path] | None
) -> SignalBundle | None:
    """Run ``extractor`` if configured and files were provided; None otherwise.

    Never raises — a broken extractor must not block routing (fall back to text-only).
    """
    if extractor is None or not files:
        return None
    try:
        result = extractor.extract(task, list(files))
        if hasattr(result, "__await__"):
            result = await result  # type: ignore[assignment]
        return result  # type: ignore[return-value]
    except Exception:  # noqa: BLE001
        _log.warning("signal_extraction_failed", exc_info=True)
        return None
