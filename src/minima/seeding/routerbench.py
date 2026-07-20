"""Load RouterBench (offline benchmark) into Minima outcome records.

RouterBench (``withmartian/routerbench``) ships as pickled pandas frames
(``routerbench_0shot.pkl``), not a ``datasets``-loadable layout — so it is fetched with
``hf_hub_download`` + ``pandas.read_pickle``. Each row is a prompt; per model there is a
``<model>`` correctness column (0/1) and a ``<model>|total_cost`` column (real USD for
that call). We emit one outcome record per (prompt, model). Requires the ``seed`` extra
(``datasets``/``huggingface-hub``/``pandas``); raises a clear error otherwise.
"""

from __future__ import annotations

from typing import Any

from minima.memory.keys import build_content, task_cluster, task_fingerprint
from minima.memory.records import EVIDENCE_DATASET, OutcomeRecord
from minima.seeding.items import SeedItem

_REPO_ID = "withmartian/routerbench"
_SPLIT_FILES = {"0shot": "routerbench_0shot.pkl", "5shot": "routerbench_5shot.pkl"}
_COST_SUFFIX = "|total_cost"

_EVAL_TO_TASK_TYPE = {
    "mbpp": "code",
    "humaneval": "code",
    "code-llama": "code",
    "gsm8k": "reasoning",
    "grade-school-math": "reasoning",
    "math": "reasoning",
    "mmlu": "qa",
    "arc": "qa",
    "hellaswag": "reasoning",
    "winogrande": "reasoning",
    "rag": "rag",
    "mt-bench": "other",
    "mtbench": "other",
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


def detect_model_columns(columns: list[str]) -> dict[str, str]:
    """Return {score_column: cost_column} for every model with a cost sibling."""
    cost_cols = {c for c in columns if isinstance(c, str) and c.endswith(_COST_SUFFIX)}
    pairs: dict[str, str] = {}
    for cost_col in cost_cols:
        score_col = cost_col[: -len(_COST_SUFFIX)]
        if score_col in columns:
            pairs[score_col] = cost_col
    return pairs


def load_routerbench_df(split: str = "0shot") -> Any:
    """Download + read the RouterBench pickle into a pandas DataFrame."""
    try:
        import pandas as pd
        from huggingface_hub import hf_hub_download
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "RouterBench needs the 'seed' extra: `uv sync --extra seed`. "
            "For a network-free smoke test use `--dataset synthetic`."
        ) from exc

    filename = _SPLIT_FILES.get(split, _SPLIT_FILES["0shot"])
    path = hf_hub_download(repo_id=_REPO_ID, filename=filename, repo_type="dataset")
    return pd.read_pickle(path)


def load_records(
    limit: int,
    aliases: dict[str, list[str]],
    split: str = "0shot",
    catalog_ids: set[str] | None = None,
) -> list[SeedItem]:
    # Emit outcome records ONLY for dataset models that exist verbatim (or via a
    # same-model alias) in the live catalog. Cross-generation identity transfer
    # (crediting a 2024 model's exam results and prices to a current model id) was
    # removed; a dataset sharing no models with the catalog fails loudly instead of
    # seeding records no recommendation will ever count.
    df = load_routerbench_df(split)
    columns = list(df.columns)
    model_columns = detect_model_columns(columns)
    if not model_columns:
        raise RuntimeError(
            f"could not detect RouterBench model columns in {columns[:10]}...; "
            "the dataset schema may have changed."
        )

    reverse = _reverse_aliases(aliases)
    if catalog_ids is not None:
        model_columns = {
            score_col: cost_col
            for score_col, cost_col in model_columns.items()
            if reverse.get(score_col, score_col) in catalog_ids
        }
        if not model_columns:
            raise RuntimeError(
                "RouterBench shares no models with the live catalog -- seeding would "
                "write records no candidate pool ever counts. Use --dataset synthetic "
                "(priors + your first live feedbacks are the honest cold start), or a "
                "current-generation dataset."
            )
    prompt_col = "prompt" if "prompt" in columns else columns[0]
    out: list[SeedItem] = []

    for row_index, row in enumerate(df.itertuples(index=False)):
        if len(out) >= limit:
            break
        rowd = dict(zip(columns, row, strict=False))
        prompt = str(rowd.get(prompt_col, "")).strip()
        if not prompt:
            continue
        task_type = _task_type_for(str(rowd.get("eval_name", "")))
        difficulty = "medium"
        fingerprint = task_fingerprint(prompt)
        cluster = task_cluster(task_type, difficulty)
        content = build_content(task_type, difficulty, prompt)

        for score_col, cost_col in model_columns.items():
            quality = _to_float(rowd.get(score_col))
            if quality is None:
                continue
            model_id = reverse.get(score_col, score_col)
            if catalog_ids is not None and model_id not in catalog_ids:
                continue
            record = OutcomeRecord(
                model_id=model_id,
                task_type=task_type,
                difficulty=difficulty,
                task_fingerprint=fingerprint,
                task_cluster=cluster,
                cost_usd=_to_float(rowd.get(cost_col)) or 0.0,
                quality_score=max(0.0, min(1.0, quality)),
                outcome="success" if quality >= 0.5 else "failure",
                evidence_source=EVIDENCE_DATASET,
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
