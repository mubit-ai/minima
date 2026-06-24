"""Escalation-learning warmup — does Minima learn to escalate to a premium model where the
cheap one FAILS, while keeping easy tasks cheap?

The prior varied-workload run (runs/warmupvary_20260615_123818) couldn't show this: every task
was easy, flash aced all of them, so there was no failure pressure. Here we use families
*calibrated* (flash-vs-pro probe) to separate the tiers:

  ESCALATION families — flash fails (~0.67), pro solves (1.00):  work-rate, lattice
  CONTROL families    — flash solves (1.00):                     anagram,  pct-chain

Design that isolates *learned* escalation:
  * ALL families share one task_type ("reasoning") and ONE slider (4.0), so the capability PRIOR
    cannot distinguish them — at flat priors + slider 4 the cheap model (flash) is the initial
    pick for everything.
  * Distinct instance per family per epoch (bounded difficulty so pro stays reliable), computable
    expected answers (reliable Haiku judge).
  Expectation: epoch 1 routes flash everywhere → flash FAILS the escalation families → that
  failure feedback makes recall down-weight flash there → later epochs escalate those to pro
  (quality rises), while controls stay on flash (cheap). Memory differentiates by learned outcome,
  not by prior.

    set -a; source .env; set +a
    WARMUP_NAMESPACE=escalate-20260615 uv run python examples/agent_escalation_learn.py
"""

from __future__ import annotations

import asyncio
import json
import math
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
SEED        = int(os.environ.get("WARMUP_SEED", "7"))
NAMESPACE   = os.environ.get("WARMUP_NAMESPACE", "escalate-learn")
N_EPOCHS    = int(os.environ.get("WARMUP_EPOCHS", "6"))
SLIDER      = float(os.environ.get("WARMUP_SLIDER", "5.0"))  # one notch below the "other" pro crossover (s6)
TASK_TYPE   = "other"                                        # cold prior picks FLASH here → flash gets tried

CANDIDATES = [
    "gemini-2.5-flash",
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "gemini-2.5-pro",
    "claude-opus-4-8",
]

_anth = _anthropic.Anthropic(api_key=ANTH_KEY)
_gem  = _genai.Client(api_key=GEMINI_KEY)

# ---- Bounded, distinct parametric instances (pro stays reliable; flash slips on the hard two) ----
_WR = [(3, 4, 6), (4, 6, 12), (3, 6, 9), (4, 5, 10), (5, 6, 8), (3, 8, 12), (4, 9, 18), (5, 7, 9)]
_LP = [(4, 3), (5, 3), (4, 4), (5, 4), (6, 4), (5, 5), (6, 5), (6, 3)]
_NAMES  = ["Alice", "Bob", "Carol", "Dan", "Eve", "Frank", "Grace", "Heidi", "Ivan", "Judy"]
_CITIES = ["New York", "Paris", "Tokyo", "Berlin", "Cairo", "Lima", "Oslo", "Delhi", "Rome", "Madrid"]


def gen_workrate(i: int):  # ESCALATION
    a, b, c = _WR[i % len(_WR)]
    t = 1 / (Fraction(1, a) + Fraction(1, b) - Fraction(1, c))
    ans = f"{t.numerator}/{t.denominator}"
    return (f"Pipe A fills a tank in {a} hours, pipe B in {b} hours, and a drain empties it in {c} "
            f"hours. With all three open, how many hours to fill the tank? Reply as a reduced fraction.",
            f"Correct answer is {ans} hours. Award 10 if {ans} (or an equal fraction) appears, else 0.", ans)


def gen_lattice(i: int):  # ESCALATION
    m, n = _LP[i % len(_LP)]
    ans = math.comb(m + n, m)
    return (f"On a grid, how many distinct monotonic lattice paths go from (0,0) to ({m},{n}) moving "
            f"only right or up? Reply with only the number.",
            f"Correct answer is {ans} = C({m + n},{m}). Award 10 if {ans} appears, else 0.", str(ans))


def gen_addmult(i: int):  # CONTROL (flash aces — proven 1.0 in the varied run)
    a, b, c = 7 + i, 4 + (i % 5), 13 + 2 * i
    ans = a * b + c
    return (f"Compute: {a} * {b} + {c}. Reply with only the final number.",
            f"Correct answer is {ans}. Award 10 if the response is {ans}, else 0.", str(ans))


