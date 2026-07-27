# Classifier A/B — is the embed head earning its place?

**Artifact:** `potion-base-32M-c18e819c6c6d` · **Pre-registration:** `58c020a`
(`scripts/eval/classifier_ab/PREREG.md`, committed before any arm ran)
**Date:** 2026-07-27 · **Spend:** $0 (no LLM calls; RouterBench and SNI both ship the labels)

---

## Verdict — the head does not earn its place, and no configuration of it does

> **Superseded 2026-07-28.** The first round of this report closed at **RETUNE**. The follow-up
> round (§10–§13) **falsified that verdict**: retuning was tested properly and there is no
> reachable operating point where the head beats the stack it replaced, and class-competence
> routing does not rescue it either. RETUNE is not an available remedy. The original §5 and §9
> are left in place with correction notes, so what changed and why is auditable.

On out-of-corpus benchmark data the shipped head is **significantly worse than the regex it
replaced**. Three independent remedies were pre-registered and tested; all three failed.

| Pre-registered decision rule | Status |
|---|---|
| **KEEP AS-IS** | ❌ fails — `Δ` CI lies entirely below 0 |
| **RETUNE tau** | ❌ **falsified in round 2** (§10). Best reachable point: Δ = +0.0045, CI [−0.0073, +0.0170], P(Δ>0)=0.765 — indistinguishable from deleting the head |
| **ROUTE, don't replace** (A6, §12) | ❌ every deny-set variant loses; primary Δ = −0.0595, CI [−0.0845, −0.0346] |
| **PULL** | ⚠️ both clauses now met on this evidence; **still not dischargeable** — Leg B is blocked by an infrastructure defect (§13), and `code` is unmeasured (§8) |

**What the evidence supports today:** the head contributes nothing measurable over
vocabulary+regex on out-of-corpus prose, and cannot be configured to. What it does **not**
support is a final pull decision, for two stated reasons — 4 of 11 classes have no gold here,
including `code`; and the downstream cost/quality question remains unanswerable until hosted
recall is fixed. The honest position is **stop investing in this artifact, measure `code`, and
decide** (§16). Scorecard of every pre-registered prediction, including the two of mine that
failed: **§15**.

### The primary endpoint

> **Δ = macro-F1(A3b) − macro-F1(A2) = −0.0865, 95 % CI [−0.1075, −0.0653]**
> paired bootstrap, 10 000 resamples over 2 609 prompts. `P(Δ > 0) = 0.000`.

The head costs **8.7 macro-F1 points** versus vocabulary+regex on data it did not train on.

Two things this does **not** say, both important:

- **Accuracy is a statistical tie.** 0.311 vs 0.319, McNemar exact **p = 0.49**. The head is
  not making more mistakes — it is making *differently distributed* mistakes. Macro-F1 falls
  because the regex concentrates its correct answers in a few classes it fires on
  confidently, while the head spreads errors across all eleven.
- **It is not simply "the thresholds".** Round 1 read the risk–coverage curve as implicating
  abstention alone. §10 tests that directly and it does not hold up.

---

## 1. What was measured, and why it is trustworthy

| Guard | Result |
|---|---|
| **S1** oracle arm scores 1.0 by construction | ✅ PASS |
| **S2** A1 reproduces `infer_task_type` exactly | ✅ PASS |
| **S3** A2 emits zero `embedding` sources; matches A1 off the vocabulary tier | ✅ PASS |
| **S4** A3a ≡ A3b | ✅ PASS — **0.0000 delta, 0.000 disagreement** |
| **S5** local head == prod head | ✅ PASS — **ID match, 100/100 agreement** with `api.minima.sh` |
| **S6** re-run determinism | ✅ PASS — re-ran end to end; gates, primary, sensitivity and unmappable blocks bit-identical (latency excluded, wall-clock) |
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

## 5. The risk–coverage result — *and why round 2 overturned the conclusion I drew from it*

