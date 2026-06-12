"""Fetch + raw-load LLMRouterBench / OpenRouterBench (offline benchmark).

LLMRouterBench (HF dataset ``NPULH/LLMRouterBench``; code repo ``ynulihao/LLMRouterBench``,
Findings@ACL 2026) ships as ONE gzipped tarball ``bench-release.tar.gz`` (~1.28 GB) whose
members are::

    bench-release/<dataset>/<model_name>/<dataset>-<model_name>-<YYYYMMDD_HHMMSS>.json

Each JSON is one ``(dataset, split, model)`` run: top-level aggregate fields
(``dataset_name``, ``split``, ``model_name``, ``demo``, ``data_fingerprint`` …) plus a
``records`` list. Each record carries::

    index, origin_query, prompt, prompt_tokens, completion_tokens,
    cost, score, prediction, ground_truth, raw_output

- ``score`` is 0.0/1.0 correctness (a few datasets use a graded [0,1] judge score).
- ``cost`` is the *real* per-call USD cost — BUT open models run locally report ``0.0``
  (handle this when building the cost axis; see Phase 2 of the plan and guard V2 — the
  router must *decide* on independent market prices, not on this column it is *scored* on).

We stream records straight out of the tarball (no multi-GB extraction) and drop the bulky
``raw_output`` by default. This module is **Phase 1** of
``docs/PLAN/LLMRouterBench-H1-setup.md`` — fetch + raw load only. The wide-DataFrame pivot
the eval harness consumes (``<model>`` score + ``<model>|total_cost`` columns) is **Phase 3**
and builds on :func:`iter_raw_records`.

Requires the ``seed`` extra (``huggingface-hub``/``pandas``); raises a clear error otherwise.
"""

from __future__ import annotations

import json
import re
import tarfile
from collections import defaultdict
from collections.abc import Iterator, Sequence
from typing import Any

_REPO_ID = "NPULH/LLMRouterBench"
_TARBALL = "bench-release.tar.gz"
_ROOT = "bench-release"
_TS_RE = re.compile(r"(\d{8}_\d{6})\.json$")
# Cost-column suffix the eval harness keys on. MUST match
# ``minima.seeding.routerbench.detect_model_columns`` so the wide frame this module emits is
# consumed by the same code path as RouterBench.
_COST_SUFFIX = "|total_cost"

# The per-record fields we keep. We drop the two bulky ones the eval never needs:
# ``raw_output`` and ``prediction`` (the latter is a full role/content conversation in the
# real data, despite schema.py declaring it ``str`` — confirmed by inspecting the bytes).
_RECORD_FIELDS = (
    "index", "origin_query", "prompt", "prompt_tokens",
    "completion_tokens", "cost", "score", "ground_truth",
)


def _require_seed_extra():
    try:
        from huggingface_hub import hf_hub_download  # noqa: F401
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "LLMRouterBench needs the 'seed' extra: `uv sync --extra seed`."
        ) from exc


def download_tarball() -> str:
    """Download (and HF-cache) ``bench-release.tar.gz``; return the local path.

    Idempotent: ``hf_hub_download`` returns the cached file on subsequent calls without
    re-downloading. The ~1.28 GB lives under the HF cache, not the repo.
    """
    _require_seed_extra()
    from huggingface_hub import hf_hub_download

    return hf_hub_download(repo_id=_REPO_ID, filename=_TARBALL, repo_type="dataset")


def _split_member(name: str) -> tuple[str, str, str, str] | None:
    """Map a member path to ``(dataset, subset, model, timestamp)``.

    Two shapes occur in the release; the **model is always the directory immediately
    above the file** and the **dataset is the first directory under the root** — the
    optional middle segment is a subset/split (e.g. ``valid``, ``subset_500``)::

        bench-release/<dataset>/<model>/<…ts>.json                (depth 4, subset="")
        bench-release/<dataset>/<subset>/<model>/<…ts>.json       (depth 5)

    (Parsing a fixed ``parts[2]`` as the model is the trap — it mis-reads the subset on
    depth-5 paths; confirmed by inspecting the tarball.)
    """
    parts = name.split("/")
    if len(parts) < 4 or parts[0] != _ROOT or not parts[-1].endswith(".json"):
        return None
    dataset = parts[1]
    model = parts[-2]
    subset = "/".join(parts[2:-2])  # "" for depth-4 paths
    m = _TS_RE.search(parts[-1])
    return dataset, subset, model, (m.group(1) if m else "")


