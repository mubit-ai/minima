# Pre-registration — classifier ship/keep/retune decision

**Committed before any arm is run.** Everything below is fixed in advance so the analysis
cannot be steered by looking at results first. Deviations, if any, are listed in the report
under "Deviations from pre-registration" with a reason.

Artifact under test: `models/classifier/potion-base-32M-c18e819c6c6d`
(matches prod `/v1/health` `.classifier.id`, verified 2026-07-27).

---

## 0. Structural finding recorded up front

Inspection of `head.npz` **before** any evaluation:

```
classes        11    coef (11, 512)    anchors (11, 512)
regex_classes  []    regex_scale 0.0   tau_dist 0.8599   tau_margin 0.0088
```

`classify_embed.py` only appends the regex one-hot `if self._regex_classes:` — which is
empty here, and `coef` has exactly the 512 embedding dims with no extra feature columns.
**The shipped head therefore ignores `regex_hint` entirely.** `regex_classes`/`regex_scale`
are capability the training script can emit but this artifact does not use.

Consequences, fixed in advance:
- **A3a and A3b are predicted to be identical arms.** This is a falsifiable prediction and
  is checked as gate S4 below. If it holds, they are reported as one arm.
- The head's features are pure embeddings, so the regex is **not** one of its inputs. The
  serving path still depends on the regex (vocabulary tier, and abstain falls back to it),
  but a head-vs-regex comparison is not a model-vs-its-own-feature comparison.

## 1. Arms

| Arm | Path | Construction |
|---|---|---|
| A1 | regex only | `embed=None`, `minima_neighbor_classify=False` |
| A2 | vocabulary → regex | stub `EmbedClassifier` returning `EmbedResult(other, 0.0, abstained=True)` |
| A3a | vocabulary → head(hint) → regex-on-abstain | real artifact, `regex_hint=heuristic_task_type` |
| A3b | vocabulary → head(no hint) → regex-on-abstain | real artifact forced to `regex_hint=None` |
| A4 | A3a + neighbor voting | `minima_neighbor_classify=True` (Leg B only — needs recall evidence) |
| A5 | gold `task_type` as caller override | ceiling |

## 2. Primary endpoint (ONE number)

> **Δ = macro-F1(A3b) − macro-F1(A2)** on the mapped SNI slice,
> **paired bootstrap over prompts, 10 000 resamples, 95 % percentile CI.**

Macro-F1 is computed over **classes present in gold** (absent classes have undefined
recall). Predictions into gold-absent classes are counted as errors for the true class and
reported separately as leakage. Everything else in the report is secondary.

## 3. Dataset (fixed before running)

- Source: Super-NaturalInstructions, all 1 613 tasks across the `test`/`train`/`excluded`
  split files. The head trained on curated seeds + CLINC150 + RouterBench only, so no SNI
  task is in its corpus; SNI's own train/test line is irrelevant here and using the whole
  set is what buys taxonomy coverage.
- Gold: `category_map.py`, frozen at the commit recorded in the report.
- Classified text: `Definition + "\n\n" + input`.
- Sampling: deterministic. Tasks sorted by name; **≤ 6 instances per task**; per-gold-class
  cap **400 rows**; seed **20260727**. Target N ≥ 2000.
- Contamination guard: drop any row whose normalized fingerprint matches, or whose token
  Jaccard ≥ 0.6 against, any RouterBench or CLINC150 row. Drop count reported.
- English-input filter for all non-`translation` classes.

## 4. Sanity gates (a failure stops the run)

- **S1** A5 macro-F1 = 1.0 by construction.
- **S2** A1 reproduces `infer_task_type` exactly on every row.
- **S3** A2 emits zero `task_type_source == "embedding"` rows, and agrees with A1 on every
  row where `high_precision_type` returns `None`.
- **S4** A3a and A3b produce identical predictions on every row (see §0).
- **S5** Local↔prod parity: identical `classifier_id`, and A3a agrees with prod
  `/v1/recommend` `classification_profile.final_task_type` on ≥ 95 % of a 100-row probe.
- **S6** Leg A re-run twice is bit-identical.

## 5. Secondary analyses (declared, so they cannot be promoted post hoc)

Per-class P/R/F1 and confusion · sink-leakage to `other` · abstention rate and
false-abstain on typed rows · p50/p99 latency · McNemar exact test on paired disagreements
for each adjacent arm pair · A3a−A3b (predicted 0) · A1 vs A2 (the vocabulary tier's
contribution) · A5 headroom · per-category breakdown · **sensitivity: primary endpoint
re-run with the `CONTESTABLE` categories dropped**.

## 6. Risk–coverage

Sweep `tau_dist` × `tau_margin` over a fixed grid and plot selective accuracy vs coverage
with the shipped point marked. Reports (a) accuracy achievable at the current abstention
budget, (b) abstention required for current accuracy.

## 7. Leg B (downstream, RouterBench — home-field/contaminated)

Per-arm lane, existing seeding path, `MINIMA_EVAL_USE_CLASSIFIER` seam extended past
`_crosscheck` into the main scoring path. Two configurations: **B1** flat priors with pool
== `max_candidates` (cluster-key channel only, all validity guards hold); **B2** real
priors with pool > `max_candidates` (selection channel live, V4 relaxed and labelled).
Guards: recall-saturation barrier, `MINIMA_MEMORY_RECALL_TIMEOUT_MS=8000`,
`decision_basis == "memory"` on every request, ≥ 8 evidence rows/model, V1 near-dup filter,
V5 crosscheck ≥ 0.8.

RouterBench is in the head's training corpus and its `eval_name → task_type` map is the
same function that labelled those training rows. Contamination flatters the head, so a null
result here is conservative.

## 8. Decision rule

`Δ` is the primary endpoint from §2.

| Verdict | Trigger |
|---|---|
| **KEEP AS-IS** | `Δ` CI lower bound > 0 **and** point estimate ≥ +0.05 **and** false-abstain ≤ 0.08 **and** Leg B shows no cost/quality regression vs A2 beyond CI |
| **RETUNE tau** | risk–coverage offers ≥ 5 pp better selective accuracy at equal coverage, **or** ≥ 10 pp better coverage at equal accuracy, **or** false-abstain > 0.08, **or** abstention > 0.15 with curve headroom |
| **PULL** | `Δ` CI upper bound ≤ 0 **and** Leg B shows no cost or quality gain |
| **INCONCLUSIVE** | `Δ` CI straddles 0 → report, hold, and name the follow-up that would resolve it |

KEEP and RETUNE are not exclusive: the head can clear KEEP and still have a better
operating point, in which case both are reported with RETUNE as a recommendation.

## 9. Known limitations, acknowledged in advance

1. The 76→11 map is ours (see `category_map.py` header). Mitigated by §5 sensitivity and
   per-category reporting, not eliminated.
2. SNI yields no reliable `code`, `rag`, `tool_use`, or `other` gold. **The verdict covers
   7 of 11 types**, and `code` — plausibly Minima's highest-traffic type — is not among
   them.
3. SNI's register is instruction-manual prose, not conversational user traffic. Neither arm
   is favoured a priori, but this is a distribution shift from serving.
4. `Definition` often names the task ("summarize", "translate"), making SNI easier than
   real traffic for both arms. Absolute macro-F1 here is an upper bound; the **difference**
   between arms is the quantity of interest.
