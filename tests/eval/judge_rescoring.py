"""Experiment 3 — LLM-judge re-scoring of LLMRouterBench cells (the footnote defense).

Answers the inflated-headroom critique (arXiv:2605.07395): exact-match scoring can inflate
apparent routing savings by ~13-17pp vs an LLM judge. Instead of waiting for a reviewer to
ask, we re-score OUR OWN (prompt, model) cells with a blind judge and report the delta.

Scope (fieldnote/benchmark-plan.md Phase 3):
- Only datasets whose upstream label is exact-match style. The arena-style sets were
  already judge-scored upstream ({0, 0.5, 1} grades) — re-judging those measures
  judge-vs-judge agreement, a different claim. Default scope below.
- The judge is BLIND (no model/provider names), temperature 0, prompt frozen — cite
  ``judge_prompt_fingerprint()`` in the paper. Judge model must NOT be a routing candidate.
- SPEND GATE: nothing in this module calls an LLM unless BOTH an API key is present AND
  ``MINIMA_JUDGE_GO=1`` is set. Reading the tarball is free.

The response text comes straight from the cached benchmark tarball (verified present:
``raw_output`` is the model's answer; no regeneration needed).
"""

from __future__ import annotations

import hashlib
import json
import os
import tarfile
from collections.abc import Iterator
from typing import Any

from minima.memory.keys import task_fingerprint
from minima.seeding.llmrouterbench import _split_member, download_tarball

# Exact-match-style frontier datasets (numeric/MCQ/short-answer graders upstream).
# EXCLUDED on purpose: arenahard* (upstream LLM-judge grades), swe-bench (patch harness),
# tau2 (tool-use sim) — re-judging those doesn't test the exact-match-inflation claim.
EXACT_MATCH_DATASETS: tuple[str, ...] = (
    "aime", "arc-agi", "gpqa", "hle", "livecodebench", "livemathbench", "mmlupro", "simpleqa",
)

JUDGE_MODEL = "claude-haiku-4-5-20251001"  # not a routing candidate; disclose in the paper

# FROZEN judge prompt — any edit changes judge_prompt_fingerprint() and must be re-registered.
JUDGE_PROMPT = """You are grading whether a model's answer to a benchmark question is correct.

Question:
{prompt}

{reference_block}Model's answer (graded blind — you are not told which model wrote it):
{answer}

Grade STRICTLY. The answer is correct only if its final result matches the reference
(or, when no reference is given, is verifiably correct on the question's own terms).
Reasoning quality does not matter; only the final answer does. Partial credit is 0.

Reply with ONLY a JSON object: {{"correct": true|false, "reason": "<one short sentence>"}}"""


def judge_prompt_fingerprint() -> str:
    return hashlib.sha256(JUDGE_PROMPT.encode()).hexdigest()[:16]


def iter_judge_records(
    *,
    datasets: set[str] | None = None,
    models: set[str] | None = None,
    limit: int | None = None,
    tarball_path: str | None = None,
) -> Iterator[dict[str, Any]]:
    """Like ``llmrouterbench.iter_raw_records`` but KEEPS the response text.

    Yields dicts with: dataset_id, model_name, index, prompt, prompt_fp (harness Row.fp
    compatible), raw_output, ground_truth, score (the upstream label).
    """
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
            if data.get("demo", False):
                continue
            for rec in data.get("records", []):
                prompt = str(rec.get("prompt") or "")
                raw = rec.get("raw_output")
                if not prompt or raw is None:
                    continue
                yield {
                    "dataset_id": data.get("dataset_name", ds),
                    "model_name": data.get("model_name", model),
                    "index": rec.get("index"),
                    "prompt": prompt,
                    "prompt_fp": task_fingerprint(prompt),
                    "raw_output": str(raw),
                    "ground_truth": rec.get("ground_truth"),
                    "score": rec.get("score"),
                }
                emitted += 1
                if limit is not None and emitted >= limit:
                    return


