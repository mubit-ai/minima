"""Load RouterBench (offline benchmark) into Costit outcome records.

Best-effort: RouterBench stores, per model, a score column and a sibling
``<model>|total_cost`` column. We detect those pairs, normalize model ids through the
alias map, and emit one outcome record per (prompt, model). Requires the ``seed`` extra
(``datasets``); raises a clear error otherwise. Models not in the live catalog still
ingest fine — they simply won't be recalled until added to the catalog.
"""

from __future__ import annotations

from typing import Any

from costit.memory.keys import build_content, task_cluster, task_fingerprint
from costit.memory.records import OutcomeRecord
from costit.seeding.items import SeedItem

_COST_SUFFIX = "|total_cost"

_EVAL_TO_TASK_TYPE = {
    "mbpp": "code",
    "humaneval": "code",
    "gsm8k": "reasoning",
    "math": "reasoning",
    "mmlu": "qa",
    "arc": "qa",
    "hellaswag": "reasoning",
    "winogrande": "reasoning",
    "rag": "rag",
    "mt-bench": "other",
}


def _reverse_aliases(aliases: dict[str, list[str]]) -> dict[str, str]:
    reverse: dict[str, str] = {}
    for canonical, names in aliases.items():
        for name in names:
            reverse[name] = canonical
    return reverse


def _task_type_for(eval_name: str) -> str:
    name = (eval_name or "").lower()
    for key, value in _EVAL_TO_TASK_TYPE.items():
        if key in name:
            return value
    return "other"


def _detect_model_columns(columns: list[str]) -> dict[str, str]:
    """Return {score_column: cost_column} for every model with a cost sibling."""
    cost_cols = {c for c in columns if c.endswith(_COST_SUFFIX)}
    pairs: dict[str, str] = {}
    for cost_col in cost_cols:
        score_col = cost_col[: -len(_COST_SUFFIX)]
        if score_col in columns:
            pairs[score_col] = cost_col
    return pairs


def load_records(limit: int, aliases: dict[str, list[str]], split: str = "train") -> list[SeedItem]:
    try:
        from datasets import load_dataset
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "RouterBench seeding needs the 'seed' extra: `uv sync --extra seed`. "
            "For a network-free smoke test use `--dataset synthetic`."
        ) from exc

    ds = load_dataset("withmartian/routerbench", split=split)
    columns = list(ds.column_names)
    model_columns = _detect_model_columns(columns)
    if not model_columns:
        raise RuntimeError(
            f"could not detect RouterBench model columns in {columns[:10]}...; "
            "the dataset schema may have changed."
        )

    reverse = _reverse_aliases(aliases)
    prompt_col = "prompt" if "prompt" in columns else columns[0]
    out: list[SeedItem] = []

    for row_index, row in enumerate(ds):
        if len(out) >= limit:
            break
        prompt = str(row.get(prompt_col, "")).strip()
        if not prompt:
            continue
        task_type = _task_type_for(str(row.get("eval_name", "")))
        difficulty = "medium"
        fingerprint = task_fingerprint(prompt)
        cluster = task_cluster(task_type, difficulty)
        content = build_content(task_type, difficulty, prompt)

        for score_col, cost_col in model_columns.items():
            quality = _to_float(row.get(score_col))
            if quality is None:
                continue
            model_id = reverse.get(score_col, score_col)
            record = OutcomeRecord(
                model_id=model_id,
                task_type=task_type,
                difficulty=difficulty,
                task_fingerprint=fingerprint,
                task_cluster=cluster,
                cost_usd=_to_float(row.get(cost_col)) or 0.0,
                quality_score=max(0.0, min(1.0, quality)),
                outcome="success" if quality >= 0.5 else "failure",
                source_dataset="routerbench",
            )
            out.append(
                SeedItem(
                    item_id=f"rb-{row_index}-{score_col}",
                    content=content,
                    record=record,
                    env_tags=["seed:routerbench"],
                )
            )
    return out


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
