"""Super-NaturalInstructions loader for the classifier A/B (Leg A).

Why SNI: the head's training corpus is curated seeds + CLINC150 + RouterBench
(scripts/classifier/common.py). SNI's official 119-task held-out test split is in none
of them, so it is the only slice here that measures generalization rather than recall.

Why ranged reads instead of HuggingFace: each task JSON is >10 MB (up to 6500 instances),
but `Categories` sits at byte ~170 and `Instances` starts at ~3 KB. A single HTTP range
read per task gets the label AND enough instances, with no dataset library, no auth, and
a byte-identical local cache — so the whole eval re-runs offline and deterministically.

The 76->11 category map is authored by us and is the weakest link in the gold labels; it
is frozen in PREREG.md and its hash is recorded in the report. Categories with no
defensible mapping are `None` here and are scored only for abstention behavior.
"""

from __future__ import annotations

import json
import re
import subprocess
import unicodedata
from dataclasses import dataclass
from pathlib import Path

_RAW = "https://raw.githubusercontent.com/allenai/natural-instructions/master"
_SPLIT_URL = _RAW + "/splits/default/{split}_tasks.txt"
_TASK_URL = _RAW + "/tasks/{name}.json"

# Two-tier fetch. `Categories`/`Definition`/`Domains`/`Input_language` all sit in the
# first ~3 KB, so the index over all ~1.6k tasks costs 4 KB each; only the tasks actually
# sampled pay the 400 KB read that reaches into `Instances`.
_INDEX_BYTES = 4_000
_HEAD_BYTES = 120_000

# SNI's official test split covers only 12 categories (~5 Minima types, no code/qa/
# translation/tool_use). The head never trained on ANY SNI, so the train/test line is
# irrelevant to contamination here — the full task set is what buys taxonomy coverage.
SPLITS = ("test", "train", "excluded")

_DECODER = json.JSONDecoder()


@dataclass(slots=True, frozen=True)
class SniRow:
    task: str
    category: str
    definition: str
    domains: tuple[str, ...]
    instance_id: str
    input: str
    label: str | None  # mapped TaskType value; None = unmappable category

    @property
    def text(self) -> str:
        """What the classifier sees.

        SNI splits the ask (`Definition`) from the payload (`input`); an agent would send
        both as one prompt, so that is what we classify. Definition alone would leak the
        category almost verbatim; input alone is often a bare text blob with no task in it.
        """
        return f"{self.definition.strip()}\n\n{self.input.strip()}"


def _curl(url: str, *, byte_range: str | None = None) -> str:
    cmd = ["curl", "-sSL", "--fail", "--retry", "3", "--retry-delay", "1"]
    if byte_range:
        cmd += ["-r", byte_range]
    cmd.append(url)
    out = subprocess.run(cmd, capture_output=True, check=True)
    return out.stdout.decode("utf-8", errors="replace")


def _cached(cache_dir: Path, key: str, fetch) -> str:
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / key
    if path.exists():
        return path.read_text(encoding="utf-8")
    body = fetch()
    path.write_text(body, encoding="utf-8")
    return body


def _field(blob: str, key: str):
    """raw_decode the value of a top-level key out of a TRUNCATED JSON document."""
    marker = f'"{key}":'
    i = blob.find(marker)
    if i < 0:
        return None
    j = i + len(marker)
    while j < len(blob) and blob[j] in " \t\r\n":
        j += 1
    try:
        value, _ = _DECODER.raw_decode(blob, j)
    except ValueError:
        return None
    return value


def _instances(blob: str, cap: int) -> list[dict]:
    """Pull complete instance objects out of a truncated `Instances` array.

    raw_decode from each object start; the first failure is the truncation boundary, so
    we stop there rather than guessing. Never returns a partially-read instance.
    """
    marker = '"Instances":'
    i = blob.find(marker)
    if i < 0:
        return []
    pos = blob.find("[", i)
    if pos < 0:
        return []
    pos += 1
    rows: list[dict] = []
    while len(rows) < cap:
        while pos < len(blob) and blob[pos] in " \t\r\n,":
            pos += 1
        if pos >= len(blob) or blob[pos] != "{":
            break
        try:
            obj, pos = _DECODER.raw_decode(blob, pos)
        except ValueError:
            break
        rows.append(obj)
    return rows


def task_names(cache_dir: Path, splits: tuple[str, ...] = SPLITS) -> list[str]:
    seen: dict[str, None] = {}
    for split in splits:
        body = _cached(
            cache_dir, f"{split}_tasks.txt", lambda s=split: _curl(_SPLIT_URL.format(split=s))
        )
        for ln in body.splitlines():
            if ln.strip():
                seen.setdefault(ln.strip(), None)
    return list(seen)


@dataclass(slots=True, frozen=True)
class TaskHeader:
    name: str
    category: str
    definition: str
    domains: tuple[str, ...]
    input_language: tuple[str, ...]
    output_language: tuple[str, ...]


def _parse_header(name: str, blob: str) -> TaskHeader:
    def first(key: str) -> str:
        v = _field(blob, key) or [""]
        return str(v[0]) if v else ""

    def tup(key: str) -> tuple[str, ...]:
        return tuple(str(x) for x in (_field(blob, key) or []))

    return TaskHeader(
        name=name,
        category=first("Categories"),
        definition=first("Definition"),
        domains=tup("Domains"),
        input_language=tup("Input_language"),
        output_language=tup("Output_language"),
    )


def load_header(name: str, cache_dir: Path) -> TaskHeader:
    """Cheap 4 KB read — category + definition only, for building the index."""
    blob = _cached(
        cache_dir,
        f"{name}.idx.json",
        lambda: _curl(_TASK_URL.format(name=name), byte_range=f"0-{_INDEX_BYTES}"),
    )
    return _parse_header(name, blob)


def load_instances(name: str, cache_dir: Path, *, cap: int) -> tuple[TaskHeader, list[dict]]:
    """Full 400 KB read — header plus as many complete instances as `cap` asks for."""
    blob = _cached(
        cache_dir,
        f"{name}.head.json",
        lambda: _curl(_TASK_URL.format(name=name), byte_range=f"0-{_HEAD_BYTES}"),
    )
    return _parse_header(name, blob), _instances(blob, cap)


# --- corpus-contamination guard -------------------------------------------------------
# Reuses the harness's own leakage primitives so the definition of "twin" is identical to
# the one the savings eval already defends (tests/eval/harness.py:_toks/_jaccard).

# Unicode-aware on purpose. The harness's own `[a-z0-9]+` is fine for English RouterBench
# prompts, but SNI's translation slice is Tamil/Hindi/Japanese/…: an ASCII class tokenizes
# every one of those to the EMPTY set, so they all share the empty fingerprint and
# "exact-match" each other. That silently deleted 70% of the translation class on the
# first run of this guard.
_WORD = re.compile(r"\w+", re.UNICODE)

# Below this, Jaccard is dominated by chance — "Please hold on." shares 0.6+ with any
# short corpus row. Fingerprint equality is likewise meaningless on a 1-2 token string.
_MIN_TOKENS = 5


def norm_fingerprint(text: str) -> str:
    s = unicodedata.normalize("NFKC", text).lower()
    return " ".join(_WORD.findall(s))


def toks(text: str) -> set[str]:
    return set(_WORD.findall(unicodedata.normalize("NFKC", text).lower()))


def comparable(text: str) -> bool:
    return len(_WORD.findall(unicodedata.normalize("NFKC", text).lower())) >= _MIN_TOKENS


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / (len(a) + len(b) - inter)