> **Correction (2026-07-28).** This section's numbers stand; the verdict I drew from them does
> not. "Retuning recovers the regression" was a point estimate with no CI. §10 re-ran the sweep
> with an honest calibration/held-out split and a paired bootstrap: **Δ = +0.0045, CI
> [−0.0073, +0.0170]** — the +0.007 below is inside noise. Read this section as the
> *observation*; read §10 as the *test*.

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

## 6. Leg B — downstream routing impact: **blocked, not null**

The seam works. The infrastructure did not hold. Reporting this as inconclusive rather than
dressing a partial run as a result.

**What was built.** `prepare_rows()` now takes a `classify` hook (`tests/eval/harness.py`), so
an arm's classifier assigns `task_type` from the prompt text instead of the dataset name. That
propagates into the cluster key — and therefore into seeding and recall — and into the
per-task-type capability priors. Each arm gets its own Mubit lane, seeded with its own keys,
because memory seeded under A1's keys is invisible to A3a.

**What happened.**

| Arm | cost | acc | savings | retention | evidence/prompt | **V5 crosscheck** |
|---|---|---|---|---|---|---|
| A1 regex | $0.0592 | 0.692 | 57.9 % | 81.8 % | 46.7 *(11.7/model ✓)* | **0.50 ✗** |
| A3a head *(retry, own process)* | $0.0093 | 0.338 | 93.4 % | 40.0 % | 7.3 *(1.8/model ✗)* | **0.25 ✗** |
| A5 oracle | — | — | — | — | — | failed — Mubit `ServerError` |

**Neither arm clears the pre-registered guards.** Both fail V5 (floor 0.80); A3a additionally
fails the ≥ 8 evidence/model floor at 1.8. **There is therefore no downstream claim here in
either direction** — in particular, A3a's 93.4 % "savings" at 40 % retention is what an
evidence-starved router does (collapse to the cheapest model), not a finding about the head.

### Two classifier-side explanations, tested and rejected

The 6.4× evidence-density gap between arms is the obvious thing to blame on the head. It does
not survive:

| Hypothesis | Test | Result |
|---|---|---|
| The head's labels are *unstable*, so semantically similar tasks land in different cells and memory never accumulates | modal-label share within each RouterBench `eval_name` family, 1 200 rows | **Rejected** — the head is *more* stable: **91.5 %** vs the regex's 89.3 % |
| The head *fragments* the cluster key space into more, smaller cells | distinct `task_type:difficulty` keys and concentration, 1 200 rows | **Rejected** — **17 keys each**; largest cell 46.4 % (head) vs 51.7 % (regex) |

With both rejected, the remaining explanation for the gap is server-side variance between the
two runs — the same non-determinism and throttling measured directly below. **Leg B measured
the infrastructure, not the classifier.**

**Why the crosscheck fails, and it is not the classifier.** Hosted Mubit recall is
**non-deterministic**: identical query, identical lane, repeated back-to-back returned 16, 13,
16 evidence rows (and 1, 3, 7 on the seed lane). The crosscheck compares a pick made from
recall cached once against a pick the engine makes from a *fresh* recall. When the two recalls
differ, the picks differ — so V5 cannot reach 0.8 regardless of which classifier is in the
loop. That is an evaluation-infrastructure defect, and it blocks *any* downstream routing
experiment, not just this one.

The failure is also load-shaped: the first arm of a process succeeds, subsequent arms get
`ServerError`. Seeding ~800–1200 records per lane appears to exhaust something server-side.
Recall latency is ~4–5 s per call, so a 4-arm run is ~30 min of almost pure network wait.

### Deviation from pre-registration (§7 guard 3)

The pre-registration required asserting `decision_basis == "memory"` on every request. **That
guard is not implementable on the path it was written for**: the harness's headline runs
through `_score_picks`/`_pick`, the factored scorer, which never constructs a
`RecommendResponse` and so never produces `decision_basis`. Only `_crosscheck` invokes the real
engine. The applicable substitutes were used instead — evidence/model ≥ 8 (**met**, 11.7) and
the V5 crosscheck ≥ 0.8 (**failed**, 0.50). This was my specification error, not a silent skip.

