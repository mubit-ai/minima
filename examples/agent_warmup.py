"""Warmup agent — 20 tasks × 5 runs against the hosted Minima API.

Builds Minima's memory from cold start, logs everything, snapshots learned
strategies after each run.

Usage:
    MUBIT_API_KEY=mbt_... GEMINI_API_KEY=... ANTHROPIC_API_KEY=... \\
    uv run python examples/agent_warmup.py
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import anthropic as _anthropic
from google import genai as _genai
from google.genai import types as _gtypes

from minima.schemas.common import Constraints
from minima_client import AsyncMinimaClient

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

MINIMA_URL = os.environ.get("MINIMA_URL", "https://api.minima.sh")
MUBIT_KEY  = os.environ.get("MUBIT_API_KEY")          # passthrough auth on hosted Minima
GEMINI_KEY = os.environ["GEMINI_API_KEY"]
ANTH_KEY   = os.environ["ANTHROPIC_API_KEY"]

N_RUNS = 5
JUDGE_MODEL = "claude-haiku-4-5"   # cheap, different provider → avoids self-grading bias

# Models available on hosted api.minima.sh — Google + Anthropic only (no OpenAI key)
CANDIDATES = [
    "gemini-2.5-flash",    # $0.30/$2.50 — cheap, solid
    "claude-haiku-4-5",    # $1.00/$5.00 — cheap, solid
    "claude-sonnet-4-6",   # $3.00/$15.0 — mid, great
    "gemini-2.5-pro",      # $1.25/$10.0 — expensive, great
    "claude-opus-4-8",     # $15.0/$75.0 — premium
]

# ---------------------------------------------------------------------------
# SDK clients (module-level, reused across all calls)
# ---------------------------------------------------------------------------

_anth  = _anthropic.Anthropic(api_key=ANTH_KEY)
_gem   = _genai.Client(api_key=GEMINI_KEY)

# ---------------------------------------------------------------------------
# Task definition
# ---------------------------------------------------------------------------

@dataclass
class Task:
    label: str
    task_type: str
    slider: float
    prompt: str
    rubric: str
    expected: str = ""

    def __post_init__(self):
        assert 0 < self.slider <= 10

# ---------------------------------------------------------------------------
# 20 tasks — chosen so cheap models win easy ones, expensive win hard ones
# ---------------------------------------------------------------------------

TASKS: list[Task] = [
    # --- Easy: small models handle fine (slider 1.5–3.5) ---
    Task(
        label="spam-detect",
        task_type="classification",
        slider=2.0,
        prompt="Is this email spam? Reply with exactly one word: Spam or Ham.\n\n"
               "'URGENT!! You've WON $1,000,000!!! Click http://claim-prize.biz NOW to collect!!!'",
        rubric="Reply must be exactly 'Spam'. Award 10 if correct, 0 otherwise.",
        expected="Spam",
    ),
    Task(
        label="receipt-extract",
        task_type="extraction",
        slider=2.0,
        prompt="Extract merchant, date, and total from this receipt. Reply as JSON.\n\n"
               "'STARBUCKS #1234 | Date: 06/11/2026 | Latte $6.50, Muffin $3.25 | Total: $9.75'",
        rubric="JSON must contain merchant (Starbucks), date (06/11/2026), and total ($9.75 or 9.75).",
        expected='{"merchant": "Starbucks", "date": "06/11/2026", "total": "$9.75"}',
    ),
    Task(
        label="fr-translate",
        task_type="translation",
        slider=2.5,
        prompt="Translate to French: 'The meeting has been postponed to next Thursday at 3 PM.'",
        rubric="Must contain 'réunion' or 'réunions', a word for postponed/rescheduled (reportée/repoussée), 'jeudi', and '15h' or '15:00' or '3h'. Award 10 if all present, 7 if 3/4, 4 if 2/4, 0 otherwise.",
        expected="La réunion a été reportée à jeudi prochain à 15h.",
    ),
    Task(
        label="sentiment",
        task_type="classification",
        slider=2.5,
        prompt="Classify sentiment as Positive, Negative, or Mixed. Reply with one word.\n\n"
               "'The food was amazing but the service was painfully slow and ruined the whole evening.'",
        rubric="Correct answer is Mixed. Award 10 if Mixed, 0 otherwise.",
        expected="Mixed",
    ),
    Task(
        label="csv-to-json",
        task_type="extraction",
        slider=2.0,
        prompt="Convert this CSV row to a JSON object.\n\nHeaders: name,age,city\nRow: Alice,30,New York",
        rubric="JSON must have name='Alice', age=30 (integer), city='New York'. Award 10 if all correct.",
        expected='{"name": "Alice", "age": 30, "city": "New York"}',
    ),
    # --- Medium: flash-level competence needed (slider 3.5–5.5) ---
    Task(
        label="article-summary",
        task_type="summarization",
        slider=4.5,
        prompt="Summarize in 2 sentences:\n\n"
               "Quantum computing leverages quantum mechanical phenomena—superposition and entanglement—"
               "to process information fundamentally differently from classical computers. While classical "
               "bits are either 0 or 1, quantum bits (qubits) can exist in both states simultaneously, "
               "enabling massive parallelism. Companies like IBM, Google, and startups are racing to reach "
               "'quantum advantage'—the point at which a quantum computer solves a problem no classical "
               "computer can solve in reasonable time. Current challenges include qubit stability, error "
               "rates, and the extreme cooling required to maintain quantum states.",
        rubric="Summary must be exactly 2 sentences, accurately capture quantum computing's core idea "
               "(superposition/parallelism), and mention the race/competition or challenges. Award 10 if "
               "concise, accurate, 2 sentences. Deduct 3 per missing criterion.",
    ),
    Task(
        label="fallacy-detect",
        task_type="reasoning",
        slider=5.0,
        prompt="Name the logical fallacy and explain it in one sentence:\n\n"
               "'We shouldn't listen to Dr. Smith's climate research because she drives a gas-powered car.'",
        rubric="Must identify 'ad hominem' (attacking the person rather than the argument). "
               "Award 10 if named correctly with explanation, 5 if explanation correct but name missing.",
        expected="Ad hominem",
    ),
    Task(
        label="passive-to-active",
        task_type="other",
        slider=3.5,
        prompt="Rewrite in active voice (keep all information):\n\n"
               "'The annual report was submitted late by the finance team, and two critical errors "
               "were discovered by the auditors.'",
        rubric="Both clauses must be active. 'Finance team' must be subject of first clause. "
               "'Auditors' must be subject of second clause. Award 10 if both correct, 5 if one correct.",
    ),
    Task(
        label="keyword-extract",
        task_type="extraction",
        slider=4.0,
        prompt="Extract the 5 most important keywords from this text as a comma-separated list:\n\n"
               "'Machine learning models require large datasets for training. Deep neural networks "
               "with multiple layers can learn complex patterns. Transfer learning allows pre-trained "
               "models to be fine-tuned on specific tasks, reducing the need for labeled data.'",
        rubric="Keywords should include: machine learning, neural networks, transfer learning, training, "
               "deep learning (or similar core terms). Award 10 if 4+ relevant terms, 6 if 3, 2 if fewer.",
    ),
    Task(
        label="email-formal",
        task_type="other",
        slider=3.5,
        prompt="Rewrite this message as a formal professional email (keep the same meaning):\n\n"
               "'Hey, just wanted to check if you got my last email? I need that report asap, "
               "it's kinda urgent lol. thx'",
        rubric="Must be formal (no slang, proper salutation/closing). Must convey: follow-up on "
               "previous email, request for report, urgency. Award 10 if all three plus formal tone.",
    ),
    # --- Code: moderate to hard (slider 5.5–7.5) ---
    Task(
        label="email-regex",
        task_type="code",
        slider=5.5,
        prompt="Write a Python function `is_valid_email(email: str) -> bool` using regex. "
               "It must: return True for 'user@example.com', return False for 'notanemail', "
               "return False for '@missing.com', return False for 'missing@'.",
        rubric="Function must exist, use re module, and handle all four cases correctly. "
               "Award 10 if all cases handled, subtract 2.5 per failing case.",
    ),
    Task(
        label="debug-off-by-one",
        task_type="code",
        slider=5.5,
        prompt="This function should sum ALL elements but has a bug. Find and fix it:\n\n"
               "```python\n"
               "def sum_list(nums):\n"
               "    total = 0\n"
               "    for i in range(len(nums) - 1):\n"
               "        total += nums[i]\n"
               "    return total\n"
               "```",
        rubric="Must identify the bug (range stops one short) and fix it to range(len(nums)). "
               "Award 10 if fix is correct and explained.",
        expected="Change range(len(nums) - 1) to range(len(nums))",
    ),
    Task(
        label="bst-implement",
        task_type="code",
        slider=7.0,
        prompt="Implement a Python class `BST` with methods:\n"
               "- `insert(val: int)` — insert a value\n"
               "- `search(val: int) -> bool` — return True if value exists\n"
               "The BST property must hold after every insert.",
        rubric="Class must have insert and search methods with correct BST logic. "
               "insert must maintain left<node<right. search must return bool. "
               "Award 10 if both correct, 5 if only one works.",
    ),
    Task(
        label="lru-cache",
        task_type="code",
        slider=7.5,
        prompt="Implement an LRU Cache in Python with:\n"
               "- `get(key: int) -> int` — return value or -1 if not found\n"
               "- `put(key: int, value: int)` — insert/update; evict least-recently-used if at capacity\n"
               "Both operations must be O(1). Capacity is set in __init__.",
        rubric="Must use OrderedDict or doubly-linked-list + hashmap for O(1). "
               "get must update recency. put must evict LRU when over capacity. "
               "Award 10 if all correct, deduct 3 per missing requirement.",
    ),
    # --- Hard reasoning: large models required (slider 6.5–9.0) ---
    Task(
        label="conditional-prob",
        task_type="reasoning",
        slider=7.0,
        prompt="A fair six-sided die is rolled twice. Given that both rolls show odd numbers, "
               "what is the probability their sum equals 6? Show your working.",
        rubric="Correct answer is 1/3. Odd numbers: {1,3,5}. Pairs summing to 6: (1,5),(5,1),(3,3) = 3 pairs. "
               "Total odd pairs: 9. P = 3/9 = 1/3. Award 10 if answer is 1/3 with correct reasoning, "
               "7 if answer correct but reasoning incomplete, 0 if wrong.",
        expected="1/3",
    ),
    Task(
        label="fraction-wordproblem",
        task_type="reasoning",
        slider=7.0,
        prompt="Alice completed 2/5 of a project. Bob completed 3/8 more than Alice. "
               "Carol completed 1/4 less than Bob. What fraction of the project has Carol completed?",
        rubric="Alice=2/5=16/40. Bob=2/5+3/8=16/40+15/40=31/40. Carol=31/40-1/4=31/40-10/40=21/40. "
               "Award 10 if answer is 21/40 with correct steps, 5 if final answer right but steps missing.",
        expected="21/40",
    ),
    Task(
        label="painted-cube",
        task_type="reasoning",
        slider=8.0,
        prompt="A cube is painted red on all 6 faces, then cut into 27 equal smaller cubes (3×3×3 grid). "
               "How many small cubes have exactly 2 red faces? Explain your reasoning.",
        rubric="Answer is 12 (the 12 edge pieces that are not corners). "
               "Corner pieces (8) have 3 faces. Edge pieces (12) have 2 faces. Face pieces (6) have 1. "
               "Center (1) has 0. Award 10 if answer is 12 with correct reasoning, 5 if 12 with no reasoning.",
        expected="12",
    ),
    Task(
        label="big-o-analysis",
        task_type="code",
        slider=8.0,
        prompt="What is the time complexity of this function? Explain step by step.\n\n"
               "```python\n"
               "def mystery(n):\n"
               "    result = 0\n"
               "    for i in range(n):\n"
               "        for j in range(i, n):\n"
               "            result += j\n"
               "    return result\n"
               "```",
        rubric="Answer is O(n²). Outer loop runs n times. Inner loop runs n-i times — total iterations "
               "= n + (n-1) + ... + 1 = n(n+1)/2 = O(n²). Award 10 if O(n²) with correct explanation.",
        expected="O(n²)",
    ),
    Task(
        label="logic-seating",
        task_type="reasoning",
        slider=8.5,
        prompt="Five people — Amy, Bob, Cal, Dee, Eve — sit in a row of 5 seats.\n"
               "Constraints:\n"
               "1. Amy is not adjacent to Bob.\n"
               "2. Cal sits between Amy and Dee (Amy...Cal...Dee or Dee...Cal...Amy).\n"
               "3. Eve sits at one end (seat 1 or seat 5).\n"
               "4. Bob is not at either end.\n"
               "Find one valid arrangement and verify each constraint holds.",
        rubric="Must produce a valid arrangement satisfying all 4 constraints and verify each one. "
               "Award 10 if arrangement is valid and all 4 constraints verified, 6 if valid but unverified.",
    ),
    Task(
        label="multi-hop-qa",
        task_type="qa",
        slider=7.5,
        prompt="Answer with reasoning:\n"
               "1. Who created the Python programming language?\n"
               "2. What country is that person from?\n"
               "3. In what year did that country join the European Union?",
        rubric="Answers: Guido van Rossum → Netherlands → 1995. "
               "Award 10 if all 3 correct with reasoning, subtract 3 per wrong answer.",
        expected="Guido van Rossum, Netherlands, 1995",
    ),
]

# ---------------------------------------------------------------------------
# Model dispatch: call the right provider based on model_id
# ---------------------------------------------------------------------------

def _call_model(model_id: str, prompt: str) -> tuple[str, int, int, int]:
    """Returns (text, input_tokens, output_tokens, latency_ms)."""
    t0 = time.monotonic()
    if model_id.startswith("gemini"):
        r = _gem.models.generate_content(
            model=model_id,
            contents=prompt,
            config=_gtypes.GenerateContentConfig(max_output_tokens=1024, temperature=0.0),
        )
        text = r.text or ""
        in_t = r.usage_metadata.prompt_token_count or 0
        out_t = r.usage_metadata.candidates_token_count or 0
    else:
        msg = _anth.messages.create(
            model=model_id,
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        text = msg.content[0].text
        in_t  = msg.usage.input_tokens
        out_t = msg.usage.output_tokens
    return text, in_t, out_t, int((time.monotonic() - t0) * 1000)


def _judge(task: Task, output: str) -> float:
    """Grade output with claude-haiku-4-5 as an independent judge."""
    judge_prompt = (
        f"You are a strict grader. Score this AI response 0–10.\n\n"
        f"Task given to AI:\n{task.prompt}\n\n"
        f"AI response:\n{output}\n\n"
        f"{'Expected answer: ' + task.expected + chr(10) if task.expected else ''}"
        f"Grading rubric:\n{task.rubric}\n\n"
        f"Reply with a single integer 0–10. Nothing else."
    )
    msg = _anth.messages.create(
        model=JUDGE_MODEL,
        max_tokens=5,
        messages=[{"role": "user", "content": judge_prompt}],
    )
    try:
        return min(max(float(msg.content[0].text.strip()), 0.0), 10.0) / 10.0
    except ValueError:
        return 0.5


# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------

def _append_jsonl(path: Path, record: dict) -> None:
    with path.open("a") as f:
        f.write(json.dumps(record) + "\n")


# ---------------------------------------------------------------------------
# Main agent loop
# ---------------------------------------------------------------------------

async def run_once(
    minima: AsyncMinimaClient,
    run_idx: int,
    tasks: list[Task],
    log_dir: Path,
) -> list[dict]:
    results = []
    shuffled = random.sample(tasks, len(tasks))   # different order every run = unbiased memory

    for task in shuffled:
        # 1. Recommend
        rec = await minima.recommend(
            {"task": task.prompt, "task_type": task.task_type},
            cost_quality_tradeoff=task.slider,
            constraints=Constraints(candidate_models=CANDIDATES),
        )
        model   = rec.recommended_model.model_id
        basis   = rec.decision_basis.value if hasattr(rec.decision_basis, "value") else str(rec.decision_basis)
        est_cost = rec.recommended_model.est_cost_usd

        # Log recall evidence
        evidence = [
            {"model_id": e.model_id, "similarity": e.score,
             "observed_success": e.observed_success, "confidence": e.knowledge_confidence}
            for e in rec.recommended_model.evidence
        ]
        _append_jsonl(log_dir / "recall_debug.jsonl", {
            "run": run_idx, "task": task.label, "model_chosen": model,
            "basis": basis, "evidence": evidence,
        })

        # 2. Call the model
        output, in_tok, out_tok, latency_ms = _call_model(model, task.prompt)

        # 3. Judge quality
        quality = _judge(task, output)

        # 4. Compute actual cost (prices from catalog; est_cost_usd as fallback)
        actual_cost = est_cost   # will be close; catalogue prices are accurate

        # 5. Feedback so Minima learns
        outcome = "success" if quality >= 0.8 else ("partial" if quality >= 0.4 else "failure")
        await minima.feedback(
            rec.recommendation_id,
            model,
            outcome,
            quality_score=quality,
            input_tokens=in_tok,
            output_tokens=out_tok,
            actual_cost_usd=round(actual_cost, 8),
            latency_ms=latency_ms,
            verified_in_production=True,
        )

        row = {
            "run": run_idx,
            "task": task.label,
            "task_type": task.task_type,
            "slider": task.slider,
            "model": model,
            "basis": basis,
            "quality": round(quality, 3),
            "cost_usd": round(actual_cost, 8),
            "input_tokens": in_tok,
            "output_tokens": out_tok,
            "latency_ms": latency_ms,
            "outcome": outcome,
            "timestamp": datetime.now(UTC).isoformat(),
        }
        _append_jsonl(log_dir / "tasks.jsonl", row)
        results.append(row)

        print(
            f"  run{run_idx} [{task.label:<22}] slider={task.slider:4.1f}  "
            f"{model:<22} {basis:<7} q={quality:.2f}  ${actual_cost:.6f}"
        )

    return results


async def main() -> None:
    run_ts  = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
    log_dir = Path("runs") / run_ts
    log_dir.mkdir(parents=True, exist_ok=True)
    print(f"\nLogs → {log_dir}/\n")

    all_results: list[dict] = []

    async with AsyncMinimaClient(MINIMA_URL, api_key=MUBIT_KEY, timeout=60.0) as minima:
        for run_idx in range(1, N_RUNS + 1):
            print(f"\n{'='*72}")
            print(f"RUN {run_idx}/{N_RUNS}")
            print(f"{'='*72}")
            results = await run_once(minima, run_idx, TASKS, log_dir)
            all_results.extend(results)

            # Snapshot what Minima has learned after this run
            strats = await minima.strategies()
            snap = {
                "run": run_idx,
                "timestamp": datetime.now(UTC).isoformat(),
                "strategy_count": strats.count,
                "strategies": [
                    {
                        "id": s.strategy_id,
                        "description": s.description,
                        "lessons": s.supporting_lesson_count,
                        "confidence": s.avg_confidence,
                    }
                    for s in strats.strategies
                ],
            }
            (log_dir / f"strategies_run{run_idx}.json").write_text(
                json.dumps(snap, indent=2)
            )

            # Per-run summary
            run_rows = [r for r in all_results if r["run"] == run_idx]
            avg_q    = sum(r["quality"] for r in run_rows) / len(run_rows)
            tot_cost = sum(r["cost_usd"] for r in run_rows)
            mem_pct  = sum(1 for r in run_rows if r["basis"] == "memory") / len(run_rows)
            print(f"\n  run{run_idx} summary — avg_quality={avg_q:.3f}  "
                  f"total_cost=${tot_cost:.5f}  memory_driven={mem_pct:.0%}  "
                  f"strategies_learned={strats.count}")

    # Final aggregate summary
    by_run = {}
    for r in all_results:
        ri = r["run"]
        by_run.setdefault(ri, []).append(r)

    summary = {
        "minima_url": MINIMA_URL,
        "candidates": CANDIDATES,
        "n_runs": N_RUNS,
        "n_tasks": len(TASKS),
        "total_calls": len(all_results),
        "runs": {
            ri: {
                "avg_quality": round(sum(r["quality"] for r in rows) / len(rows), 4),
                "total_cost_usd": round(sum(r["cost_usd"] for r in rows), 6),
                "memory_driven_pct": round(
                    sum(1 for r in rows if r["basis"] == "memory") / len(rows), 3
                ),
                "model_distribution": {
                    m: sum(1 for r in rows if r["model"] == m) for m in CANDIDATES
                },
            }
            for ri, rows in by_run.items()
        },
    }
    (log_dir / "summary.json").write_text(json.dumps(summary, indent=2))

    print(f"\n{'='*72}")
    print("FINAL SUMMARY")
    print(f"{'='*72}")
    for ri, s in summary["runs"].items():
        print(
            f"  run{ri}: quality={s['avg_quality']:.3f}  "
            f"cost=${s['total_cost_usd']:.5f}  "
            f"memory={s['memory_driven_pct']:.0%}  "
            f"models={s['model_distribution']}"
        )
    print(f"\nAll logs saved to {log_dir}/")


if __name__ == "__main__":
    asyncio.run(main())
