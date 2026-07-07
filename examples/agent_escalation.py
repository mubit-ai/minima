"""Escalation comparison — arm A (escalation ON) vs arm B (escalation OFF).

Runs 10 hard tasks × 3 rounds per arm, logs decision_basis, quality, cost, and
whether the LLM reasoner fired (basis == 'llm'). Saves to runs/escalation_TIMESTAMP/.

    uv run python examples/agent_escalation.py
"""

from __future__ import annotations

import asyncio
import json
import os
import random
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

N_ROUNDS   = 3
SEED       = 42
JUDGE_MODEL = "claude-haiku-4-5"

CANDIDATES = [
    "gemini-2.5-flash",
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "gemini-2.5-pro",
    "claude-opus-4-8",
]

_anth = _anthropic.Anthropic(api_key=ANTH_KEY)
_gem  = _genai.Client(api_key=GEMINI_KEY)

# 10 hard tasks — these are the ones where escalation is most likely to fire
# (uncertain memory, close candidates, or low confidence)
HARD_TASKS = [
    ("bst-implement",      "code",      7.0,
     "Implement a Python class BST with insert(val) and search(val)->bool. BST property must hold after every insert.",
     "Class must have correct insert (left<node<right) and search (returns bool). Award 10 if both correct, 5 if only one.",
     ""),
    ("lru-cache",          "code",      7.5,
     "Implement an LRU Cache in Python: get(key)->int (-1 if absent), put(key,value) evicts LRU when at capacity. Both O(1).",
     "Must use OrderedDict or doubly-linked-list+hashmap. get must update recency. put must evict LRU. Award 10 if all correct.",
     ""),
    ("conditional-prob",   "reasoning", 7.0,
     "A fair six-sided die is rolled twice. Given that both rolls show odd numbers, what is the probability their sum equals 6? Show working.",
     "Correct answer is 1/3. Odd pairs summing to 6: (1,5),(5,1),(3,3)=3. Total odd pairs=9. P=3/9=1/3. Award 10 if 1/3 with correct reasoning.",
     "1/3"),
    ("fraction-wordproblem","reasoning", 7.0,
     "Alice completed 2/5 of a project. Bob completed 3/8 more than Alice. Carol completed 1/4 less than Bob. What fraction has Carol completed?",
     "Alice=16/40. Bob=31/40. Carol=21/40. Award 10 if 21/40 with steps, 5 if answer only.",
     "21/40"),
    ("painted-cube",       "reasoning", 8.0,
     "A cube is painted red on all 6 faces, then cut into 27 equal cubes (3x3x3). How many small cubes have exactly 2 red faces? Explain.",
     "Answer is 12 (edge pieces). Award 10 if 12 with correct reasoning, 5 if 12 with no reasoning.",
     "12"),
    ("big-o-analysis",     "code",      8.0,
     "What is the time complexity of this and why?\ndef mystery(n):\n    result=0\n    for i in range(n):\n        for j in range(i,n):\n            result+=j\n    return result",
     "Answer is O(n^2). Outer loop n times, inner runs n-i times, total=n(n+1)/2=O(n^2). Award 10 if O(n^2) with correct explanation.",
     "O(n^2)"),
    ("logic-seating",      "reasoning", 8.5,
     "Amy, Bob, Cal, Dee, Eve sit in a row. Rules: (1) Amy not adjacent to Bob. (2) Cal between Amy and Dee. (3) Eve at one end. (4) Bob not at either end. Give one valid arrangement and verify all 4 rules.",
     "Must produce a valid arrangement satisfying all 4 constraints and verify each. Award 10 if valid+verified, 6 if valid but unverified.",
     ""),
    ("multi-hop-qa",       "qa",        7.5,
     "1. Who created Python? 2. What country is that person from? 3. What year did that country join the EU? Answer each with brief reasoning.",
     "Answers: Guido van Rossum, Netherlands, 1995. Award 10 if all 3 correct, subtract 3 per wrong answer.",
     "Guido van Rossum, Netherlands, 1995"),
    ("fallacy-detect",     "reasoning", 5.0,
     "Name the logical fallacy and explain in one sentence: 'We shouldn't listen to Dr. Smith's climate research because she drives a gas-powered car.'",
     "Must identify 'ad hominem'. Award 10 if named correctly with explanation, 5 if explanation correct but name missing.",
     "Ad hominem"),
    ("email-regex",        "code",      5.5,
     "Write a Python function is_valid_email(email:str)->bool using regex. Must: return True for 'user@example.com', False for 'notanemail', False for '@missing.com', False for 'missing@'.",
     "Must use re module, handle all four cases. Award 10 if all correct, subtract 2.5 per failing case.",
     ""),
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
        in_t  = r.usage_metadata.prompt_token_count or 0
        out_t = r.usage_metadata.candidates_token_count or 0
    else:
        msg = _anth.messages.create(
            model=model_id, max_tokens=2048,
            messages=[{"role": "user", "content": prompt}],
        )
        text  = msg.content[0].text
        in_t  = msg.usage.input_tokens
        out_t = msg.usage.output_tokens
    return text, in_t, out_t, int((time.monotonic() - t0) * 1000)


def _judge(prompt: str, output: str, rubric: str, expected: str) -> float:
    jp = (f"You are a strict grader. Score 0-10.\n\nTask: {prompt}\nAI response: {output[:600]}\n"
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


async def run_arm(
    minima: AsyncMinimaClient,
    arm: str,
    escalation_on: bool,
    rounds: int,
    log_dir: Path,
) -> list[dict]:
    results = []
    rng = random.Random(SEED)

    for rnd in range(1, rounds + 1):
        tasks = rng.sample(HARD_TASKS, len(HARD_TASKS))
        for label, task_type, slider, prompt, rubric, expected in tasks:
            rec = await minima.recommend(
                {"task": prompt, "task_type": task_type},
                cost_quality_tradeoff=slider,
                constraints=Constraints(candidate_models=CANDIDATES),
                allow_llm_escalation=escalation_on,
            )
            model  = rec.recommended_model.model_id
            basis  = str(rec.decision_basis)
            rec_id = rec.recommendation_id
            est    = rec.recommended_model.est_cost_usd

            output, in_t, out_t, lat = _call_model(model, prompt)
            quality = _judge(prompt, output, rubric, expected)
            outcome = "success" if quality >= 0.8 else ("partial" if quality >= 0.4 else "failure")

            await minima.feedback(
                rec_id, model, outcome,
                quality_score=quality, input_tokens=in_t, output_tokens=out_t,
                actual_cost_usd=round(est, 8), latency_ms=lat,
                verified_in_production=True,
            )

            row = dict(arm=arm, escalation=escalation_on, round=rnd, task=label,
                       task_type=task_type, slider=slider, model=model, basis=basis,
                       quality=round(quality, 3), cost_usd=round(est, 8),
                       latency_ms=lat, outcome=outcome,
                       timestamp=datetime.now(UTC).isoformat())
            _append(log_dir / "results.jsonl", row)
            results.append(row)

            esc_marker = " 🤖LLM" if basis == "llm" else ""
            print(f"  [{arm}] r{rnd} {label:<22} {model:<22} {basis:<7} q={quality:.2f}{esc_marker}")

    return results


async def main() -> None:
    ts = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
    log_dir = Path("runs") / f"escalation_{ts}"
    log_dir.mkdir(parents=True, exist_ok=True)
    print(f"\nEscalation comparison → {log_dir}/\n")

    async with AsyncMinimaClient(MINIMA_URL, api_key=MUBIT_KEY, timeout=60.0) as minima:
        print("=" * 64)
        print("ARM A — allow_llm_escalation=True")
        print("=" * 64)
        arm_a = await run_arm(minima, "A_on", True, N_ROUNDS, log_dir)

        print("\n" + "=" * 64)
        print("ARM B — allow_llm_escalation=False")
        print("=" * 64)
        arm_b = await run_arm(minima, "B_off", False, N_ROUNDS, log_dir)

    # Compare
    def stats(rows: list[dict]) -> dict:
        return {
            "avg_quality": round(sum(r["quality"] for r in rows) / len(rows), 4),
            "total_cost":  round(sum(r["cost_usd"] for r in rows), 6),
            "llm_escalations": sum(1 for r in rows if r["basis"] == "llm"),
            "memory_driven":   sum(1 for r in rows if r["basis"] == "memory"),
            "model_dist": {m: sum(1 for r in rows if r["model"] == m) for m in CANDIDATES},
        }

    sa, sb = stats(arm_a), stats(arm_b)
    summary = {"arm_A_escalation_on": sa, "arm_B_escalation_off": sb,
               "quality_delta": round(sa["avg_quality"] - sb["avg_quality"], 4),
               "cost_delta":    round(sa["total_cost"]  - sb["total_cost"],  6)}
    (log_dir / "summary.json").write_text(json.dumps(summary, indent=2))

    print("\n" + "=" * 64)
    print("COMPARISON")
    print("=" * 64)
    print(f"  {'Metric':<28} {'Arm A (ON)':>12} {'Arm B (OFF)':>12} {'Delta':>10}")
    print(f"  {'Avg quality':<28} {sa['avg_quality']:>12.4f} {sb['avg_quality']:>12.4f} {sa['avg_quality']-sb['avg_quality']:>+10.4f}")
    print(f"  {'Total cost':<28} ${sa['total_cost']:>11.5f} ${sb['total_cost']:>11.5f} ${sa['total_cost']-sb['total_cost']:>+9.5f}")
    print(f"  {'LLM escalations fired':<28} {sa['llm_escalations']:>12} {sb['llm_escalations']:>12}")
    print(f"  {'Memory-driven':<28} {sa['memory_driven']:>12} {sb['memory_driven']:>12}")
    print(f"\nSaved → {log_dir}/")


if __name__ == "__main__":
    asyncio.run(main())