### What Leg B would need to be conclusive

1. Fix or characterize recall non-determinism, or make the crosscheck compare like with like
   (score the engine against the *same* recall the factored path used).
2. One arm per process, with a cooldown between lanes, or a local Mubit instead of hosted.
3. Only then is a head-vs-regex downstream comparison meaningful.

**Consequence for the verdict:** the pre-registered **PULL** rule requires "Leg B shows no cost
or quality gain". Leg B shows *nothing* either way, so PULL cannot be discharged.

> **Update (2026-07-28).** The "RETUNE" fallback recorded here was itself falsified in §10.
> The root cause of the Leg B failure was probed directly and is **not** the classifier and
> **not** the ricedb bug it was attributed to — see §13 and `reports/recall-blocker.md`.

---

## 7. Defects found along the way

*Status after round 2: 1 and 4 are **fixed** (§11, and the commit for the tokenizer); 2 was
fixed in round 1; 3 is **re-diagnosed** in §13 — the "non-determinism" is real but its cause was
misattributed here.*

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
3. **The V5 crosscheck cannot pass while hosted recall is non-deterministic.** It scores a pick
   made from cached recall against a pick the engine makes from a fresh recall; identical
   queries return different evidence sets (16/13/16 on one lane, 1/3/7 on another), so the two
   disagree for reasons unrelated to what is being tested. Measured at 0.50 against a 0.8 floor.
   Either compare the engine against the *same* recall the factored path used, or treat V5 as a
   noisy diagnostic rather than a gate. **This blocks every downstream routing experiment**, not
   just this one.
4. **The leakage primitives are ASCII-only.** `harness.py:_toks` used `[a-z0-9]+`. Correct for
   its English RouterBench prompts, but any non-Latin text tokenizes to the **empty set**. My
   first contamination run hit this and silently deleted 70 % of the `translation` class before
   I caught it (285 false drops → 3 real ones after switching to `\w+` plus a 5-token minimum).

   **Fixed in round 2 — and the consequence in `harness.py` is the *inverse* of the one I hit.**
   There, `_jaccard` returns 0.0 whenever either side is empty, so non-Latin rows scored 0.0
   against everything: the V1 near-duplicate filter **failed open** (a verbatim train/test twin
   in Tamil was never dropped) and the leaked-neighbor diagnostic read 0.0 on a corpus that
   could be fully leaked. A guard that silently passes, not one that over-drops.

   **Scope, stated precisely:** every prior result relying on `_toks` — `RESULTS.md`,
   `BENCHMARKS.md`, `test_routerbench_savings.py` — ran on **English-only** corpora, where the
   ASCII class is adequate. **Those "V1 leakage 0 %" claims stand.** Mixed-script corpora are
   the only exposure, and the only one to date was this study's, caught and fixed.

5. **The same class, in production: `memory/keys.py:30`.** `salient_signature` would have
   collapsed every non-Latin task into the `"general"` bucket — one cluster signature for a
   whole language. **Inert today** (`versioned_cluster` passes `signature=None` at v1, so
   nothing in production calls it) but armed if fine-cluster keys turn on. Note `\w+` is *not*
   a sufficient repair there: Python's `\w` excludes combining marks, so it shatters Tamil and
   Devanagari into 1–2 char fragments that the `len >= 4` filter then discards — the empty-token
   bug again. Fixed with a separator-based split; English tokenization is unchanged.

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
5. **A4 — neighbour voting — was never evaluated, and remains untested.** It ships in the
   serving path, but `engine.py:204-212` gates it on non-empty recall evidence, so it cannot be
   measured intrinsically at all: it needs live memory, which §13 shows is unreliable. **Every
   verdict in this report is about the head, not about the serving configuration.**

## 9. Recommended next steps *(round 1 — superseded by §16)*

