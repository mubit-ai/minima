# 0009 — Self-consistency samples cache into a table keyed by the draw

- Status: accepted
- Date: 2026-07-31
- Written by: MUB-217

## Context

MUB-217 asks whether the classifier's self-reported confidence reflects its own actual uncertainty,
**using no reference labels at all**. The method is repetition: sample the classifier repeatedly on
each prompt, take the empirical frequency of its modal label as its true predictive distribution,
and compare the number it reports about itself against that frequency.

[0001](0001-consensus-label-cache.md) fixed the shape of a label cache — individual rows keyed by
the sha256 of the exact prompt text, stamped with `CORPUS_REV`, with the text never stored — and
[0008](0008-classifier-replay-cache.md) applied it again to the classifier's own labels. Most of
what this lane needs is those two ADRs applied a third time, and where it is, this one records
nothing new.

Five things are not. Each is a way for a correct-looking number to be wrong, and four of the five
produce the SAME wrong number: a self-consistency of 1.0 that means nothing.

## Decision

**`sample_index` is IN THE PRIMARY KEY, in a third table of its own.** `consensus_labels` and
`classifier_replay_labels` both key on `(prompt_hash, model_id)` with `ON CONFLICT DO UPDATE`, so a
same-model resample overwrites its predecessor with no error anywhere. Ten draws through either of
those tables leave ONE row; the modal frequency of one draw is 1.0 by construction; and the readout
would report perfect calibration having stored a single sample. `classifier_self_consistency_samples`
keys on `(prompt_hash, model_id, sample_index)`, which also makes the DRAW the unit of work: a
prompt with seven of ten draws stored owes three, and an interrupted run resumes rather than
re-buying the corpus. `corpus_rev` stays OUT of the key, matching 0001 and 0008.

**A fresh `TaskClassifier` per draw, via `makeReplayCaller` imported unchanged.** `TaskClassifier`
memoizes on `Bun.hash(task)` per instance, so one instance across ten draws makes one call and nine
memo hits — no call, no cost, no outcome — and produces the same vacuous 1.0. MUB-218 already
constructs a fresh classifier per call for a related reason (an unbilled memo hit could hand back a
label the run never paid for). This lane imports that function rather than writing a second caller,
so the guarantee cannot be edited from here, and pins it two ways: a seam that counts constructions
(ten draws, ten classifiers) and a faux-provider test through the REAL default factory (ten draws,
ten provider calls) beside its negative (one shared classifier, ten asks, one call).

**No temperature is set, anywhere, and the string `'provider default, unset'` is what gets
recorded.** The provider layer is untouched: no knob in `StreamOptions`, none in any adapter.
Anthropic and OpenAI both default to 1.0 when temperature is absent, and the shipped `classify()`
sets none — so drawing at the unset default measures the ACTUAL production distribution, where an
explicit `temperature: 1.0` would measure something production never sends while looking identical.
The column is TEXT because the value is the absence of a setting, not a number; a REAL column would
force this lane to invent one. What that leaves unverified is whether the calls vary at all, which
is the next decision.

**A pilot gates the full run, and the renderer refuses to print a headline without it.** If
default-temperature calls do not actually vary, "perfect self-consistency" is indistinguishable in
the output from "we did not really sample" — and no aggregate figure computed afterwards can tell
them apart. So `checkSamplerNonDegenerate` returns a verdict over a PILOT: the first ten corpus
entries in first-appearance order, ten draws each, ~100 calls. **Abort criterion: fewer than two of
the ten pilot prompts showing two or more distinct `(task_type, difficulty, confidence)` tuples
means the full run is not authorized**, and `renderSelfConsistencyReport` prints an abort banner
instead of a headline figure. The pilot is deterministic on purpose, and the determinism is worth
money: a re-run is a cache hit and its ~100 draws PREPAY the same ~100 draws of the full lane. The
tuple includes confidence because `CLASSIFY_SYSTEM` asks for all three fields, so a run returning
the same pair with a moving confidence is demonstrably sampling; a task-type-only tuple would fail a
working sampler, and a byte-identical-row tuple would pass a broken one.

**The modal frequency of the (task_type, difficulty) PAIR is the primary comparand.**
`CLASSIFY_SYSTEM` says "confidence is how sure you are of BOTH labels", so the self-report is a
claim about the pair. Task-type-alone is always greater than or equal to the pair frequency —
collapsing a difficulty disagreement into agreement can only raise it — so quoting it as the
headline would systematically understate overconfidence. Both are computed, the primary one is
labelled as such in the output, and the mean gap against each is printed side by side so the
understatement is quantified rather than asserted.

## This is repeatability, not consensus

The panel's machinery cannot be pointed at multi-sample votes and must not be adapted to.
`deriveConsensus` de-duplicates by `modelId` (`byModel.set(v.modelId, …)`, last wins) and
`consensusRuleFor` binds `panelSize` to the panel's length, so ten draws from one model reduce to
one vote against a panel size of three and come back `incomplete`, permanently. That is not a
defect to work around: consensus asks "did INDEPENDENT MODELS agree", and this asks "does ONE MODEL
repeat itself". [0001](0001-consensus-label-cache.md)'s "one function derives consensus" survives
here untouched precisely because no second quorum rule was added — this lane never derives one.

## Direction of bias

`gap = selfReport − empiricalFrequency`, per prompt, SIGNED. The sign is the finding.

