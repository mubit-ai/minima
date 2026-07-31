# Classifier-confidence arc — programme report

**Status:** phase 1 complete · **Date:** 2026-07-31 · **Branch:** `integration/confidence-arc`
**Tickets:** MUB-214 … MUB-226 (phase 1) · MUB-220–223 (phase 2, recommended closed unstarted)

This is the programme-level report: why the work happened, what was built, what it found, and
what to do next. Two companion documents carry the detail:

| document | what it is |
| --- | --- |
| [`classifier-eval-readout.md`](classifier-eval-readout.md) | MUB-219's formal deliverable — the answer, with its falsification conditions |
| [`classifier-eval-corpus-limits.md`](classifier-eval-corpus-limits.md) | the denominator authority — what this corpus can and cannot support |
| [`adr/0001`–`adr/0010`](adr/) | the decisions, each recorded where it was made |

---

## 1. Intent

Routing quality depends on knowing what kind of task a prompt is. The task type is the lookup
key into memory: get it wrong and you recall the wrong history and recommend the wrong model.

The harness classifies prompts with one cheap LLM call that returns a task type, a difficulty,
and **a confidence number the model asserts about itself**. Production gates on that number —
`CLASSIFY_CONFIDENCE_FLOOR = 0.75` — and below it the classifier's label is discarded entirely.

That floor had never been validated against evidence of any kind. The arc existed to settle one
question:

> **Is routing quality limited by how often the classifier is wrong, or by how badly its
> confidence signal is calibrated?**

The answer decides whether to build MUB-220–223, which would expose per-token probabilities
from the provider layer and use them in place of the self-report. The ticket states explicitly
that closing those unstarted is a successful outcome, not a failure.

A prerequisite, delivered first as MUB-214: the word "confidence" named **eight different
things** in this system. `CONTEXT.md` fixes the vocabulary. The two that matter here:

- **self-report** — the model writing `{"confidence":0.95}` about itself. Free, and shipped.
- **token probability** — the actual sampling distribution over the label token. Does not exist
  in this codebase; `git grep -i logprob` returns nothing.

Everything measured below concerns the **self-report**. No token probability was ever collected.

---

## 2. What was built

An offline measuring instrument. It reads the local SQLite ledger and makes direct provider
calls; **it never contacts the Minima service**, so the Python classification cascade plays no
part in any lab measurement.

### The corpus

```
546  raw user-role events
470  lead-agent events            (sub-agent prompts excluded)
424  usable occurrences           (harness steer text and empties excluded)
238  DISTINCT prompts             ← the corpus
```

One developer's own harness traffic over 15 days. This is the single largest limitation and it
constrains every conclusion below.

### The measurements

| # | ticket | what it does | spends |
| --- | --- | --- | --- |
| 1 | MUB-215 | corpus extraction + cost-guarded dry run | — |
| 2 | MUB-216 | 3-model reference panel → consensus labels | $2.67 |
| 3 | MUB-225 | correlate prompts to real routing decisions | — |
| 4 | MUB-218 | replay the shipped classifier, score it, derive a floor | $0.18 |
| 5 | MUB-217 | resample the classifier 10× — is its self-report honest? | ~$1.72 |
| 6 | MUB-226 | adjudicate: would the override have helped in real traffic? | — |
| 7 | MUB-219 | the synthesis and the build / do-not-build call | — |

**The reference panel** (MUB-216) is how ground truth was manufactured. Three frontier models
from three vendors — `claude-opus-4-8`, `gpt-5.6-sol`, `gemini-2.5-pro` — label all 238 prompts.
Each receives the **shipped `CLASSIFY_SYSTEM` instruction verbatim** (ADR 0005), making the panel
a strictly-stronger-models replay of the production call, so any gap is model capability rather
than prompt difference. Votes are stored individually and consensus is derived at read time
(ADR 0001), so a 3-0 unanimous verdict stays distinguishable from a 2-1 split.

Only unanimous prompts become reference labels: **181 of 237 complete panels (76.4%)**.

### Execution