Kept for audit. Item 1 ("retune the conformal thresholds") was **falsified** in round 2 (§10);
items 2, 3 and 5 were acted on (§11, §13). The current list is §16.

---

# Round 2 — 2026-07-28

Follow-up round, same $0 budget. Ordering was set by the reviewer: fix the measurement before
believing any more of the measurements.

## 10. Retuning tested properly — and falsified

Round 1's retune claim rested on a point estimate. Re-run with a calibration/held-out split and
a paired bootstrap (`scripts/eval/classifier_ab/recalibrate.py`,
`reports/data/recalibrate.json`). Calibration mixture n = 1362 (SNI validation half + the
frozen `oos` slice + the `conversational` seed-register slice — deliberately **not** the
`typed` slice, so G1e stays an honest holdout). Held out: SNI test half n = 1309.

| | tau_dist | tau_margin | G1e false-abstain | coverage | held-out macro-F1 |
|---|---:|---:|---:|---:|---:|
| shipped | 0.8599 | 0.008842 | 0.045 | 98.7 % | 0.2791 |
| refit on the mixture, α = 0.05 | 0.7186 | 0.000018 | **0.409** | 98.2 % | 0.2848 |
| **vocabulary + regex** | — | — | — | — | **0.3560** |

Three findings, each of which independently kills the retune path:

1. **Refitting on a mixture barely moves the number** (0.2791 → 0.2848) and still loses to
   vocabulary+regex by 7 points — while blowing G1e's false-abstain from 0.045 to **0.409**,
   five times its 0.08 gate. Out-of-corpus calibration and the G1e bound are incompatible for
   this artifact.
2. **The best reachable operating point is indistinguishable from deleting the head.** Joint
   `(tau_dist, tau_margin)` sweep, selected on calibration, scored once on held-out:
   > **Δ vs vocabulary+regex = +0.0045, 95 % CI [−0.0073, +0.0170], P(Δ>0) = 0.765**, at 15.6 %
   > coverage.
3. **The unconstrained optimum is unreachable by construction.**
   `fit_joint_abstain_thresholds` (`scripts/classifier/common.py:126-158`) sweeps `qd` from
   0.95 **upward**, so `tau_dist` can only land at or above the 95th percentile of calibration
   distances — and since `abstained = dist > tau_dist`, a higher threshold abstains *less*. The
   optimum needs **α ≥ 0.98**. The fitter cannot express it at any grid point.

Also worth recording: on the in-corpus `typed` slice the head is *fine* — error among rows it
commits on is **0.131** shipped, 0.135 refit. The ~70 % error is purely out-of-corpus. This is
a generalization failure, not a broken model.

**Nothing was shipped.** `derive_classifier_id` hashes the artifact directory, so any tau change
mints a new `classifier_id` and cannot be swapped in silently.

## 11. The gate suite — the governance fix

**The G1 suite had never run in CI.** It carried `pytest.mark.eval`; `.github/workflows/ci.yml`
runs `-m "not live and not eval"`. Seven green gates on a head losing 8.7 macro-F1 is what that
gap bought. The suite is hermetic and costs 3 s, and the artifact was already committed, so:

| Change | Effect |
|---|---|
| dropped the `eval` marker; artifact defaults to the in-repo dir | G1 now runs on every PR — **550 passed, 1 xfailed, 6.5 s** |
| fixture calls `classify_details` instead of a hand-written mirror of it | the gate can no longer drift from the dispatcher it gates |
| **G1g baseline: bare regex → vocabulary+regex** | removes a structural confound |
| **G2 added**: out-of-corpus paired comparison, 2 609 SNI rows, content-hash pinned | `xfail(strict=True)` carrying Δ = −0.0865, CI [−0.1075, −0.0653] |

Two honest notes on this:

- **The G1g fix changed nothing numerically.** head 0.8251 · vocabulary+regex 0.2117 · old bare
  regex 0.2117 — the vocabulary tier contributes **+0.0000** on that slice. The confound was
  real but not outcome-changing, because the tier is nearly inert: it fires on **0.00 %** of the
  G1g slice, 3.64 % of the frozen set, 0.54 % of SNI.
