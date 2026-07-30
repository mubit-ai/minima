# 0010 — The adjudication reads the shipped classifier's replay, and only that

- Status: accepted
- Date: 2026-07-31
- Written by: the confidence-arc wiring pass — `df33e11` · reads
  [0008](0008-classifier-replay-cache.md)

## Context

MUB-218 replayed two classifier models over the corpus and cached both
([0008](0008-classifier-replay-cache.md)), but `buildOverrideReport` still took its replay map as a
third parameter defaulting to an empty one — so `--adjudicate` scored 0 of 177 candidates and set
175 aside as "no-replayed-label" while 476 paid labels sat in the ledger. Joining the cache in is a
few lines; WHICH of the two replayed models it joins is the decision this records.

## Decision

**Only the shipped classifier is adjudicated.** `OVERRIDE_REPLAY_MODELS` is
`REPLAY_MODELS.slice(0, 1)` — the first entry, which is the model production actually resolves:
`cli/main.ts` builds its `TaskClassifier` from `config.classifyModel ?? CHEAP_FALLBACK_MODELS[0]`,
`config.ts` defaults `classifyModel` to null, and `CHEAP_FALLBACK_MODELS[0]` is `claude-haiku-4-5`
(`6e39718`). The second replay model is priced, not shipped: `REPLAY_MODELS`' own docstring puts it
there because it is cheap and its API can return token probabilities — the capability a later
confidence ticket would need — so what it buys is an answer to "what does the switch cost", not a
label for traffic the harness sent. Adjudicating its labels, or falling back to them where the
shipped model has no row, would measure an override channel production never opens, and every
symptom of that reads as a legitimate finding: more scored rows, a fuller sweep, a floor argued off
a classifier nobody runs.

`slice(0, 1)` rather than `[REPLAY_MODELS[0]!]`, because `noUncheckedIndexedAccess` is on: an
emptied model list degrades to "no model has a usable row" — a state this module already handles —
instead of throwing at module load.

**Three states are one non-answer, and none is ever filled from the other model.** No stored row, a
stored abstention (`task_type` NULL — paid for, deterministic, and deliberately kept distinct from
a gap by `toModelReplays`), and a row whose taxonomy no longer re-admits all reach
`buildOverrideCandidates` as `harnessLabel: null` / `harnessSelfReport: null`. The entry still
becomes a candidate and `scoreCandidates` sets it aside as `no-replayed-label`, so the candidate
denominator every exclusion count is read against never silently shrinks.

**The join is `toModelReplays`, the same function `--score` reads the cache with.** One
corpus-revision filter, one model filter, one re-admission rule, one hash. A lookup hand-rolled in
`resolveOverrideReplay` would have been a SECOND join, free to disagree with the coverage printed
beside `--score`'s numbers while both readouts looked right. For the same reason the rows are not
pre-filtered with `isReadableReplayLabel`: `toModelReplays` applies the shipped parser itself and
COUNTS what it drops as `unreadable`, and filtering first would change no label while zeroing that
diagnostic.

**`CLASSIFY_CONFIDENCE_FLOOR` is applied zero times as a filter on this path.** It enters twice and
neither is a filter: as `overrideFloor` it decides `serviceLabelOverridden`, a statement about what
the LEDGER recorded rather than about the replay; as `currentFloor` it re-enters `thresholdCandidates`
as one coordinate of the sweep, beside the observed self-reports, plus the "shipped floor" marker in
the rendered table. `harnessSelfReport` stays the RAW stored value that
[0008](0008-classifier-replay-cache.md) took care to store unmodified. A replay filtered on the
floor would delete the evidence in the exact region the sweep exists to argue about — and it would
still render, every sub-floor row simply missing. `tests/classifier-eval-seam.test.ts` pins it with
a 0.30 label that scores.

**The defaulted parameter is deleted, not re-defaulted.** A defaulted empty map is the defect
itself; with no parameter left, the empty case is reachable only from an empty cache. The readout's
scope suffix then names the model actually read, derived from the resolution rather than from the
model set — the set says which model is eligible, only the join says which one had a usable row.

## What it changed, on the live ledger

| | before | after |
|---|---|---|
| candidates | 177 | 177 |
| scored | 0 | 124 |
| set aside: `no-replayed-label` | 175 | 8 |
| set aside: `panel-split` | 0 | 42 |
| set aside: `panel-incomplete` | 0 | 1 |
| set aside: `spans-regime-boundary` | 2 | 2 |

The exclusions that appear are the ones the replay was previously masking: a candidate is walked
through the reasons in order and stopped at the first, so 42 genuinely split panels and 1 incomplete
one could not be reported until the replay stopped accounting for them. 124 + 53 = 177 still.

The result: 85 corrections, 3 harms, 25 no-ops, 11 both-wrong, net +82; 64 rows before the boundary
netting +40 and 60 after netting +42 with zero harms; 124/124 corroborated. The aggregate is quoted
here only beside both segments, for [0003](0003-regime-boundary.md)'s reason.

## Consequences

- **The adjudication now measures ONE model, so a model switch invalidates it.** Setting
  `MINIMA_CLASSIFY_MODEL`, giving `config.classifyModel` a default, or reordering
  `CHEAP_FALLBACK_MODELS` makes every figure above describe a classifier production no longer runs —
  and nothing about the readout would look wrong. Two tests hold the tie: `classifier-replay.test.ts`
  pins `REPLAY_MODELS[0].model.id` to `CHEAP_FALLBACK_MODELS[0]`, and `classifier-eval-seam.test.ts`
  pins `OVERRIDE_REPLAY_MODELS` to exactly that one model. A switch is expected to fail them.
- **`no-replayed-label` cannot distinguish "never asked" from "declined".** Its 8 entries mix a
  missing row, an abstention and an unreadable row, which are three different facts — one about the
  run's coverage, one about the classifier failing open, one about the taxonomy having moved.
  `ReplayResolution` keeps them apart per model and `--score` prints the split; the adjudication
  does not, because separating them is a new exclusion reason and `EXCLUSION_REASONS` is a reviewed
  partition that `scored + excluded = candidates` is read against. The number is small enough not to
  carry an argument, which is the only reason this is acceptable.
- **The other model's labels stay cached and stay free.** Nothing was deleted, so pricing the model
  switch on this corpus is still a readout away and still costs nothing — it is simply not this
  readout, and a lane that wants it must say so rather than inherit it.
- **A ledger with rows for only the priced model reads as no replay at all.** That is the honest
  answer for this readout — it adjudicated nothing — but it means the header can say "(no classifier
  replay recorded)" over a ledger that holds several hundred paid labels. `--score` is where those
  labels are visible.