Bucketed against a resolution band of ±1/(2n) — ±0.05 at n = 10, because an empirical frequency
over n draws lands only on multiples of 1/n and half of that is the finest distinction the
instrument supports. **n here is the draws that prompt actually has, not the `--samples` a reader
passed**: the two can differ (a run stopped at its ceiling, a lane sampled at 4 and read at 10, a
prompt whose last three draws failed), and taking the band from the flag is the direction that
MANUFACTURES a direction of bias — a 0.1 gap over four draws would read `overconfident` on evidence
that cannot resolve it. The readout prints the observed depth beside the nominal n and flags a
mismatch. Above the band, `overconfident`; below, `underconfident`; inside,
**`indistinguishable`, deliberately NOT `calibrated`**. A gap inside the band has not been shown to
be zero, only to be smaller than n draws can resolve, and naming the arm `calibrated` would let a
run at n = 2 (band ±0.25) describe almost everything as calibrated and be quoted as having measured
it. A concrete consequence the type is required to state: a 0.95 self-report against a 1.0 observed
frequency is honestly indistinguishable at n = 10. (`0.95 - 1.0` is `-0.050000000000000044` in IEEE
754, strictly outside a bare 0.05 comparison, so the gap is rounded to the micro before bucketing —
otherwise the single most common self-report in this corpus reports as underconfident.)

A single mean would let a sign flip between subpopulations cancel to zero and read as calibration.
Three guards, all required and all shipped:

1. `meanGap`, `meanAbsGap` and the three-way direction mix are ONE value (`BiasBlock`), so the mean
   is unreachable on its own. The three direction rates share one denominator and sum to it, which
   is what makes "45% over, 45% under" impossible to mistake for "mean ≈ 0, calibrated".
2. Every block is produced per REGIME through the existing `Segmented<T>`, so a whole-corpus figure
   is unreachable without its segments.
3. And per CONFIDENCE BIN over `DEFAULT_CONFIDENCE_BOUNDARIES`, so `CLASSIFY_CONFIDENCE_FLOOR`
   (0.75) is a bin edge. This corpus's self-reports are clustered hard at the top, so the confidence
   axis is where a flip would hide.

## The limitation, printed and not merely documented

**This measures self-consistency, not correctness. A model that is consistently wrong looks
perfectly calibrated by this metric alone.** Ten identical wrong answers score 1.0. Correctness
against a reference is `--score`'s answer (MUB-218) and needs the labels this lane deliberately does
not read, which is also what lets it run on unlabelled traffic. `SELF_CONSISTENCY_LIMITS` is a
constant so the exact wording reaches every rendered report and a test can assert it did.

## The CLI

`--self-consistency` is read-only and is decided INSIDE `decideInvocation`'s `if (!has("spend"))`
branch, appended AFTER `--adjudicate` so no existing precedence moved. That placement is structural:
a mode decided outside the branch could route around a `--spend` refusal.

`--samples=<n>` is parsed forgivingly like `--limit`'s row cap rather than refusingly like
`--max-usd`'s ceiling — it cannot spend on its own and the ceiling still binds — but is **floored at
2**, because at n = 1 the modal frequency is 1.0 by construction for every prompt and not even the
pilot could detect it, there being no second draw for a first to differ from. It lives on
`CorpusScope`, so the dry run's projection and the paid run cannot disagree about n. Every readout
prints the effective n, so a fallback or a clamp is visible in the output rather than inferred from
the command line.

At the default n = 10 the per-prompt denominator is exactly `MIN_REPORTABLE_SUPPORT`, so every
per-prompt figure is reportable and anything below 10 prints as `n/d†`. No readout softens that by
passing a lower `minSupport`: it is the strongest structural argument for the default.

`--pilot` is a MODIFIER on `--spend`, never a verb. It narrows the sampling lane to its pilot on an
argv that has ALREADY earned permission; it adds no route to a billable call, and the invariant
"`spend` is reachable only from an argv carrying both `--spend` and a valid `--max-usd`" is
re-enumerated over it by test.

## Migration version

Append the batch; never insert it, and do not hard-code a version number in its comment. The version
is the batch's array index. `MIGRATIONS.length` was 24 on this branch, so the appended batch is v25.
Counted by `/^  \[/` rather than by bracket balance: the SQL strings contain unbalanced brackets, so
naive counting lies.

## Consequences

- **Three caches, one revision, one key producer.** All three tables key on `promptHash` and filter
  on `CORPUS_REV`; this lane's key shape is `voteKey` applied twice, so the NUL delimiter is
  declared exactly once in the tree. A `corpus_rev` bump re-opens spend on all three lanes.
- **One `--spend --max-usd` covers all three lanes under one `SpendGuard`.** Sampling runs THIRD,
  after the panel and the replay, for 0008's reason: if the money runs out, a repeatability
  measurement over a corpus nothing has labelled is the least useful thing to have bought. And "a
  ledger whose writes are failing stops every later lane" now binds across all three.
- **This is the deepest lane by an order of magnitude** — n calls per prompt where the others take
  one — so its output allowance is where an under-count costs the most. It is priced from
  `REPLAY_OUTPUT_TOKENS = 150`, which 0008 derived from 476 realized calls rather than from the
  shape of the reply. On the 238-entry corpus at n = 10 that projects 2380 calls at $2.0587, with
  the pilot at 100 calls and $0.0857.
- **A stored draw is re-admitted through the shipped parser on the way out**, via
  `isReadableReplayLabel` — the same function, not a copy — and the PLANNER consults the same
  predicate. 0008's amendment records why: if the reader drops a row the planner still counts as
  cached, the cache deadlocks with the readout reporting the entry unsampled and `--spend` answering
  "nothing to pay for", and the only exits are hand-deleting rows or bumping `CORPUS_REV`.
- **An abstention stays in the per-prompt denominator.** Declining is a real outcome of the
  predictive distribution; dropping it would let a model that answers three times in ten report a
  perfect 3/3. It cannot be the modal LABEL, though — a prompt whose every draw abstained has no
  modal label and contributes no gap, and is counted separately.
