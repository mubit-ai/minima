"""Varied-workload warmup — paraphrase variant that should show a RISING learning curve.

Why this exists: the identical-task warmup (`agent_warmup.py`) showed memory-driven %
*declining* over runs (60→25%), because re-feeding the SAME 20 prompts means recall's best
match is each task's own near-identical prior record — which appears to be suppressed as a
near-duplicate, so routing falls back to `prior`. (See runs/20260615_101732/REPORT.md.)

The fix: present *distinct instances of the same task FAMILY* over time. Each family has a
parametric generator that emits a new, unique instance per epoch with a computable expected
answer (so the Haiku judge is reliable). When Minima recalls for epoch-e instance of a family,
it finds the e-1 earlier *similar-but-not-identical* instances → real evidence → `basis=memory`.
So memory-driven % should RISE epoch-over-epoch (the opposite of the identical-task run).

    set -a; source .env; set +a
    WARMUP_SEED=7 WARMUP_NAMESPACE=warmup-vary-20260615 \
    uv run python examples/agent_warmup_vary.py
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import time
from datetime import UTC, datetime
from fractions import Fraction
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
SEED        = int(os.environ.get("WARMUP_SEED", "7"))          # shuffles family order per epoch
NAMESPACE   = os.environ.get("WARMUP_NAMESPACE", "warmup-vary")  # fresh lane → isolated recall
N_EPOCHS    = int(os.environ.get("WARMUP_EPOCHS", "6"))        # one new instance per family/epoch

CANDIDATES = [
    "gemini-2.5-flash",
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "gemini-2.5-pro",
    "claude-opus-4-8",
]

_anth = _anthropic.Anthropic(api_key=ANTH_KEY)
_gem  = _genai.Client(api_key=GEMINI_KEY)

# ---------------------------------------------------------------------------
# Parametric task families. gen(i) -> (prompt, rubric, expected) for instance i.
# Distinctness: every gen is a deterministic function of i, with params that vary with i, so
# no two instances (within or across epochs) are identical. Difficulty spans easy→hard so the
# router has a real per-family tier decision (cheap flash vs premium) to learn.
# ---------------------------------------------------------------------------

_NAMES  = ["Alice", "Bob", "Carol", "Dan", "Eve", "Frank", "Grace", "Heidi", "Ivan", "Judy"]
_CITIES = ["New York", "Paris", "Tokyo", "Berlin", "Cairo", "Lima", "Oslo", "Delhi", "Rome", "Madrid"]


def gen_addmult(i: int):  # easy arithmetic
    a, b, c = 7 + i, 4 + (i % 5), 13 + 2 * i
    ans = a * b + c
    return (f"Compute: {a} * {b} + {c}. Reply with only the final number.",
            f"Correct answer is {ans}. Award 10 if the response is {ans}, else 0.", str(ans))


def gen_spam(i: int):  # easy classification (alternates spam/ham)
    if i % 2 == 0:
        p = (f"Is this email spam? Reply with exactly one word: Spam or Ham.\n\n"
             f"'URGENT!! You have WON ${(i + 1) * 1000}!!! Click http://prize-{i}.biz NOW to claim!!!'")
        return p, "Award 10 if the reply is exactly 'Spam', else 0.", "Spam"
    name = _NAMES[i % len(_NAMES)]
    p = (f"Is this email spam? Reply with exactly one word: Spam or Ham.\n\n"
         f"'Hi {name}, can we move our 1:1 to {3 + i}pm on Thursday? Thanks.'")
    return p, "Award 10 if the reply is exactly 'Ham', else 0.", "Ham"


def gen_csv(i: int):  # easy extraction
    name, age, city = _NAMES[i % len(_NAMES)], 20 + i, _CITIES[(i * 3) % len(_CITIES)]
    expected = f'{{"name": "{name}", "age": {age}, "city": "{city}"}}'
    return (f"Convert this CSV row to a JSON object.\nHeaders: name,age,city\nRow: {name},{age},{city}",
            f'JSON must have name="{name}", age={age} (integer), city="{city}". Award 10 if all correct, else 0.',
            expected)


def gen_reverse(i: int):  # easy transform
    lst = [(i + k * 7) % 100 for k in range(5 + (i % 3))]
    rev = lst[::-1]
    return (f"Reverse this list and reply with ONLY the reversed list: {lst}",
            f"Correct reversed list is {rev}. Award 10 if the response equals {rev}, else 0.", str(rev))


def gen_cube(i: int):  # medium-hard reasoning (answer = 12*(n-2))
    n = 3 + i
    ans = 12 * (n - 2)
    return (f"A cube is painted red on all 6 faces, then cut into {n}x{n}x{n} = {n ** 3} equal "
            f"smaller cubes. How many small cubes have exactly 2 red faces? Reply with the number "
            f"and a brief reason.",
            f"Correct answer is {ans} (12 edges x (n-2)={n - 2}). Award 10 if {ans} appears, "
            f"5 if reasoning is right but the number is off, else 0.", str(ans))


def gen_fracadd(i: int):  # medium reasoning (exact fraction)
    a, b, c, d = 2 + i, 3 + 2 * i, 1 + i, 4 + i
    tot = Fraction(a, b) + Fraction(c, d)
    ans = f"{tot.numerator}/{tot.denominator}"
    return (f"What is {a}/{b} + {c}/{d}? Reply as a single reduced fraction (e.g. 3/4).",
            f"Correct reduced answer is {ans}. Award 10 if {ans} appears, 5 if an unreduced "
            f"equivalent appears, else 0.", ans)


def gen_modpow(i: int):  # medium reasoning
    a, b, m = 2 + (i % 5), 3 + (i % 4), 7 + (i % 6)
    ans = pow(a, b, m)
    return (f"Compute {a}^{b} mod {m}. Reply with only the number.",
            f"Correct answer is {ans}. Award 10 if the response is {ans}, else 0.", str(ans))


def gen_bigo(i: int):  # medium-hard code (k nested loops -> O(n^k))
    k = 2 + (i % 3)
    loops = "".join("    " * (j + 1) + f"for i{j} in range(n):\n" for j in range(k))
    code = f"def f(n):\n    x = 0\n{loops}{'    ' * (k + 1)}x += {i + 1}\n    return x"
    ans = f"O(n^{k})"
    return (f"What is the time complexity of this function? Reply with Big-O (e.g. O(n), O(n^2)).\n\n"
            f"```python\n{code}\n```",
            f"Correct answer is {ans} ({k} nested loops, each n iterations). Award 10 if {ans} "
            f"(or O(n**{k})) is stated, else 0.", ans)


# (family, task_type, slider, generator). Sliders set the *requested* quality bar; memory may
# override. Easy families low slider (flash should win); hard families high slider.
FAMILIES = [
    ("add-mult",     "reasoning",      2.0, gen_addmult),
    ("spam-detect",  "classification", 2.0, gen_spam),
    ("csv-to-json",  "extraction",     2.0, gen_csv),
    ("list-reverse", "other",          3.0, gen_reverse),
    ("painted-cube", "reasoning",      7.0, gen_cube),
    ("frac-add",     "reasoning",      5.0, gen_fracadd),
    ("mod-pow",      "reasoning",      5.0, gen_modpow),
    ("big-o",        "code",           7.0, gen_bigo),
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
    jp = (f"You are a strict grader. Score 0-10.\n\nTask: {prompt[:500]}\nAI response: {output[:800]}\n"
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
    log_dir = Path("runs") / f"warmupvary_{ts}"
    log_dir.mkdir(parents=True, exist_ok=True)
    print(f"\nVaried-workload warmup → {log_dir}/")
    print(f"Memory lane: minima:{NAMESPACE}  |  seed: {SEED}  |  "
          f"{len(FAMILIES)} families x {N_EPOCHS} epochs = {len(FAMILIES) * N_EPOCHS} tasks\n")

    all_rows: list[dict] = []
    per_epoch: dict[int, list[dict]] = {}

    async with AsyncMinimaClient(MINIMA_URL, api_key=MUBIT_KEY, timeout=60.0) as minima:
        for epoch in range(1, N_EPOCHS + 1):
            order = list(FAMILIES)
            random.Random(SEED + epoch).shuffle(order)
            print(f"{'=' * 72}\nEPOCH {epoch}/{N_EPOCHS}  (instance #{epoch} of each family)\n{'=' * 72}")
            rows: list[dict] = []

            for family, task_type, slider, gen in order:
                prompt, rubric, expected = gen(epoch - 1)  # 0-based instance index, distinct per epoch

                rec = await minima.recommend(
                    {"task": prompt, "task_type": task_type},
                    cost_quality_tradeoff=slider,
                    constraints=Constraints(candidate_models=CANDIDATES),
                    namespace=NAMESPACE,
                )
                model = rec.recommended_model.model_id
                basis = rec.decision_basis.value if hasattr(rec.decision_basis, "value") else str(rec.decision_basis)
                est   = rec.recommended_model.est_cost_usd
                n_ev  = len(rec.recommended_model.evidence)

                output, in_t, out_t, lat = _call_model(model, prompt)
                quality = _judge(prompt, output, rubric, expected)
                outcome = "success" if quality >= 0.8 else ("partial" if quality >= 0.4 else "failure")

                await minima.feedback(
                    rec.recommendation_id, model, outcome,
                    quality_score=quality, input_tokens=in_t, output_tokens=out_t,
                    actual_cost_usd=round(est, 8), latency_ms=lat, verified_in_production=True,
                )

                row = dict(epoch=epoch, family=family, task_type=task_type, slider=slider,
                           model=model, basis=basis, n_evidence=n_ev, quality=round(quality, 3),
                           cost_usd=round(est, 8), expected=expected,
                           timestamp=datetime.now(UTC).isoformat())
                _append(log_dir / "tasks.jsonl", row)
                rows.append(row); all_rows.append(row)
                print(f"  [{family:<13}] slider={slider:4.1f}  {model:<18} {basis:<7} "
                      f"ev={n_ev}  q={quality:.2f}  ${est:.6f}")

            per_epoch[epoch] = rows
            mem = sum(1 for r in rows if r["basis"] == "memory") / len(rows)
            avg_q = sum(r["quality"] for r in rows) / len(rows)
            cost = sum(r["cost_usd"] for r in rows)
            print(f"\n  epoch{epoch}: memory_driven={mem:.0%}  avg_quality={avg_q:.3f}  cost=${cost:.5f}\n")

    # ---- The headline: memory-driven curve (should RISE, vs the identical-task run's decline) ----
    print(f"{'=' * 72}\nMEMORY-DRIVEN CURVE  (expect RISE; identical-task run fell 60→25%)\n{'=' * 72}")
    print(f"{'EPOCH':>6}  {'MEMORY%':>8}  {'AVG_Q':>7}  {'COST':>10}  {'AVG_EVIDENCE':>13}")
    epoch_summary = {}
    for e in range(1, N_EPOCHS + 1):
        rows = per_epoch[e]
        mem = sum(1 for r in rows if r["basis"] == "memory") / len(rows)
        avg_q = sum(r["quality"] for r in rows) / len(rows)
        cost = sum(r["cost_usd"] for r in rows)
        ev = sum(r["n_evidence"] for r in rows) / len(rows)
        print(f"{e:>6}  {mem:>7.0%}  {avg_q:>7.3f}  ${cost:>9.5f}  {ev:>13.1f}")
        epoch_summary[e] = dict(memory_driven_pct=round(mem, 3), avg_quality=round(avg_q, 4),
                                cost_usd=round(cost, 6), avg_evidence=round(ev, 2))

    # Per-family trajectory: does each family converge to a stable model / quality?
    from collections import defaultdict
    by_family: dict = defaultdict(list)
    for r in all_rows:
        by_family[r["family"]].append(r)
    family_summary = {
        fam: dict(
            avg_quality=round(sum(r["quality"] for r in rs) / len(rs), 3),
            total_cost=round(sum(r["cost_usd"] for r in rs), 6),
            memory_driven_pct=round(sum(1 for r in rs if r["basis"] == "memory") / len(rs), 3),
            models=sorted({r["model"] for r in rs}),
        )
        for fam, rs in by_family.items()
    }

    (log_dir / "summary.json").write_text(json.dumps({
        "minima_url": MINIMA_URL, "namespace": NAMESPACE, "seed": SEED,
        "n_epochs": N_EPOCHS, "families": [f[0] for f in FAMILIES],
        "total_calls": len(all_rows),
        "epochs": epoch_summary, "by_family": family_summary,
    }, indent=2))
    print(f"\nSaved → {log_dir}/")


if __name__ == "__main__":
    asyncio.run(main())