def list_release_contents(tarball_path: str | None = None) -> dict[str, Any]:
    """Inventory the tarball WITHOUT parsing record bodies (one decompression pass).

    Returns ``{"datasets": [...], "models": [...], "latest": {(dataset, model): name},
    "file_count": int}``. ``latest`` keeps only the newest-timestamp file per
    ``(dataset, model)`` so duplicate re-runs are de-duplicated, mirroring the authors'
    ``BaselineDataLoader`` behaviour.
    """
    path = tarball_path or download_tarball()
    latest: dict[tuple[str, str, str], tuple[str, str]] = {}  # (ds, subset, model) -> (ts, name)
    file_count = 0
    with tarfile.open(path, mode="r|gz") as tf:
        for m in tf:
            if not m.isfile():
                continue
            parsed = _split_member(m.name)
            if parsed is None:
                continue
            ds, subset, model, ts = parsed
            file_count += 1
            key = (ds, subset, model)
            if key not in latest or ts > latest[key][0]:
                latest[key] = (ts, m.name)
    datasets = sorted({k[0] for k in latest})
    models = sorted({k[2] for k in latest})
    by_dataset: dict[str, set[str]] = defaultdict(set)
    for ds, _subset, model in latest:
        by_dataset[ds].add(model)
    return {
        "datasets": datasets,
        "models": models,
        "latest": {k: v[1] for k, v in latest.items()},
        "models_by_dataset": {k: sorted(v) for k, v in by_dataset.items()},
        "file_count": file_count,
    }


def iter_raw_records(
    tarball_path: str | None = None,
    *,
    datasets: set[str] | None = None,
    models: set[str] | None = None,
    limit: int | None = None,
    skip_demo: bool = True,
) -> Iterator[dict[str, Any]]:
    """Stream flattened per-(prompt, model) records out of the tarball.

    Each yielded dict has the keys ``dataset_id``, ``split``, ``model_name`` plus
    :data:`_RECORD_FIELDS` (``raw_output`` dropped). Filter by ``datasets`` / ``models``
    (matched on the member path, so unwanted files are skipped before JSON parsing).

    NOTE: this reads every ``.json`` member; for a pristine release there is exactly one
    file per ``(dataset, model)`` so no de-duplication is needed. If a release ever ships
    duplicate timestamped re-runs, restrict to :func:`list_release_contents`'s ``latest``
    set first.
    """
    _require_seed_extra()
    path = tarball_path or download_tarball()
    emitted = 0
    with tarfile.open(path, mode="r|gz") as tf:
        for m in tf:
            if not m.isfile():
                continue
            parsed = _split_member(m.name)
            if parsed is None:
                continue
            ds, _subset, model, _ts = parsed
            if datasets is not None and ds not in datasets:
                continue
            if models is not None and model not in models:
                continue
            fh = tf.extractfile(m)
            if fh is None:
                continue
            data = json.load(fh)
            if skip_demo and data.get("demo", False):
                continue
            dataset_id = data.get("dataset_name", ds)
            split = data.get("split", "")
            model_name = data.get("model_name", model)
            for rec in data.get("records", []):
                row = {"dataset_id": dataset_id, "split": split, "model_name": model_name}
                for f in _RECORD_FIELDS:
                    row[f] = rec.get(f)
                yield row
                emitted += 1
                if limit is not None and emitted >= limit:
                    return


def load_llmrouterbench_df(
    candidates: Sequence[str],
    datasets: Sequence[str],
    tarball_path: str | None = None,
):
    """Pivot the long per-(prompt, model) records into the WIDE DataFrame the eval consumes.

    This is Phase 3 of ``docs/PLAN/LLMRouterBench-H1-setup.md``. Output: one row per
    ``(dataset, question index)``, with columns ``prompt``, ``eval_name`` (= dataset id), and
    for each candidate model ``m`` a score column ``m`` and a cost column ``m|total_cost`` —
    i.e. exactly the contract ``routerbench.detect_model_columns`` / ``harness.prepare_rows``
    expect, so the eval reuses all its machinery unchanged.

    Keyed by ``(dataset_id, index)`` — the question's identity — rather than prompt text, so it
    is robust to repeated/boilerplate prompt strings within a dataset. Questions where any
    candidate lacks a usable ``(score, cost)`` are dropped (the harness would drop them anyway).
    """
    _require_seed_extra()
    import pandas as pd

    cand = list(candidates)
    want_ds = set(datasets)
    bucket: dict[tuple[str, Any], dict[str, Any]] = {}
    for r in iter_raw_records(tarball_path, datasets=want_ds, models=set(cand)):
        key = (r["dataset_id"], r["index"])
        slot = bucket.get(key)
        if slot is None:
            slot = {"prompt": r["prompt"], "scores": {}, "costs": {}}
            bucket[key] = slot
        slot["scores"][r["model_name"]] = r["score"]
        slot["costs"][r["model_name"]] = r["cost"]

    rows: list[dict[str, Any]] = []
    for (dataset_id, _idx), slot in bucket.items():
        if any(slot["scores"].get(m) is None or slot["costs"].get(m) is None for m in cand):
            continue
        row: dict[str, Any] = {"prompt": slot["prompt"], "eval_name": dataset_id}
        for m in cand:
            row[m] = slot["scores"][m]
            row[f"{m}{_COST_SUFFIX}"] = slot["costs"][m]
        rows.append(row)
    return pd.DataFrame(rows)