- **The SNI gate set is committed untruncated.** Truncating to the head's own 4096-char limit
  looked free, but the regex tiers scan the whole string and **9 of 2 609 baseline predictions
  flip**. 2.5 MB.

G2 as a strict xfail is deliberate: the suite stays green, the defect cannot be quietly
deleted, and a retrain that fixes it XPASSes and forces the marker's removal.

## 12. A6 — "route, don't replace" (pre-registered at `0b3e422`)

Pre-registered prediction, committed before the run: *the primary CI will not exclude zero in
A6's favour.* **It does not.** Held-out half, n = 1309, task-level split, Δ vs A2:

| arm | macro-F1 | acc | Δ vs A2 (95 % CI, P>0) |
|---|---:|---:|---|
| A2 vocabulary+regex | 0.3560 | 0.302 | — |
| A3b head as shipped | 0.2791 | 0.299 | −0.0770 [−0.1094, −0.0448] P=0.000 |
| **A6** deny-set from validation | 0.2966 | 0.297 | **−0.0595 [−0.0845, −0.0346] P=0.000** |
| A6-fixed deny {translation, summarization} | 0.2943 | 0.298 | −0.0617 [−0.0878, −0.0358] P=0.000 |
| A6-oracle deny-set from held-out itself | 0.2868 | 0.283 | −0.0692 [−0.0935, −0.0458] P=0.000 |
| A6′a patterns → head → regex | 0.2990 | **0.325** | −0.0570 [−0.0887, −0.0259] P=0.000 |
| A6′b patterns → vocabulary → regex (**no head**) | 0.3617 | 0.303 | +0.0057 [−0.0012, +0.0142] P=0.924 |
| A6-greedy keep only positive-contribution classes | **0.3628** | 0.316 | +0.0068 [−0.0026, +0.0162] P=0.923 |

Wiring verified: deny-**all** reproduces A2 exactly, deny-**none** reproduces A3b exactly.

**I had the mechanism backwards.** I argued the deny-set was the mechanism that could move the
number and that the vocabulary-pattern variant was bounded and secondary. Inverted: every
deny-set arm loses, and the only two arms that reach A2 lean on the regex — one of which
**never calls the head at all**. Their CIs overlap each other, so the ~+0.006 is the patterns,
not the head. (A6′ also had to be corrected mid-run: as first written it skipped the head
entirely, so it was not the proposal it claimed to be. Both forms are now reported.)

**A6-oracle being worse than the honestly-selected A6 is structural, not noise.** A deny set
chosen by comparing per-class F1 is blind to classes with **no gold on the eval set** — `code`,
`rag`, `tool_use`, `other` have no F1 to compare, so they are never denied, and they are
exactly where the head's false positives land. Pricing each class's system-level contribution
directly (deny everything else, held-out):

| keep only | Δ vs A2 | | keep only | Δ vs A2 |
|---|---:|---|---|---:|
| reasoning | **+0.0061** | | summarization | −0.0058 |
| creative | +0.0053 | | code | −0.0106 |
| classification | +0.0016 | | qa | −0.0122 |
| extraction | −0.0000 | | rag | −0.0175 |
| tool_use | −0.0052 | | other | −0.0241 |
| | | | **translation** | **−0.0322** |

**Per-class F1 does not compose.** The table that motivated "route, don't replace" ranks
`reasoning` first (+0.257 F1) and the system sweep agrees it is the best class to keep — but
the four absent classes it structurally cannot see cost more than the three real ones gain.

The A6′ patterns are genuinely high-precision — they fire on **16.4 %** of rows and are
**97.9 %** correct when they fire, meeting the vocabulary tier's stated near-zero-false-positive
contract. They are an argument for improving the regex stack, not for keeping the head.

## 13. Leg B closeout — the ricedb attribution is **refuted**

Full write-up: `reports/recall-blocker.md`. Probe: `scripts/eval/classifier_ab/recall_probe.py`.

