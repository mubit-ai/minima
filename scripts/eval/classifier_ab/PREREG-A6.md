# Pre-registration — A6, "route, don't replace"

Frozen and committed **before** any A6 arm runs. Follow-on to `PREREG.md` (frozen `58c020a`);
same eval set (`tests/eval/data/classifier_sni_set.jsonl`, sha256
`9c565a05cc636e68a2f34a4996f078eb6af37c8125935fbda7fc624b14d2e9c9`), same artifact
(`potion-base-32M-c18e819c6c6d`), same $0 budget.

## 0. Why this experiment exists

The A/B found the head loses 8.7 macro-F1 to vocabulary+regex out of corpus, and S1 has since
ruled out the obvious remedy: no reachable point on the conformal abstention frontier beats
vocabulary+regex (joint sweep, selected on calibration, scored once on held-out: Δ = +0.0045,
95% CI [−0.0073, +0.0170], P(Δ>0) = 0.765). **RETUNE is dead.** What remains is the observation
that the loss is not uniform across classes.

Per-class F1 on the full 2,609-row set, A2 (vocabulary+regex) vs A3b (head):

| class | n | A2 | A3b | Δ (head − regex) |
|---|---:|---:|---:|---:|
| translation | 400 | 0.999 | 0.705 | −0.294 |
| summarization | 210 | 0.589 | 0.302 | −0.287 |
| qa | 400 | 0.450 | 0.238 | −0.212 |
| extraction | 399 | 0.061 | 0.005 | −0.056 |
| classification | 400 | 0.399 | 0.371 | −0.027 |
| creative | 400 | 0.033 | 0.047 | +0.014 |
| reasoning | 400 | 0.118 | 0.375 | **+0.257** |

If the two components have complementary competences, dispatching by class should beat either
alone. That is the hypothesis under test.

## 1. Mechanism — and why the obvious implementation cannot work

`_HIGH_PRECISION` (`classify.py:33-43`) is two patterns: a code-file-extension rule and
`tl;dr`. Adding translation/summarization *patterns* to it only changes rows where the new
pattern fires. It does **not** stop the head labelling `translation` on the 94 paraphrase and
simplify rows that contain no translation vocabulary — the single largest error mode found.

So two arms, testing two different mechanisms:

- **A6 (primary)** — deny-set on the head's PREDICTED class. If the head predicts a class in
  the deny set, treat it as an abstain; the dispatcher falls through to the regex
  (`classify.py:574-576`). This fires on every head prediction of a denied class, so it can
  actually remove the attractor errors. Implemented as a wrapper around the real artifact —
  **zero `src/minima/` changes** — reusing the `StubAbstainClassifier`/`NoHintClassifier`
  pattern already in `arms.py`.
- **A6′ (secondary)** — the literal vocabulary-tier extension: high-precision translation and
  summarization patterns prepended to `_HIGH_PRECISION`. Deployable today with no dispatcher
  change. Its **fire rate and precision are reported first**, because they bound its effect by
  construction.

## 2. Selecting the deny set without cherry-picking

The table in §0 was computed on the same 2,609 rows that would score the arm. Choosing
{translation, summarization} from it and then scoring on it is V3 cherry-picking.

Therefore: SNI is split **by task** (rows within one task share a `Definition`, so a row-level
split would validate a threshold on near-identical text), 50/50, `numpy.default_rng(20260727)`
— byte-identical to the split already used in `risk_coverage.py:106-110`.

- **Deny set** = every class `c` where `F1_head(c) < F1_regex(c)` on the **validation half**.
  Selected, printed, frozen.
- **Scored** once on the **held-out half**.

Two comparators reported alongside, both on the held-out half and both labelled:
- **A6-fixed**: deny = {translation, summarization}, i.e. the set named from the full-set
  table. Optimistic by construction — reported for completeness, not as evidence.
- **A6-oracle**: deny set selected on the held-out half itself. An upper bound that no
  deployable policy can reach; it exists to show how much of any A6 win is selection luck.

## 3. Primary endpoint

> **Δ = macro-F1(A6) − macro-F1(A2) on the held-out half**, macro over gold-present classes,
> paired bootstrap over prompts, 10,000 draws, seed 20260727, 95% percentile CI.

Everything else — A6-fixed, A6-oracle, A6′, per-class deltas, source mix, abstain rate — is
secondary.

## 4. Pre-registered prediction (falsifiable)

A naive per-class swap — regex F1 on translation and summarization, head F1 on the other five —
yields macro-F1 ≈ **0.375**, against A2's **0.378**. The head has exactly one class where it
genuinely wins (reasoning, +0.257), and the deficit is spread across summarization (−0.287),
qa (−0.212) and extraction (−0.056), only one of which the named deny set touches.

> **Prediction: the primary CI will NOT exclude zero in A6's favour.**

- If the CI lower bound **> 0** → prediction falsified. A6 is a warranted production change and
  it beats retuning, which S1 already showed is unavailable. Recommend implementing the
  deny-set in the dispatcher.
- If the CI **straddles or lies below zero** → prediction holds. Class-competence routing does
  not rescue the head either; with RETUNE also dead, the remaining options are retrain or pull,
  and the report says so.

Either result is reported in full. No arm is dropped, re-split, or re-run after seeing its
number; the split seed and draw count above are fixed here.

## 5. Known limitations, stated in advance

- The head's `reasoning` win is partly its own error mode: it labels science questions
  `reasoning` (196 rows). A6 keeps the head for `reasoning`, so it keeps that error. A win on
  this metric would not mean the head is *right* about reasoning, only that it is less wrong
  than the regex there.
- 7 of 11 classes have gold on this set. `code`, `rag`, `tool_use`, `other` are unmeasured —
  and `code` is plausibly the highest-traffic type in real harness use.
- SNI is templated instruction-manual prose, not conversational serving traffic.
- A4 (neighbour voting) is untested and remains so: it is gated on non-empty recall evidence
  (`engine.py:204-212`), which requires live memory.
