# Classifier A/B — is the embed head earning its place?

**Artifact:** `potion-base-32M-c18e819c6c6d` · **Pre-registration:** `58c020a`
(`scripts/eval/classifier_ab/PREREG.md`, committed before any arm ran)
**Date:** 2026-07-27 · **Spend:** $0 (no LLM calls; RouterBench and SNI both ship the labels)

---

## Verdict — RETUNE, and the head does not currently earn its place

On out-of-corpus benchmark data the shipped head is **significantly worse than the regex it
replaced**, and the loss is caused by its abstention thresholds, not by the embedding.

| Pre-registered decision rule | Status |
|---|---|
| **KEEP AS-IS** | ❌ fails — `Δ` CI lies entirely below 0 |
| **RETUNE tau** | ✅ **triggered** — held-out macro-F1 rises 0.279 → 0.363 by retuning alone |
| **PULL** | ⚠️ first clause met (`Δ` CI upper bound = −0.065 ≤ 0); resolution depends on Leg B |

**Retune first — it is strictly necessary and cheap.** But do not read it as a rescue: the
retuned head only *ties* the regex, and it does so by abstaining on 83 % of prompts. Its
remaining confident predictions are half `translation`, a class the regex gets at F1 0.999
(§5). On this distribution the head has **no demonstrated residual value** over the regex.

### The primary endpoint

> **Δ = macro-F1(A3b) − macro-F1(A2) = −0.0865, 95 % CI [−0.1075, −0.0653]**
> paired bootstrap, 10 000 resamples over 2 609 prompts. `P(Δ > 0) = 0.000`.

The head costs **8.7 macro-F1 points** versus vocabulary+regex on data it did not train on.

Two things this does **not** say, both important:

- **Accuracy is a statistical tie.** 0.311 vs 0.319, McNemar exact **p = 0.49**. The head is
  not making more mistakes — it is making *differently distributed* mistakes. Macro-F1 falls
  because the regex concentrates its correct answers in a few classes it fires on
  confidently, while the head spreads errors across all eleven.
- **The embedding is not the problem.** See the retune result below.

---

## 1. What was measured, and why it is trustworthy

| Guard | Result |
|---|---|
| **S1** oracle arm scores 1.0 by construction | ✅ PASS |
| **S2** A1 reproduces `infer_task_type` exactly | ✅ PASS |
| **S3** A2 emits zero `embedding` sources; matches A1 off the vocabulary tier | ✅ PASS |
| **S4** A3a ≡ A3b | ✅ PASS — **0.0000 delta, 0.000 disagreement** |
| **S5** local head == prod head | ✅ PASS — **ID match, 100/100 agreement** with `api.minima.sh` |
| **S6** re-run determinism | ✅ PASS |
| Contamination | 3 rows of 2 810 dropped (0.1 %) |

**Dataset.** Super-NaturalInstructions, 2 609 labelled prompts across 437 tasks and 7 Minima
types, plus 198 deliberately unmappable rows. SNI is in none of the head's training sources
(curated seeds + CLINC150 + RouterBench), which is the whole point: RouterBench cannot answer
this question, because it *is* training data and its `eval_name → task_type` map is the same
function that labelled those training rows.

**Prod parity is exact.** A live probe of `api.minima.sh/v1/recommend` reproduces the local
head on 100/100 prompts, including its failures — e.g. *"rewrite a sentence in simple English
without changing its general meaning"* returns `final_task_type: translation`,
`task_type_source: embedding`, in production, right now.

---

## 2. The headline finding: `regex_hint` is dead code for this artifact

Inspection of `head.npz` **before** any evaluation (recorded in PREREG §0):

```
regex_classes  []      regex_scale  0.0      coef (11, 512)
```

`classify_embed.py` appends the regex one-hot only `if self._regex_classes:`, which is empty,
and `coef` carries exactly the 512 embedding dims with no extra feature columns. So the
`regex_hint=heuristic_task_type` passed at `classify.py:572` is **discarded**.

Gate S4 confirms it empirically: A3a and A3b agree on **2 609/2 609** prompts, Δ = 0.0000.

Consequences:

- The plumbing that computes and passes the hint is wasted work on every classify call.
- Any belief that "the head is scored against its own input" is **false for this artifact** —
  the head's features are pure embeddings, so head-vs-regex is a fair comparison.
- If the training script's `regex_classes` capability was meant to be in use, **it silently
  is not**, and no test covers the difference.

## 3. The vocabulary tier is nearly inert