The hypothesis was that the 16/13/16 evidence-count instability matched
`ricedb@fix/control-vector-search` (`c76f5eb`, 2026-07-14, unmerged) — a lane filter dropping
untagged entries and silently falling through to a recency fallback with "a UUID-ordered,
query-independent result set with a constant placeholder score of 0.5", naming Minima's
`batch_insert` as affected. The dates bracket neatly. **Every signature is absent:**

| predicted by that bug | observed |
|---|---|
| constant score ≈ 0.5 | **24 distinct scores of 25**, range 0.428–0.711 |
| degenerate/absent semantic component | `semantic` = 0.99, 0.99, 0.99, 0.99, 0.76 … |
| recency-ordered fallback | `rank_by: "balanced"`, `recency: 0.0` everywhere |
| query-independent results | three orthogonal queries each return **5/5 own-family in the top 5** |

Jaccard between *orthogonal* queries is 0.19–0.22 against 0.61–0.85 between *identical* ones —
a clean separation, and the opposite of what the fallback would produce. Pre-registered
commitment was not to backfill an attribution from a date; it is not backfilled.

**What is actually broken, now quantified.** Five identical queries, same lane, same limit,
index at rest: **0 of 10 pairs share an ordering**, **4 distinct top-5 orderings across 5
calls**, and **33 distinct entry ids at a limit of 25** — ~24 % of the result set churns per
call. The *head* of the ranking is stable and correct; the *tail* churns — which is exactly
where evidence-per-model comes from once a fixed recall budget is split across N candidates,
and exactly why `_crosscheck` (cached pick vs fresh pick) cannot reach its 0.80 floor.
`RESULTS.md` recorded 100 % on 2026-06-12, so this is a regression, not a standing limit.

The directive stands: **no classifier change can unblock V5**, and Leg B stops here.

## 14. A `code`-bearing clean set — proposal, not built

**Disqualified by contamination:** `seeding/routerbench.py:25-27` maps `mbpp`, `humaneval` and
`code-llama` → `code`. RouterBench **is** the head's `code` training source, so HumanEval and
MBPP cannot evaluate it. CLINC150 likewise. SNI has no `code` gold at all.

| source | why | rows | $ | labels |
|---|---|---:|---:|---|
| **CoNaLa** (StackOverflow NL intents) | real developer phrasing, not in RouterBench/CLINC | 2.9k curated | 0 | `code` by construction |
| **SWE-bench issue statements** | closest register to Minima's actual harness traffic | 2.3k | 0 | `code` by construction |
| **Harness telemetry** (`routing_decisions`, TUI spine) | the only true serving distribution | thousands | 0 | **none — needs gold** |

Compute is free. The cost is **gold labels**, and the choice matters: CoNaLa and SWE-bench are
`code` by construction, so they measure **recall** on `code` but give no precision signal —
they cannot catch the head *inventing* `code`, which it did on 171 SNI rows and which §12
prices at −0.0106. A precision signal needs a mixed set with non-`code` gold.

**Recommendation:** ~600 rows stratified across CoNaLa + SWE-bench + a non-code contrast slice,
hand-labelled against the adjudication rules already written in `test_classifier_gates.py:6-8`
(~2–3 h, $0), or an LLM label panel at ~$5–15.

## 15. What got falsified, and what I retracted

Pre-registered predictions, scored:

| # | Prediction | Where | Outcome |
|---|---|---|---|
| P1 | The head consumes `regex_hint` as a feature | round 1 §2 | **FALSIFIED** — `regex_classes: []`; with-hint and no-hint agree on 2609/2609 |
| P2 | A3b vs A2 CI will exclude zero in the head's favour | round 1 | **FALSIFIED** — Δ = −0.0865, CI entirely below zero |
| P3 | Retuning tau is the actionable remedy | round 1 §5 | **FALSIFIED** in §10 — best reachable Δ = +0.0045, CI [−0.0073, +0.0170] |
| P4 | The A6 primary CI will **not** exclude zero in A6's favour | `PREREG-A6.md` `0b3e422` | **HELD** — Δ = −0.0595, CI [−0.0845, −0.0346] |
| P5 | The Leg B failure is `ricedb@fix/control-vector-search` | reviewer hypothesis | **REFUTED** in §13 — all four signatures absent |