Six parallel lanes across git worktrees, merged into one integration branch. The partition rule,
earned in an earlier wave where "one union member each" still produced a semantic conflict:
**exactly one lane may touch a shared surface; every other lane adds files only.** All merges
after that rule was adopted were conflict-free.

```
Step 0   push everything            30 unpushed commits existed only on one laptop
Step 1   land MUB-218's replay      before branching, because it deletes a shared export
Wave 1   MUB-217 · adjudication join · corpus-limits audit     (parallel)
Wave 2   MUB-219 readout                                        (serial, needs all three)
```

**State:** 2688 tests / 0 fail (183 files, `packages/tui`), `check` and `lint` clean, schema
v25 verified two ways, 49 commits ahead of `main` and 0 behind, no migration-index collision.

---

## 3. Results

### 3.1 The classifier is good

`claude-haiku-4-5`, replayed offline over the corpus and scored against the panel:

```
accuracy                        148/167 = 88.6%
majority-class baseline          86/167 = 51.5%   (always answer `tool_use`)
excluding the dominant class     73/81  = 90.1%   (not riding `tool_use`)
```

It is disciplined with the catch-all, which a lazy classifier abuses: it emits `other` on
**18.6%** of scored entries against the panel's own rate of **21.0%** — it uses the escape hatch
*less* than the reference — and when it does, the panel agrees **96.8%**.

Perfect precision on `tool_use` (75/75) and `creative` (15/15); perfect recall on `code` (15/15).

**Two real defects.** It emits `rag` 6 times and `extraction` 3 times — categories the panel
assigned **zero** times in this corpus — and is wrong on all nine. Both cells are below the
reportable threshold, so the magnitude is unquantified, but the direction is clear: it reaches
for plausible enum members that have no instances.

### 3.2 The confidence signal carries no information

**Against correctness.** Bin the scored prompts by the confidence they claimed and measure
accuracy inside each bin. A useful signal rises monotonically. This one does not:

```
claimed <0.60        90.9% correct   (n=11)     ← the LOWEST claim
claimed 0.80–0.90    78.3% correct   (n=23)     ← WORSE when more confident
claimed ≥0.90        91.9% correct   (n=123)    ← ties the lowest
```

On the second model tested, `gpt-4o-mini`, the two reportable bins are outright **inverted**.
Only 3 of 6 bins clear the n≥10 reporting bar.

**Against its own repeatability** (MUB-217). Ask the classifier the same prompt 10 times at the
provider's default temperature and count how often it repeats its own modal answer. That
frequency *is* its true predictive distribution — observed, not asserted. It requires **no
reference labels at all**, so the result cannot be blamed on the panel or the taxonomy.

Sampler verified non-degenerate first: a 100-draw pilot showed **8 of 10 prompts varied**, so a
modal frequency below 1.0 is a measurement rather than an artefact.

```
modal-label frequency    1847/2330 = 79.3%     what it actually does
mean self-report                    0.8193     what it claims
mean gap                           +0.0064     ← reads as perfectly calibrated
mean ABSOLUTE gap                  +0.2015     ← it is not
direction mix    over 34.5% · under 29.3% · indistinguishable 36.2%
```

**The `+0.0064` is a cancellation artefact and must never be quoted alone.** The signed errors
average to nearly zero because they run in both directions; the absolute gap of 0.20 on a 0–1
scale is the true magnitude. The instrument was built with three simultaneous guards —
signed mean, absolute mean, and a three-way direction mix printed in one block — specifically to
expose this. **Without them the arc would have concluded the exact opposite of the truth.**

The sign flips almost exactly at the production floor:

| claimed | prompts | mean gap | direction |
| --- | --- | --- | --- |
| `<0.60` | 33 | **−0.4150** | 87.9% underconfident |
| `0.70–0.75` | 10 | −0.0359 | 60.0% underconfident |
| `0.75–0.80` | 5 | +0.0434 | *the emptiest bin* |
| `0.80–0.90` | 45 | +0.1054 | 51.1% overconfident |
| `≥0.90` | 125 | +0.0962 | 36.8% overconfident |

Worst individual cases: prompts claiming **0.950** whose own modal answer recurs **1 time in 10**.

### 3.3 There is nothing for the floor to act on