A2 − A1 = **−0.0028** [−0.0055, −0.0006], disagreement **0.4 %**. `high_precision_type` fires
on 0.5 % of SNI prompts and, where it fires, is very slightly net-negative. It is not carrying
the tiering.

---

## 4. Where the head actually loses

| Arm | macro-F1 | accuracy | → `other` | abstain | p50 |
|---|---|---|---|---|---|
| A1 regex only | **0.3810** | 0.3204 | 47.3 % | — | 0.32 ms |
| A2 vocabulary + regex | **0.3783** | 0.3185 | 47.2 % | — | 0.33 ms |
| A3a/A3b head (shipped) | **0.2917** | 0.3112 | 10.2 % | 1.8 % | 0.46 ms |
| A5 gold oracle | 1.0000 | 1.0000 | — | — | — |

Per-class F1, head vs regex:

| class | regex | head | |
|---|---|---|---|
| translation | **0.999** | 0.705 | head loses 0.29 |
| summarization | **0.603** | 0.302 | head loses 0.30 |
| qa | **0.450** | 0.238 | head loses 0.21 |
| classification | **0.404** | 0.371 | ~tie |
| reasoning | 0.118 | **0.375** | head gains 0.26 |
| extraction | 0.061 | 0.005 | both fail |
| creative | 0.033 | 0.047 | both fail |

The head's error modes are semantically adjacent but operationally wrong:

- *"rewrite a sentence in simple English"*, *"paraphrase the given sentence"* → **translation**
  (94 rows). Text-in/text-out neighbours in embedding space; different routing tier.
- *"answer a simple science question"* → **reasoning** (196 rows).
- *"recognize the name of the drug"*, *"find the most critical location"* → **qa** (77 rows).
- It invents `code` on 171 rows where no `code` gold exists at all.

**Churn is enormous.** `churn_replay.py` over the same set: **74.3 % of all rows relabelled**,
**59.6 % among regex-non-`other` rows** — 4× the tool's own 15 % review threshold. Top moves:
`other→reasoning` (419), `other→code` (171), `other→translation` (156), `qa→reasoning` (114).

**Ambiguity handling is worse, not better.** On the 198 deliberately unmappable prompts the
regex routes 60.6 % to `other`; the head routes 14.6 % and abstains on 2.0 %. It confidently
types prompts that have no defensible type.

**The verdict is not an artifact of my gold map.** Dropping the six categories I flagged as
most contestable *widens* the gap: Δ = **−0.1166** [−0.1399, −0.0935].

---

## 5. Why this is a RETUNE, not a PULL — the risk–coverage result

Thresholds selected on a validation half and reported on a held-out half, **split by task**
(rows from one SNI task share a `Definition`; a row-level split would leak).

| Held-out (n ≈ 1 300) | coverage | selective acc | system macro-F1 |
|---|---|---|---|
| shipped `tau_dist=0.860, tau_margin=0.0088` | 98.7 % | 0.302 | **0.279** |
| regex only | — | — | **0.356** |
| retuned `tau_dist=0.638, tau_margin=0.802` | 17.2 % | **0.636** | **0.363** |

Read this carefully — and read the caveat under it, which is the single most important
paragraph in the report:

1. **The shipped thresholds are far too permissive off-distribution.** The head answers 98.7 %
   of prompts at 30 % accuracy. Conformal calibration at α = 0.05 was fit on the training
   distribution and **does not transfer** — measured false-abstain is 1.8 %, comfortably inside
   the G1e gate, while real error is ~70 %. The gate passes and the classifier is still wrong.
2. **Retuning recovers the regression** (+0.084 macro-F1 over shipped) but only **ties** the
   regex (0.363 vs 0.356) — because the optimal policy is to abstain on **83 % of prompts**,
   i.e. to mostly *be* the regex.

### The caveat: the confidence signal is almost entirely `translation`

The selective-accuracy jump (0.302 → 0.636) looks like "the head knows when it is out of its
depth". It is not. Of the 468 rows the retuned head still answers, **231 (49 %) are gold
`translation`** — a class separable on script and vocabulary alone, and one the regex already
gets at **F1 0.999**.

| slice | n | accuracy |
|---|---|---|
| retuned-covered, all classes | 468 | 0.656 |
| retuned-covered, **excluding `translation` gold** | 237 | **0.321** |
| all rows at shipped tau (for reference) | 2 609 | 0.315 |
| all rows, **excluding `translation` gold**, shipped tau | 2 209 | **0.214** |