Retractions and corrections, mine:

- **"Retune" as the verdict.** Round 1's headline rested on a point estimate with no CI. It
  does not survive a paired bootstrap. §5 carries a correction banner.
- **The A6 mechanism argument was backwards.** I claimed the deny-set was the mechanism that
  could move the number and the vocabulary-pattern variant was bounded and secondary. Every
  deny-set arm loses; the only arms reaching A2 lean on the regex, one of which never calls the
  head. I also mis-specified A6′ on the first run — it skipped the head entirely, so it was not
  the proposal it claimed to be. Both forms are now reported.
- **"Bit-identical truncation."** I claimed committing the SNI set truncated to 4096 chars was
  prediction-neutral because the head truncates there. The *regex* tiers do not — 9 of 2609
  baseline predictions flip. Committed untruncated.
- **The `harness.py` tokenizer's failure direction.** I described it as the same over-dropping
  failure I hit in the SNI loader. It is the inverse: `_jaccard` guards against empty sets, so
  the guard failed *open* rather than over-dropping. Different bug, same root cause.
- **`\w+` as the fix for `salient_signature`.** Insufficient — `\w` excludes combining marks, so
  it shatters Indic scripts into fragments the `len >= 4` filter discards. Caught by the
  regression test I wrote for it, which failed on first run.

Held from round 1, re-verified: the reviewer's claim that `test_classifier_gates.py:139` calls
`clf.classify()` without a `regex_hint` is **incorrect** — `clf` is the `Serving` fixture and
`:60` passes `regex_hint=infer_task_type(text)`. Checked a third time. The nearby defect that
*is* real is different and larger, and is fixed in §11: G1g scored vocabulary+head against
**bare** regex.

## 16. Recommended next steps (current)

1. **Stop investing in this artifact.** Three pre-registered remedies — retune (§10), class
   routing (§12), and the regex-feature hypothesis (§2) — have all failed. Further tuning of
   `potion-base-32M-c18e819c6c6d` is not indicated.
2. **Build the `code`-bearing set** (§14) — it is the one piece of evidence that could change a
   pull decision, and 4 of 11 classes are currently unmeasured.
3. **Land the A6′ patterns into `_HIGH_PRECISION` on their own merit** — 16.4 % fire rate at
   97.9 % precision, and they beat the head on every arm. This is a regex improvement, and it
   should be evaluated and shipped as one, not as a rescue for the classifier.
4. **Fix hosted recall's top-k instability** (§13, `reports/recall-blocker.md`). Until then no
   routing experiment from this harness produces a defensible number, and A4 stays untestable.
5. **Delete the `regex_hint` plumbing** — computed, passed, and discarded on every call (§2).
6. **If a retrain happens, target the attractors**: `→ translation` on paraphrase prompts and
   `→ reasoning` on science questions, plus the false-positive spray into the four classes with
   no gold, which §12 shows is where the real system-level damage is.
7. **Raise α or replace `fit_joint_abstain_thresholds`** if conformal abstention is kept at all
   — its grid cannot express an operating point that abstains more than ~α (§10.3).

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

# round 2 — §10 §12 §13. The gate set is committed, so these need no download.
uv run python scripts/eval/classifier_ab/recalibrate.py --out $S/recalibrate.json
uv run python scripts/eval/classifier_ab/a6.py          --out $S/a6.json
uv run pytest -q tests/eval/test_classifier_gates.py -rx   # 8 passed, 1 xfailed (G2)

# §13 needs hosted Mubit and writes to a throwaway lane
set -a && . .env && set +a
uv run python scripts/eval/classifier_ab/recall_probe.py --out $S/recall_probe.json
```