def gen_csv(i: int):  # CONTROL (flash aces)
    name, age, city = _NAMES[i % len(_NAMES)], 20 + i, _CITIES[(i * 3) % len(_CITIES)]
    expected = f'{{"name": "{name}", "age": {age}, "city": "{city}"}}'
    return (f"Convert this CSV row to a JSON object.\nHeaders: name,age,city\nRow: {name},{age},{city}",
            f'JSON must have name="{name}", age={age} (integer), city="{city}". Award 10 if all correct, else 0.',
            expected)


# (family, role, generator)
FAMILIES = [
    ("work-rate",   "escalation", gen_workrate),
    ("lattice",     "escalation", gen_lattice),
    ("add-mult",    "control",    gen_addmult),
    ("csv-to-json", "control",    gen_csv),
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
          f"Expected: {expected}\nRubric: {rubric}\n\nSingle integer 0-10 only.")
    msg = _anth.messages.create(model=JUDGE_MODEL, max_tokens=5,
                                messages=[{"role": "user", "content": jp}])
    try:
        return min(max(float(msg.content[0].text.strip()), 0.0), 10.0) / 10.0
    except ValueError:
        return 0.5


def _append(path: Path, record: dict) -> None:
    with path.open("a") as f:
        f.write(json.dumps(record) + "\n")


async def _cold_probe(minima: AsyncMinimaClient) -> dict:
    """Confirm the fresh lane starts empty for recall (basis=prior, 0 evidence)."""
    probes = {}
    for fam, _, gen in FAMILIES:
        prompt, _, _ = gen(0)
        rec = await minima.recommend({"task": prompt, "task_type": TASK_TYPE},
                                     cost_quality_tradeoff=SLIDER,
                                     constraints=Constraints(candidate_models=CANDIDATES),
                                     namespace=NAMESPACE)
        basis = rec.decision_basis.value if hasattr(rec.decision_basis, "value") else str(rec.decision_basis)
        probes[fam] = {"basis": basis, "evidence": len(rec.recommended_model.evidence),
                       "model": rec.recommended_model.model_id}
    cold = all(p["evidence"] == 0 for p in probes.values())
    print("── Pre-flight cold probe ──────────────────────────────")
    for fam, p in probes.items():
        print(f"  {fam:<11} basis={p['basis']:<7} evidence={p['evidence']}  (→ {p['model']})")
    print(f"  Lane {'is COLD ✓' if cold else 'is NOT cold ✗ (recall already returns evidence)'}\n")
    return {"cold": cold, "probes": probes}