Outside translation, high confidence buys **nothing** — 0.321 selective versus 0.315 at full
coverage. So the honest statement is: *the head's confidence ranking is informative for exactly
one class, which the regex already handles better.* Retuning stops the bleeding; it does not
produce a head with demonstrated value on this distribution.

---

## 6. Leg B — downstream routing impact

*(RouterBench, home-field/contaminated. Pending — see §8.)*

---

## 7. Two defects found along the way

1. **The G1 gate suite passes while the head regresses.** All **7 of 7** gates pass against
   this artifact (`pytest -m eval tests/eval/test_classifier_gates.py`), including
   `test_g1g_beats_regex_baseline` and the G1e false-abstain bound — at the same time as the
   head loses 8.7 macro-F1 points to the regex on out-of-corpus data. G1g compares 118 rows
   with no CI and no paired test; on 2 609 out-of-corpus rows the same comparison reverses
   sign with a CI nowhere near zero. **A green gate suite is currently not evidence that the
   head beats the regex**, which is the governance problem worth fixing first.
2. **`scripts/classifier/churn_replay.py` was replaying a configuration prod never serves** —
   no `regex_hint` and no vocabulary tier. Fixed here with `--no-regex-hint` / `--no-vocab`,
   both defaulting to the production path. (For this artifact the difference is 0.1 pp,
   because of §2 — but that is luck, not design.)

---

## 8. Limitations — read before acting

1. **Register shift.** SNI is instruction-manual prose ("In this task, you are given…"), not
   conversational user traffic. The head's corpus deliberately targets the latter. This is the
   single biggest reason to treat §4 as "the head does not generalize to *this* distribution"
   rather than "the head is bad everywhere".
2. **Coverage.** SNI yields no reliable `code`, `rag`, `tool_use`, or `other` gold. The verdict
   covers **7 of 11 types**, and `code` — plausibly Minima's highest-traffic type — is absent.
3. **The 76→11 map is mine** (`category_map.py`, frozen at `58c020a`). Mitigated by the
   sensitivity analysis (§4) and by per-category reporting, not eliminated.
4. **Absolute numbers are not the point.** Every arm scores badly here (~0.32 accuracy). The
   *difference* between arms is the quantity of interest; the absolute level partly reflects
   the map and the register.

## 9. Recommended next steps

1. **Retune the conformal thresholds against a mixed-distribution calibration set**, not just
   the training distribution — the shipped point is indefensible off-distribution. Treat this
   as damage control, not a fix: §5 shows the retuned head only ties the regex.
2. **Fix the gate suite before anything else.** 7/7 green while the head loses 8.7 macro-F1
   points is a measurement failure, and it will hide the next regression too. Replace G1g with
   a powered, CI-bearing, out-of-corpus comparison, and add a non-`translation` slice — the
   head's aggregate numbers are propped up by one trivially-separable class.
3. **Delete the `regex_hint` plumbing or start using it.** Right now it is computed, passed,
   and discarded on every call (§2).
4. **Get a `code`-bearing clean eval set** before any keep/pull decision is final — `code` is
   plausibly the highest-traffic type and this evaluation cannot see it.
5. **Investigate `→ translation` and `→ reasoning` as attractor classes** — 419 `other→reasoning`
   moves and a paraphrase→translation confusion look like a class-prior or anchor problem, and
   they are the specific defects a retrain would need to target.

---

### Reproduce

```bash
uv sync --extra dev --extra seed
S=reports/data
uv run python scripts/eval/classifier_ab/build_index.py --cache .cache/sni --out $S/sni_index.json
uv run python scripts/eval/classifier_ab/sample.py --index $S/sni_index.json --cache .cache/sni --out $S/eval_set.jsonl
uv run python scripts/eval/classifier_ab/contamination.py --eval-set $S/eval_set.jsonl --out $S/sni_eval_set.jsonl --report $S/contamination.json
uv run python scripts/eval/classifier_ab/intrinsic.py     --eval-set $S/sni_eval_set.jsonl --artifact models/classifier/potion-base-32M-c18e819c6c6d --out $S/intrinsic.json
uv run python scripts/eval/classifier_ab/risk_coverage.py --eval-set $S/sni_eval_set.jsonl --artifact models/classifier/potion-base-32M-c18e819c6c6d --out $S/risk_coverage.json
uv run python scripts/eval/classifier_ab/prod_parity.py   --eval-set $S/sni_eval_set.jsonl --artifact models/classifier/potion-base-32M-c18e819c6c6d --out $S/prod_parity.json
```