```
scored entries below the 0.75 floor      20 of 167
entries in the 0.75–0.80 bin              1
entries the floor decision turns on       9    (+7 right, +2 wrong)
```

**103 of 167 entries report the identical value 0.95.** The distribution is a spike, not a
spread. Moving the floor from 0.75 to the data-derived 0.60 changes the fate of nine prompts.
A threshold can only separate what is spread around it.

### 3.4 The override channel has never run

```
client_task_type        NULL on 494 of 494 recorded decisions
client_confidence       NULL on 494 of 494
classify_disagreement   NULL on 494 of 494
```

`config.classify` defaults to `false`. Not one of 494 real routing decisions used the client
classifier. The floor this arc spent $4.57 measuring gates a door that has never opened.

Reconstructing what would have happened — service label from the ledger, harness label from the
offline replay, truth from the panel:

```
124 adjudicable rows of 177 candidates

  corrections   85     service wrong, harness right
  harms          3     service right, harness wrong
  no-ops        25
  both-wrong    11
               ───
  net          +82

harness classifier right on   110/124  (88.7%)
service's own label right on   28/124  (22.6%)
```

124/124 corroborated — the result rests on no weak prompt↔decision pairing.

---

## 4. The answer, and the recommendation

**Neither accuracy nor calibration is the binding constraint. The override channel being
switched off is.**

Accuracy is 88.6% and the classifier is sound. The confidence signal is genuinely broken — it
predicts neither correctness nor the model's own repeatability — but it *cannot* be the
constraint, because it has nothing to act on: the floor decides nine prompts.

### Recommendation: DO NOT BUILD MUB-220–223

The argument is a **ceiling**, not an estimate:

```
a PERFECT gating signal over the 124 rows          85 corrections − 0 harms  =  +85
the shipped 0.75 floor, today's useless signal    76 corrections − 2 harms  =  +74
                                                                              ─────
everything phase 2 could possibly win                                          +11
```

Flipping a configuration boolean captures **+74**. A flawless confidence signal — logprobs,
calibration, all of phase 2 — competes for the remaining **11**. Token probabilities would
refine a gate on a door that is bolted shut.

MUB-219 fixes **six** falsification conditions, written before the recommendation, each with its
measured value beside it, plus a preregistered live re-test. See
[`classifier-eval-readout.md`](classifier-eval-readout.md) §7.

---

## 5. Findings made after the readout was written

These emerged from reviewing the code paths after MUB-219 was committed. **They qualify its
strongest claim and are not yet reflected in that document.**

### 5.1 The 22.6% service baseline is a blend of unknown mechanisms

The service can produce its label six ways (`classify.py:559–593`): `caller`,
`vocabulary_precise`, `embedding`, `embedding_abstain`, `neighbor_vote`, `heuristic`. It reports
which one won as `task_type_source`, and **the harness throws it away** — `router.ts:250-251`
lifts only `heuristic_task_type` and `heuristic_difficulty`.

So "the service is right 22.6% of the time" is measured over 124 labels of unrecorded
provenance. Partial evidence survives:

```
heuristic_task_type recorded on    39 of 494
   final label DIFFERS from it     24     ← proof a non-regex mechanism decided these
   final label MATCHES it          15
```

**Indirect evidence points away from a trained classifier having decided most rows.** The
service answered `other` on **64 of 124 (51.6%)** against a true rate of 21%, and those `other`
rows supply **52 of the 85 corrections — 61% of the entire +82**. A trained embedding head would
not answer with the catch-all on half of all traffic; that is the signature of a fallback, or of
a head that abstained and fell through.

The honest restatement:

> The harness classifier would have corrected 85 decisions the service **declined to classify
> confidently** — not 85 decisions where a trained classifier was beaten head-to-head.

Still a real job. A different job from the one the raw number implies.

### 5.2 Enabling the override may need two flags, not one

```ts
const deferToServerHead = !this.config.classifyForce && (await this.router.embedClassifierActive());
```

When the service reports its embedding head loaded, the harness **defers to it** and skips local
classification entirely — unless `classifyForce` is also set. So capturing that +74 may require
asserting that the harness's one LLM call beats the service's trained head.