def select_cells(target_fps: set[str], candidates: list[str],
                 datasets: tuple[str, ...] = EXACT_MATCH_DATASETS,
                 max_answer_chars: int = 30_000) -> list[dict[str, Any]]:
    """Collect the (prompt, model) cells to judge: every candidate's answer on every
    target prompt (e.g. the Phase-1 TEST split fingerprints). Long reasoning traces are
    tail-truncated — the final answer lives at the end."""
    cells: list[dict[str, Any]] = []
    for rec in iter_judge_records(datasets=set(datasets), models=set(candidates)):
        if rec["prompt_fp"] not in target_fps:
            continue
        if len(rec["raw_output"]) > max_answer_chars:
            rec["raw_output"] = "…" + rec["raw_output"][-max_answer_chars:]
        cells.append(rec)
    return cells


def build_judge_messages(cell: dict[str, Any]) -> str:
    gt = cell.get("ground_truth")
    ref = f"Reference answer:\n{gt}\n\n" if gt not in (None, "") else ""
    return JUDGE_PROMPT.format(prompt=cell["prompt"], reference_block=ref,
                               answer=cell["raw_output"])


def spend_authorized() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY")) and os.getenv("MINIMA_JUDGE_GO") == "1"


async def judge_cells(cells: list[dict[str, Any]], *, concurrency: int = 8) -> list[dict[str, Any]]:
    """Score cells with the blind judge. HARD SPEND GATE — see module docstring."""
    if not spend_authorized():
        raise RuntimeError(
            "LLM-judge spend not authorized: set ANTHROPIC_API_KEY and MINIMA_JUDGE_GO=1 "
            "(fieldnote/benchmark-plan.md roast Q10)."
        )
    import asyncio

    from anthropic import AsyncAnthropic

    client = AsyncAnthropic()
    sem = asyncio.Semaphore(concurrency)

    async def one(cell: dict[str, Any]) -> dict[str, Any]:
        async with sem:
            resp = await client.messages.create(
                model=JUDGE_MODEL, max_tokens=200, temperature=0.0,
                messages=[{"role": "user", "content": build_judge_messages(cell)}],
            )
        text = resp.content[0].text.strip()
        try:
            start, end = text.index("{"), text.rindex("}") + 1
            verdict = json.loads(text[start:end])
            correct = bool(verdict.get("correct"))
            reason = str(verdict.get("reason", ""))[:300]
        except (ValueError, json.JSONDecodeError):
            correct, reason = False, f"UNPARSEABLE: {text[:120]}"
        return {**{k: cell[k] for k in ("dataset_id", "model_name", "index", "prompt_fp", "score")},
                "judge_correct": correct, "judge_reason": reason}

    return list(await asyncio.gather(*(one(c) for c in cells)))


def agreement_report(judged: list[dict[str, Any]]) -> str:
    """Judge vs upstream exact-match label: per-dataset confusion + Cohen's kappa."""
    by_ds: dict[str, list[dict]] = {}
    for j in judged:
        by_ds.setdefault(j["dataset_id"], []).append(j)
    lines = [f"{'dataset':<16} {'n':>5} {'agree':>7} {'kappa':>7} {'em+ j-':>6} {'em- j+':>6}"]
    for ds, items in sorted(by_ds.items()):
        n = len(items)
        em = [(i["score"] or 0.0) >= 0.5 for i in items]
        jd = [i["judge_correct"] for i in items]
        agree = sum(a == b for a, b in zip(em, jd, strict=True)) / n
        p_yes = (sum(em) / n) * (sum(jd) / n)
        p_no = (1 - sum(em) / n) * (1 - sum(jd) / n)
        pe = p_yes + p_no
        kappa = (agree - pe) / (1 - pe) if pe < 1.0 else 1.0
        em_only = sum(a and not b for a, b in zip(em, jd, strict=True))
        j_only = sum(b and not a for a, b in zip(em, jd, strict=True))
        lines.append(f"{ds:<16} {n:>5} {agree:>7.1%} {kappa:>7.3f} {em_only:>6} {j_only:>6}")
    lines.append(f"judge={JUDGE_MODEL}  prompt_fp={judge_prompt_fingerprint()}  blind=yes  temp=0")
    return "\n".join(lines)
