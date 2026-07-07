"""Retention frontier — same 6 tasks run at slider 2, 5, 8.

Maps Minima's cost-quality tradeoff curve: which model does it pick at each
quality bar, and does quality actually hold as the slider drops?

    uv run python examples/agent_retention.py
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path

import anthropic as _anthropic
from google import genai as _genai
from google.genai import types as _gtypes

from minima.schemas.common import Constraints
from minima_client import AsyncMinimaClient

MINIMA_URL = os.environ.get("MINIMA_URL", "https://api.minima.sh")
MUBIT_KEY  = os.environ.get("MUBIT_API_KEY")
GEMINI_KEY = os.environ["GEMINI_API_KEY"]
ANTH_KEY   = os.environ["ANTHROPIC_API_KEY"]

JUDGE_MODEL = "claude-haiku-4-5"
SLIDERS = [2.0, 5.0, 8.0]
N_REPEATS = 2   # run each (task, slider) pair twice → smoother quality estimate

CANDIDATES = [
    "gemini-2.5-flash",
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "gemini-2.5-pro",
    "claude-opus-4-8",
]

_anth = _anthropic.Anthropic(api_key=ANTH_KEY)
_gem  = _genai.Client(api_key=GEMINI_KEY)

# 6 tasks chosen to span the quality spectrum:
# - 2 easy (expected: flash wins at all sliders)
# - 2 medium (expected: flash at low, pro at high)
# - 2 hard (expected: pro at all sliders, quality degrades at low slider)
TASKS = [
    ("fr-translate",    "translation", "Translate to French: 'The meeting has been postponed to next Thursday at 3 PM.'",
     "Must contain réunion/reportée/jeudi/15h. Award 10 if all present, deduct 2.5 per missing term.",  ""),
    ("article-summary", "summarization",
     "Summarize in 2 sentences: 'Quantum computing leverages superposition and entanglement to process information differently from classical computers. Qubits can exist in both states simultaneously, enabling massive parallelism. Companies like IBM and Google race toward quantum advantage — the point where a quantum computer beats classical. Challenges include qubit stability, error rates, and extreme cooling.'",
     "Must be 2 sentences, accurately capture quantum computing core idea, mention race or challenges. Award 10 if concise+accurate+2 sentences.",  ""),
    ("fallacy-detect",  "reasoning",
     "Name the logical fallacy and explain in one sentence: 'We shouldn't listen to Dr. Smith's climate research because she drives a gas-powered car.'",
     "Must identify ad hominem. Award 10 if named+explained, 5 if explained but not named.",  "Ad hominem"),
    ("debug-off-by-one","code",
     "Fix this Python function that should sum ALL elements but has a bug:\ndef sum_list(nums):\n    total=0\n    for i in range(len(nums)-1):\n        total+=nums[i]\n    return total",
     "Bug is range(len(nums)-1) should be range(len(nums)). Award 10 if fix is correct and explained.",  "range(len(nums))"),
    ("lru-cache",       "code",
     "Implement an LRU Cache: get(key)->int (-1 if absent), put(key,value) evicts LRU at capacity. Both O(1).",
     "Must be O(1). get must update recency. put must evict LRU. Award 10 if all correct.",  ""),
    ("logic-seating",   "reasoning",
     "Amy, Bob, Cal, Dee, Eve sit in a row. Rules: (1) Amy not adjacent to Bob. (2) Cal between Amy and Dee. (3) Eve at one end. (4) Bob not at either end. Give one valid arrangement and verify all 4 rules.",
     "Must produce valid arrangement satisfying all 4 constraints and verify each. Award 10 if valid+verified.",  ""),
]


def _call_model(model_id: str, prompt: str) -> tuple[str, int, int, int]:
    t0 = time.monotonic()
    if model_id.startswith("gemini"):
        max_tok = 2048 if "pro" in model_id else 1024
        r = _gem.models.generate_content(
            model=model_id, contents=prompt,
            config=_gtypes.GenerateContentConfig(max_output_tokens=max_tok, temperature=0.0),
        )
        text = r.text or ""
        in_t = r.usage_metadata.prompt_token_count or 0
        out_t = r.usage_metadata.candidates_token_count or 0
    else:
        msg = _anth.messages.create(
            model=model_id, max_tokens=2048,
            messages=[{"role": "user", "content": prompt}],
        )
        text = msg.content[0].text
        in_t = msg.usage.input_tokens
        out_t = msg.usage.output_tokens
    return text, in_t, out_t, int((time.monotonic() - t0) * 1000)


def _judge(prompt: str, output: str, rubric: str, expected: str) -> float:
    jp = (f"You are a strict grader. Score 0-10.\n\nTask: {prompt[:300]}\nAI response: {output[:600]}\n"
          f"{'Expected: ' + expected + chr(10) if expected else ''}Rubric: {rubric}\n\nSingle integer 0-10 only.")
    msg = _anth.messages.create(model=JUDGE_MODEL, max_tokens=5,
                                messages=[{"role": "user", "content": jp}])
    try:
        return min(max(float(msg.content[0].text.strip()), 0.0), 10.0) / 10.0
    except ValueError:
        return 0.5


def _append(path: Path, record: dict) -> None:
    with path.open("a") as f:
        f.write(json.dumps(record) + "\n")


async def main() -> None:
    ts = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
    log_dir = Path("runs") / f"retention_{ts}"
    log_dir.mkdir(parents=True, exist_ok=True)
    print(f"\nRetention frontier → {log_dir}/\n")

    all_results: list[dict] = []

    async with AsyncMinimaClient(MINIMA_URL, api_key=MUBIT_KEY, timeout=60.0) as minima:
        for label, task_type, prompt, rubric, expected in TASKS:
            print(f"\n── {label} ({'─'*(54-len(label))})")
            print(f"  {'SLIDER':>7}  {'MODEL':<22}  {'BASIS':<7}  {'QUALITY':>7}  {'COST':>10}")

            for slider in SLIDERS:
                q_scores, costs, models, bases = [], [], [], []

                for _ in range(N_REPEATS):
                    rec = await minima.recommend(
                        {"task": prompt, "task_type": task_type},
                        cost_quality_tradeoff=slider,
                        constraints=Constraints(candidate_models=CANDIDATES),
                    )
                    model  = rec.recommended_model.model_id
                    basis  = str(rec.decision_basis)
                    est    = rec.recommended_model.est_cost_usd

                    output, in_t, out_t, lat = _call_model(model, prompt)
                    quality = _judge(prompt, output, rubric, expected)
                    outcome = "success" if quality >= 0.8 else ("partial" if quality >= 0.4 else "failure")

                    await minima.feedback(
                        rec.recommendation_id, model, outcome,
                        quality_score=quality, input_tokens=in_t, output_tokens=out_t,
                        actual_cost_usd=round(est, 8), latency_ms=lat,
                        verified_in_production=True,
                    )

                    q_scores.append(quality)
                    costs.append(est)
                    models.append(model)
                    bases.append(basis)

                    row = dict(task=label, task_type=task_type, slider=slider,
                               model=model, basis=basis, quality=round(quality, 3),
                               cost_usd=round(est, 8), latency_ms=lat,
                               timestamp=datetime.now(UTC).isoformat())
                    _append(log_dir / "results.jsonl", row)
                    all_results.append(row)

                avg_q    = sum(q_scores) / len(q_scores)
                avg_cost = sum(costs) / len(costs)
                model_str = models[0] if len(set(models)) == 1 else f"{models[0]}*"
                basis_str = bases[0]  if len(set(bases))  == 1 else "mixed"
                print(f"  {slider:>7.1f}  {model_str:<22}  {basis_str:<7}  {avg_q:>7.3f}  ${avg_cost:>9.6f}")

    # Build frontier table per task
    print("\n\n" + "=" * 72)
    print("RETENTION FRONTIER SUMMARY")
    print("=" * 72)
    print(f"{'TASK':<22} {'SLIDER':>7}  {'MODEL':<22}  {'AVG_Q':>7}  {'COST':>10}")
    print("-" * 72)

    from collections import defaultdict
    by_task_slider: dict = defaultdict(list)
    for r in all_results:
        by_task_slider[(r["task"], r["slider"])].append(r)

    for label, *_ in TASKS:
        for slider in SLIDERS:
            rows = by_task_slider.get((label, slider), [])
            if not rows: continue
            avg_q    = sum(r["quality"] for r in rows) / len(rows)
            avg_cost = sum(r["cost_usd"] for r in rows) / len(rows)
            models   = [r["model"] for r in rows]
            model_str = (models[0] if len(set(models)) == 1 else "mixed").replace("gemini-2.5-flash","flash").replace("gemini-2.5-pro","pro").replace("claude-sonnet-4-6","sonnet").replace("claude-haiku-4-5","haiku")
            print(f"{label:<22} {slider:>7.1f}  {model_str:<22}  {avg_q:>7.3f}  ${avg_cost:>9.6f}")
        print()

    (log_dir / "summary.json").write_text(json.dumps(
        {(f"{t}@{s}"): {"avg_quality": round(sum(r["quality"] for r in rows)/len(rows), 4),
                        "avg_cost": round(sum(r["cost_usd"] for r in rows)/len(rows), 6),
                        "models": list(set(r["model"] for r in rows))}
         for (t, s), rows in by_task_slider.items()}, indent=2))

    print(f"\nSaved → {log_dir}/")


if __name__ == "__main__":
    asyncio.run(main())