**The codebase says the opposite, in three separate places:**

1. `runtime.ts:449` — *"the head outclassifies the one-completion label, and a caller override
   would preempt it."*
2. The `deferToServerHead` gate itself, which encodes that belief in code.
3. `classify.ts:20` — the floor was **raised from 0.60 to 0.75** in PR-7 precisely because
   *"with the server embed head shipping, a caller override stomps a calibrated classifier."*

That third point reframes MUB-218's derived floor of 0.60. Lowering the floor back to 0.60 would
not be "following the evidence" — it would **undo a deliberate safety margin** installed to
protect the trained classifier. Nothing in this arc tested the harness against the head directly.

### 5.3 88.6% is accuracy on the easy prompts

A prompt is only scorable if three frontier models **unanimously agreed** on it. Those are by
construction the well-specified ones; the 57 excluded prompts are exactly the ambiguous ones.

```
238 corpus prompts
−57  panel split → no answer key → excluded   ← the HARD ones
=167 graded (70% of the corpus)
```

**88.6% is accuracy on the 70% of traffic three frontier models found easy.** True accuracy over
all traffic is unmeasured and lower. There is no way to grade a prompt with no answer key, so
this is a structural limit of the method, not an oversight.

---

## 6. Next recommendations

Ranked. Items 1–2 change what is known; 3–6 are instrument and hygiene work.

### 1. Persist `task_type_source` — highest value, smallest change

Two lines at `router.ts:250` plus a column. It splits the 124 adjudicated rows by the mechanism
that actually produced each service label and converts §5.1 from a guess into a measurement.
Until it exists, nobody can say how much of the +82 is "beat a trained classifier" versus
"filled in for one that abstained" — and that distinction decides whether §5.2's second flag is
justified.

**Do this before acting on the +82.**

### 2. Enable client classification for the lead agent, behind the shipped floor, and measure live

The sweep says the exact floor barely matters (+74 at 0.75 versus +82 at 0.20), so ship it at
0.75 and leave the margin intact. Gate on item 1 first so the comparison is interpretable, and
resolve the `classifyForce` question explicitly rather than by default — the three code comments
in §5.2 are an argument against forcing, and they deserve a direct test.

### 3. A `usd` column on the priced rows

The arc spent ~$4.57 and can prove $2.85 from its own records. No price column exists on
`consensus_labels`, `classifier_replay_labels` or `classifier_self_consistency_samples`, and
`budget_events` is session-scoped agent spend that no eval module writes to. One nullable `REAL`
written from the `onCostUsd` hook that all three lanes already have. Nullable, because
backfilling would mean inventing prices.

Sharper half: the panel holds **714 cached votes against a run of 681 calls** — 33 votes,
11 prompts × 3 panelists, attributable to no run at all.

### 4. Fix the missing support gate in `consensus_panel.ts` — a defect, not a limitation

Two of three renderers import `MIN_REPORTABLE_SUPPORT` and mark thin cells with `†`. The panel
report does not, so it prints `rag 0/9 (0.0%)` and `translation 1/1 (100.0%)` unmarked, as
though they were findings.

### 5. A second panel run at a different instruction

ADR 0005 caps what the taxonomy result can mean: 76.4% unanimity is unanimity **under the thin
shipped instruction**, which carries no per-type definitions, no examples and no tie-break
guidance. Separating "the taxonomy is incoherent" from "the instruction is thin" needs a second
panel at a fuller instruction. Costs roughly what MUB-216 cost.

### 6. The `code` / `tool_use` / `other` boundary

**48 of 56 panel splits name one of these three, and 23 are splits among those three alone.**
Both the panel and the classifier lose in the same place. This is where a taxonomy or
instruction change would pay.

### Also open

- The floor-derivation rule lets a threshold admitting **zero** rows veto a whole segment's
  derivation (why the after-segment derives `NONE`). Arguably correct-as-designed, but nobody
  chose it deliberately.
- `spawnOpeners` should sanitize child env — `FORCE_COLOR` leaks into spawned test subprocesses
  and makes `tests/db-migrate.test.ts` fail 2 for that reason alone.
