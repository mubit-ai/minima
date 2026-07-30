# 0004 — "unassessable" is not "uncorroborated"

- Status: accepted
- Date: 2026-07-30
- Written by: MUB-225 · read by MUB-218 and MUB-226

## Context

Every measurement in this arc compares two labels, and some rows carry only one: no display label to
check a pairing against, no reference verdict to score a replay against. The MUB-225 review
(`4540463`) found the correlation counting those as comparison FAILURES, and the fix introduced a
vocabulary that MUB-218 and MUB-226 now both depend on — recorded until now only in the code that
uses it.

## Decision

**A third value, never a default.** `Corroboration = "corroborated" | "uncorroborated" |
"unassessable"` (`corroborate` in `classifier_eval_correlate.ts`, `56a62ce` / `4540463`). An
unassessable row leaves both the numerator and the denominator of the reported rate: it is on
neither side of the comparison, because there was no comparison. Two causes reach it — no label
stored, and a prompt row carrying no text — and both are non-observations rather than outcomes.

**The same word, the same meaning, wherever the arc has nothing to compare.** MUB-218 carries
`unassessable` as a distinct `ScoreOutcome` beside `incorrect`, for a corpus entry with no reference
verdict to score against (`scoreReplay` in `classifier_eval_score.ts`, `7645e52`). MUB-226 collapses
an entry's pairings through `entryCorroboration`: an entry whose pairings are all unassessable
collapses to unassessable, and only assessable pairings decide the rest
(`classifier_eval_adjudicate.ts`, `0fc2703`). The word was borrowed rather than coined twice, so one
vocabulary spans the three tickets.

## Rejected alternative

Two values, with the third folded into whichever side is convenient. Both folds are wrong, in
opposite directions:

- counted as `uncorroborated` / `incorrect`, an unassessable row is a failure the system never had —
  the reported rate is understated and the failure count carries non-observations;
- counted as a success, it is a corroboration nothing supports — the rate is overstated.

Neither is the neutral choice a default would have to be. That is the entire argument for a third
value: there is no defensible two-valued answer, so the type has to admit that a row can be outside
the measurement.

## Consequences

- Every rate in the arc has three populations behind it, and the readouts print the third
  (`corroborationUnassessable`, rendered as "nothing to compare" beside the corroborated and
  uncorroborated counts). A reader given all three can compute a two-valued rate; a reader given a
  two-valued rate cannot recover the third.
- The same distinction applied twice more is why MUB-218 also holds `abstained` and `unreplayed`
  apart from `incorrect`: a classifier failing open by design, and a corpus entry that never reached
  the classifier, are each "no answer" rather than a wrong one, and folding either into `incorrect`
  charges the classifier for something else's behaviour.
- It is a structural decision, not a numeric one. Corroboration `unassessable` reads 0 on this
  ledger; the fold was systematically wrong regardless. On the scoring side the population is not
  hypothetical — 57 of the 238 corpus entries resolve no reference verdict (56 split panels, 1
  incomplete), and it is `unassessable` that keeps them out of the accuracy denominator rather than
  in it as wrong answers.