async def main() -> None:
    ts = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
    log_dir = Path("runs") / f"escalate_{ts}"
    log_dir.mkdir(parents=True, exist_ok=True)
    print(f"\nEscalation-learning warmup → {log_dir}/")
    print(f"Lane: minima:{NAMESPACE} | seed {SEED} | slider {SLIDER} (uniform) | "
          f"{len(FAMILIES)} families x {N_EPOCHS} epochs\n")

    all_rows: list[dict] = []
    per_epoch: dict[int, list[dict]] = {}

    async with AsyncMinimaClient(MINIMA_URL, api_key=MUBIT_KEY, timeout=60.0) as minima:
        probe = await _cold_probe(minima)
        (log_dir / "cold_probe.json").write_text(json.dumps(probe, indent=2))

        for epoch in range(1, N_EPOCHS + 1):
            order = list(FAMILIES)
            random.Random(SEED + epoch).shuffle(order)
            print(f"{'=' * 72}\nEPOCH {epoch}/{N_EPOCHS}\n{'=' * 72}")
            rows: list[dict] = []
            for family, role, gen in order:
                prompt, rubric, expected = gen(epoch - 1)
                rec = await minima.recommend({"task": prompt, "task_type": TASK_TYPE},
                                             cost_quality_tradeoff=SLIDER,
                                             constraints=Constraints(candidate_models=CANDIDATES),
                                             namespace=NAMESPACE)
                model = rec.recommended_model.model_id
                basis = rec.decision_basis.value if hasattr(rec.decision_basis, "value") else str(rec.decision_basis)
                est   = rec.recommended_model.est_cost_usd
                n_ev  = len(rec.recommended_model.evidence)

                output, in_t, out_t, lat = _call_model(model, prompt)
                quality = _judge(prompt, output, rubric, expected)
                outcome = "success" if quality >= 0.8 else ("partial" if quality >= 0.4 else "failure")

                await minima.feedback(rec.recommendation_id, model, outcome,
                                      quality_score=quality, input_tokens=in_t, output_tokens=out_t,
                                      actual_cost_usd=round(est, 8), latency_ms=lat, verified_in_production=True)

                row = dict(epoch=epoch, family=family, role=role, model=model, basis=basis,
                           n_evidence=n_ev, quality=round(quality, 3), cost_usd=round(est, 8),
                           outcome=outcome, expected=expected, timestamp=datetime.now(UTC).isoformat())
                _append(log_dir / "tasks.jsonl", row)
                rows.append(row); all_rows.append(row)
                tag = "ESC" if role == "escalation" else "ctl"
                print(f"  [{tag}] {family:<11} {model:<18} {basis:<7} ev={n_ev} "
                      f"q={quality:.2f} {outcome:<7} ${est:.6f}")
            per_epoch[epoch] = rows

    # ---------- Headline: per-family model+quality trajectory across epochs ----------
    print(f"\n{'=' * 72}\nESCALATION TRAJECTORY  (escalation families should shift flash→pro, q↑)\n{'=' * 72}")
    short = {"gemini-2.5-flash": "flash", "gemini-2.5-pro": "pro", "claude-sonnet-4-6": "sonnet",
             "claude-haiku-4-5": "haiku", "claude-opus-4-8": "opus"}
    from collections import defaultdict
    by_fam: dict = defaultdict(list)
    for r in all_rows:
        by_fam[r["family"]].append(r)
    print(f"{'family':<11} {'role':<10} " + " ".join(f"e{e}" for e in range(1, N_EPOCHS + 1)))
    for fam, role, _ in FAMILIES:
        rs = sorted(by_fam[fam], key=lambda r: r["epoch"])
        cells = " ".join(f"{short.get(r['model'], r['model'])[:5]}/{r['quality']:.1f}" for r in rs)
        print(f"{fam:<11} {role:<10} {cells}")

    # ---------- Did escalation pay off? quality & cost, escalation vs control ----------
    def agg(rows):
        return (sum(r["quality"] for r in rows) / len(rows), sum(r["cost_usd"] for r in rows))
    esc = [r for r in all_rows if r["role"] == "escalation"]
    ctl = [r for r in all_rows if r["role"] == "control"]
    eq, ec = agg(esc); cq, cc = agg(ctl)
    # escalation families: early (epoch 1) vs late (last epoch) quality — the learning signal
    e1 = [r for r in esc if r["epoch"] == 1]; eL = [r for r in esc if r["epoch"] == N_EPOCHS]
    print(f"\nEscalation families: avg_q={eq:.3f} cost=${ec:.5f} | "
          f"epoch1 q={sum(r['quality'] for r in e1)/len(e1):.2f} → epoch{N_EPOCHS} q={sum(r['quality'] for r in eL)/len(eL):.2f}")
    print(f"Control families:    avg_q={cq:.3f} cost=${cc:.5f}")

    summary = {
        "minima_url": MINIMA_URL, "namespace": NAMESPACE, "seed": SEED, "slider": SLIDER,
        "n_epochs": N_EPOCHS, "cold_lane": probe["cold"], "total_calls": len(all_rows),
        "by_family": {
            fam: {
                "role": role,
                "models_by_epoch": [short.get(r["model"], r["model"])
                                    for r in sorted(by_fam[fam], key=lambda x: x["epoch"])],
                "quality_by_epoch": [r["quality"] for r in sorted(by_fam[fam], key=lambda x: x["epoch"])],
                "avg_quality": round(sum(r["quality"] for r in by_fam[fam]) / len(by_fam[fam]), 3),
                "total_cost": round(sum(r["cost_usd"] for r in by_fam[fam]), 6),
            }
            for fam, role, _ in FAMILIES
        },
        "escalation_avg_quality": round(eq, 3), "escalation_total_cost": round(ec, 6),
        "control_avg_quality": round(cq, 3), "control_total_cost": round(cc, 6),
    }
    (log_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    print(f"\nSaved → {log_dir}/")


if __name__ == "__main__":
    asyncio.run(main())
