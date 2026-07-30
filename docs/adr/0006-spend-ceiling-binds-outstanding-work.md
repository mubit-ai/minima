# 0006 — The spend ceiling binds outstanding work, not the arc

- Status: accepted
- Date: 2026-07-30
- Written by: MUB-216

## Context

`--spend` refuses to run without a stated `--max-usd`. Under
[0001](0001-consensus-label-cache.md) votes are cached one row per `(prompt_hash, model_id)`, so
what a run actually buys is whatever the cache does not already hold — the whole corpus on the first
run, and nothing at all on a rerun.

## Decision

**The ceiling is checked against the projected cost of the outstanding work.** `planPanelRun` splits
each panelist's corpus into `todo` and `cached`; `projectPanelCost` prices only the `todo` legs;
`summarizeOutstanding` reports that beside the cached share as a `Rate` over corpus × panel; and
`checkSpendCeiling` (`classifier_eval.ts`) compares the stated ceiling against that figure alone
(`23fc234`). Cached votes are free to re-read, so a ceiling priced against the whole corpus every
time would refuse runs that spend nothing.

**A second ceiling on realized cost, the same number.** `makeSpendGuard(maxUsd)` takes the same
`--max-usd` and is consulted before every dispatch, because the projection is a chars/4 heuristic
over declared prices and a panelist reasoning server-side can beat it. It bounds DISPATCH, not
completion: in-flight calls still finish and still bill, so realized spend can exceed the ceiling by
the cost of those calls (`23fc234`; the guard belongs here rather than in MUB-215 for the reason
argued in `23f197d`).

## Consequences

- **The same ceiling means different things on a cold and a warm cache, so a ceiling is not a budget
  for the arc.** `--max-usd 3` admitted the cold run that bought 681 calls for $2.6693 against a
  $2.7911 projection, and it admits a rerun today that projects $0.0000 with 714/714 votes cached —
  where the run exits through the "nothing to pay for" arm without consulting the ceiling at all.
  The two runs read identically on the command line.
- To reason about total spend, a reader has to add up realized cost per run from the run reports. No
  single invocation reports it and no ledger row carries it either: the votes table stores labels,
  not prices. The one invocation where the ceiling and the arc's cost coincide is the first one,
  where outstanding IS the corpus.
- A `corpus_rev` bump or a new panelist re-opens spend without any ceiling changing, because both
  make previously-cached work outstanding again. That is what the revision column is for, and it is
  also how an unchanged ceiling starts permitting a purchase it did not permit before.
- The ceiling is required and has no default. `suggestCeilingUsd` prints the smallest ceiling that
  would admit the current projection, carrying no headroom on purpose, so headroom for the realized
  cost is added deliberately rather than inherited.