- MUB-217 coverage stopped at **2330/2380 (97.9%)** when the top-up hit its ceiling. The residual
  draws are on prompts that repeatedly fail — plausibly the longest ones, where a model would
  disagree with itself most, so self-consistency may be biased slightly **upward**. Unquantified.

### Explicitly not recommended

**MUB-220–223.** See §4. Revisit only if the preregistered re-test in the readout inverts.

---

## 7. What the evidence does not support

Carried forward so it is not rediscovered:

- **Nothing generalizes past one developer.** 238 prompts, 15 days, one machine. The single most
  frequent entry is 21.5% of all occurrences; 181 of 238 occur exactly once.
- **No per-type claim** outside the five reportable types; **no calibration claim** between 0.60
  and 0.80, where three bins hold ten prompts between them.
- **The panel is pseudo-gold, not gold.** Three models trained on overlapping public text can be
  wrong together, and the *same* panel judges both sides of the service-versus-harness
  comparison, so their errors are correlated rather than independent.
- **The panel and the harness share an instruction the service does not.** Both answer
  `CLASSIFY_SYSTEM`; the service uses an entirely different mechanism. The comparison is biased
  in the harness's favour by construction and the size of that bias is unmeasured.
- **The replay is not byte-identical to production.** The shipped call appends a session-context
  hint; the ledger never recorded `contextTokens`, so the replay omits it. The omission is
  argued to bias the self-report high — making any floor derived here *permissive* — but that
  direction is an argument, not a measurement, and it cannot be falsified on this ledger.
- **"Zero harms after the boundary" is not evidence of safety.** 3 harms before over n=64 is
  4.7%, inside the after-segment's one-sided 95% bound of 4.9%. The two rates are
  indistinguishable.
- **The regime split is partly calendar time.** ADR 0003 records that no decision falls in the
  19-hour window the boundary sits in, so the ledger cannot locate the instant; the release
  record pins it.

**The standing rule this arc adopted, after it caught seven settled figures that measured a
population they did not name:** state every rate's denominator and what is in it, inline, every
time. The most-repeated example — the catch-all pair quoted as `34.3% → 74.6%` — reproduces
exactly but is mis-denominated; like-for-like it is **43.7% → 74.6%**, a 30.9-point step rather
than 40.3.

---

## 8. Cost

| lane | realized | evidence |
| --- | --- | --- |
| reference panel (MUB-216) | $2.6693 | recorded in the tree (`23fc234`) |
| replay (MUB-218) | $0.1841 | recorded in the tree (`2c215d5`) |
| self-consistency (MUB-217) | ~$1.7182 | **observed at execution time, persisted nowhere** |
| **total** | **~$4.57** | of which **$2.85 is provable** from this repository |

The self-consistency leg breaks down as pilot $0.0857 (100 draws) → full run $1.4825 (2280
draws, under both its $2.06 ceiling and its $2.0587 projection) → top-up $0.15, stopped by the
live cap. That its realized cost cannot be recovered from any record is the motivation for
recommendation 3.

---

## 9. Where everything is

**Branch `integration/confidence-arc`** — 49 commits ahead of `main`, 0 behind, pushed. All
seventeen arc branches exist on `origin`. **No pull request has been opened; that decision is
the owner's.** `main` is untouched at `d692250` and its migration count is unchanged at 22, so
the arc's three new batches append with no index collision.

```
docs/classifier-eval-readout.md          885 lines   MUB-219, the formal answer
docs/classifier-eval-corpus-limits.md    814 lines   the denominator authority
docs/adr/0001 … 0010                                 the decisions
CONTEXT.md                                           the glossary (MUB-214)
```

Verification, all free and all reproducible from `packages/tui`:

```bash
bun run scripts/classifier_eval.ts --score --target-correctness=0.85   # accuracy + reliability curve
bun run scripts/classifier_eval.ts --adjudicate                        # the four-way outcome
bun run scripts/classifier_eval.ts --self-consistency                  # modal frequency + signed gap
bun run scripts/classifier_eval.ts --correlate                         # prompt ↔ decision pairing
env -u FORCE_COLOR bun test                                            # 2688 pass / 0 fail
```
