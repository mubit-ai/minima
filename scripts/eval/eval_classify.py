#!/usr/bin/env python3
"""Isolated A/B of the task classifier: current (baseline) vs PR #41.

Loads the current `minima.recommender.classify` from the installed package and the
PR's version from a git ref via importlib (both import only stable symbols from
`minima.schemas.common`, so they coexist in one process). Runs both over a labeled
prompt set — same inputs, same process — and reports task-type accuracy, agreement,
and per-call latency. This isolates the classifier itself (independent of the recall
store / engine wiring).

    uv run python scripts/eval/eval_classify.py [--pr-ref origin/feature/auth-recommender]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_classify_from_ref(ref: str):
    """Load classify() from `classify.py` at a git ref as an isolated module."""
    src = subprocess.run(
        ["git", "show", f"{ref}:src/minima/recommender/classify.py"],
        capture_output=True, text=True, check=True,
    ).stdout
    with tempfile.NamedTemporaryFile("w", suffix="_classify_pr.py", delete=False) as f:
        f.write(src)
        path = f.name
    spec = importlib.util.spec_from_file_location("classify_pr", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod  # dataclasses/typing resolve __module__ via sys.modules
    spec.loader.exec_module(mod)
    return mod.classify


def timed(fn, task_input, reps: int = 50) -> tuple[object, float]:
    # warm once, then median-ish mean over reps for a stable per-call latency (µs).
    fn(task_input)
    t0 = time.perf_counter()
    result = None
    for _ in range(reps):
        result = fn(task_input)
    dt_us = (time.perf_counter() - t0) / reps * 1e6
    return result, dt_us


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pr-ref", default="origin/feature/auth-recommender")
    ap.add_argument("--dataset", default=str(HERE / "classify_dataset.json"))
    args = ap.parse_args()

    from minima.recommender.classify import classify as classify_base
    from minima.schemas.common import TaskInput

    classify_pr = load_classify_from_ref(args.pr_ref)
    data = json.loads(Path(args.dataset).read_text())

    rows = []
    base_correct = pr_correct = agree = 0
    base_us_total = pr_us_total = 0.0
    per_type: dict[str, dict[str, int]] = {}

    for item in data:
        ti = TaskInput(task=item["task"])
        gold = item["type"]
        (bt, _bd), b_us = timed(classify_base, ti)
        (pt, _pd), p_us = timed(classify_pr, ti)
        bt, pt = str(bt), str(pt)
        base_us_total += b_us
        pr_us_total += p_us
        b_ok, p_ok = bt == gold, pt == gold
        base_correct += b_ok
        pr_correct += p_ok
        agree += bt == pt
        d = per_type.setdefault(gold, {"n": 0, "base": 0, "pr": 0})
        d["n"] += 1
        d["base"] += b_ok
        d["pr"] += p_ok
        rows.append((gold, bt, pt, b_ok, p_ok, item["task"]))

    n = len(data)
    print(f"\nlabeled prompts: {n}\n")
    print(f"{'task_type accuracy':<24} base={base_correct}/{n} ({base_correct/n:.0%})   "
          f"PR={pr_correct}/{n} ({pr_correct/n:.0%})")
    print(f"{'agreement (base==PR)':<24} {agree}/{n} ({agree/n:.0%})")
    print(f"{'mean latency / call':<24} base={base_us_total/n:8.1f} µs   PR={pr_us_total/n:8.1f} µs "
          f"({pr_us_total/base_us_total:.1f}x)")

    print("\nper-type accuracy (base -> PR):")
    for t in sorted(per_type):
        d = per_type[t]
        print(f"  {t:<15} n={d['n']:<3} base {d['base']}/{d['n']}   PR {d['pr']}/{d['n']}")

    print("\ndisagreements / misses (gold | base | PR):")
    for gold, bt, pt, b_ok, p_ok, task in rows:
        if bt != pt or not b_ok or not p_ok:
            flag = "".join(("B" if not b_ok else "-", "P" if not p_ok else "-"))
            print(f"  [{flag}] {gold:<14} base={bt:<14} PR={pt:<14} :: {task[:60]}")

    verdict = "PR better" if pr_correct > base_correct else "base better" if base_correct > pr_correct else "tie"
    print(f"\nVERDICT (task-type accuracy): {verdict} "
          f"(Δ {pr_correct - base_correct:+d} correct)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
