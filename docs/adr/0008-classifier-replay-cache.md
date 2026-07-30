# 0008 — The classifier replay caches into a table of its own

- Status: accepted
- Date: 2026-07-30
- Written by: MUB-218

## Context

[0001](0001-consensus-label-cache.md) fixed the shape of the reference labels: a `MinimaDb` table
of individual votes, keyed by the sha256 of the exact prompt text, stamped with `CORPUS_REV`, with
the text never stored. MUB-218 re-runs the shipped classifier over the same corpus and has to
persist what it said, for the same reason — a rerun must be free, or every downstream reading costs
another paid pass.

Most of that is [0001](0001-consensus-label-cache.md) applied again, and where it is, this ADR
records nothing new. Three things are not, and each one is a way for a correct-looking number to be
wrong.

## Decision

**A separate table, `classifier_replay_labels`, not more rows in `consensus_labels`.** The columns
are identical and the primary key `(prompt_hash, model_id)` would not even collide — the replay
models are not panelists. It would still be wrong. Those rows are the REFERENCE and these are the
SUBJECT UNDER TEST, and `classifier_eval_score.ts` states its central guarantee structurally: "there
is no input here a historical `task_type` could be passed through, so the constraint is structural
rather than remembered." One table demotes that to a `model_id` filter — `toCachedVotes` and
`indexVotes` both filter on panel membership — and a panel-membership edit would then silently
promote the thing being measured into the thing it is measured against. A separate table keeps the
guarantee a property of the schema.

**The stored `confidence` is the RAW self-report, before `CLASSIFY_CONFIDENCE_FLOOR`.** The floor is
what this whole evaluation exists to argue about. A label filtered on it before storage would leave
the reliability curve with no evidence at all in the region under argument, and the defect would be
invisible: the curve would render, every bin below the floor would simply be empty, and it would
read as "the classifier never reports low confidence" rather than "the cache threw those away."
`runReplay` writes `cls.confidence` unmodified and a test pins a sub-floor value through the round
trip.

**A stored label is re-admitted through the shipped parser's own rules on the way out.**
`classificationFromParts` (exported from `classify.ts` for this, rather than copied) validates
`task_type`, `difficulty` and `confidence` when `toModelReplays` reconstitutes a row. `corpus_rev`
versions the CORPUS — what counts as a prompt — and nothing versions the TAXONOMY. A row written
under a `TaskType` since removed from `schemas.ts` would otherwise come back as a label the scorer
compares against a panel verdict and counts as merely wrong. Rows that fail re-admission are dropped
and counted as `unreadable`, never reconstituted.

**Which outcomes are cached is the shipped classifier's rule, plus one divergence.** A complete
reply that will not parse is a deterministic non-answer for this `(prompt, model)` and is stored as
a NULL `task_type`, so a rerun does not pay for it again. A provider error and a transport failure
or timeout are transient, write no row, and are retried — which is what `classify.ts` already does
by declining to memoize them. The divergence is `length`: `classify.ts` treats a truncated reply as
a reply and parses it, which is safe for an in-memory per-session `Map` that costs nothing to
rebuild and is not safe for a durable, money-backed row. MUB-216 shipped exactly this bug and fixed
it in the panel (`RETRYABLE_STOP_REASONS`); the replay refuses it by construction, through the
`stopReason` that `TaskClassifier`'s new `onOutcome` hook carries out.

## What made the third point possible

`classify()` returns `TaskClassification | null`, which is the right shape for routing — every
non-answer means the same thing there, fail open — and the wrong shape for a caller that caches,
because the three causes cache differently. `TaskClassifier` gains `onOutcome`, an additive
observational hook alongside the existing `onCostUsd`, with the same guarantees: it is never
consulted, a throw from it cannot break classification, and a memo hit reports nothing because
nothing happened. The alternative was a second classifier in the replay, which would have measured
something other than what production does while looking identical.

## Consequences

- **Two caches, two revisions, one key producer.** Both tables key on `promptHash` and filter on
  `CORPUS_REV`, and `planReplayRun` takes both the hash and the key shape injected rather than
  re-implementing either. Two hashes that disagreed would produce a total cache miss and report it
  as "the classifier has not labelled this corpus" — a defect wearing a finding's clothes.
- **A `corpus_rev` bump re-opens spend on BOTH lanes.** They are independent: adding a replay model
  costs one lane, changing the steer predicate costs both.
- **One `--spend --max-usd` covers both lanes under one `SpendGuard`.** Two guards at the stated
  number would together permit twice it. The panel runs first, deliberately: if the money runs out,
  the half worth keeping is the reference the other half is scored against.
- **The projection was 2.4x low and the guard is what caught it.** `LABEL_OUTPUT_TOKENS = 40` is
  reasoned from the reply the instruction asks for; the shipped classifier really emits ~132 tokens,
  because models wrap the one-line label in prose. The first paid run stopped at 135 of 476 calls
  having spent $0.1046 against a $0.0848 projection for all of them, kept every label it had bought,
  and said so. `REPLAY_OUTPUT_TOKENS = 150` now prices the replay legs from that measurement.
  `LABEL_OUTPUT_TOKENS` is deliberately NOT changed: MUB-216's cached panel run was costed against
  it, and `outputTokensPerCall` is per-model precisely so a leg can state what it actually costs.
  This is [0006](0006-spend-ceiling-binds-outstanding-work.md)'s "a panelist reasoning server-side
  can beat the projection" arriving from an unexpected direction — a model that does not reason at
  all, just talks.
- **The context-size hint cannot be replayed, and that is a property of the ledger, not a choice.**
  `classify()` appends `[session context: ~N tokens already in play …]` when given one and
  production always gives one. Nothing records N — `UserPromptRow` is `{id, run_id, ts, agent_id,
  text}`, a `user` event's payload is `{role, text}`, and no ledger column anywhere is a token
  count — and a corpus entry could not carry one even so, its unit being distinct TEXT over several
  askings with different contexts behind them. [0005](0005-panel-answers-shipped-classify-instruction.md)
  settled the same question for the panel and anticipated this. So the classifier and the labels it
  is scored against were asked the same question, and the omission is a bias against PRODUCTION
  rather than between the two sides of the comparison. `renderReplayCoverage` prints the direction
  it argues for — higher self-reported confidence here than production sees, hence a floor derived
  from this curve reading slightly permissive when transplanted — and prints that it is an argument
  from the instruction's wording rather than a measurement. Falsifying it needs a run at a synthetic
  N, which is a new ticket.

## Migration version

Append the batch; never insert it, and do not hard-code a version number in its comment. The version
is the batch's array index. `MIGRATIONS.length` was 23 on this branch and `schema_meta.version`
read 23 on the live ledger, so the appended batch is v24. Counted by `/^  \[/` rather than by
bracket balance: the SQL strings contain unbalanced brackets, so naive counting lies.

## Amendment — bounds the review found

Four defects on the billable path, all fixed, all recorded here because each is a rule the next
paid lane has to inherit:

- **The replay caps output; production does not.** `classify()` sets no `max_tokens`, so a provider
  falls back to `model.max_tokens` — 8192 for `claude-haiku-4-5`. The guard bounds DISPATCH, not
  completion, so a full concurrency width of replies free to run to that ceiling can overshoot an
  accepted `--max-usd` by dollars on a run projected in cents. `REPLAY_MAX_TOKENS = 1024` is the
  same divergence the panel already takes, and it cannot change a measurement: it is ~8x the ~132
  tokens these models emit, no call in 476 stopped on `length`, and a capped reply is discarded as
  `truncated` rather than stored. `TaskClassifier` takes `maxTokens` as an option defaulting to
  undefined, which every provider reads as `options.max_tokens ?? model.max_tokens` — so the
  routing path's request is unchanged.
- **"Persistence is the product" binds across lanes, not within each.** A panel whose writes are
  failing is a ledger that will reject the replay's rows too; the replay lane no longer starts.
- **`labelled` and `unusable` count rows the ledger ACCEPTED**, incremented after the write returns.
  A call whose write was rejected is `unstored` — its own count, because it is neither a failed call
  (the money bought a real answer) nor a stored row, and folding it into either misstates what a
  rerun still owes.
- **An unreadable row is not a cache hit.** `isReadableReplayLabel` is consulted by the PLANNER as
  well as the reader, so what one drops the other re-buys. Without it the two disagree and the cache
  deadlocks: `--score` reports the entry unreplayed and says to run `--spend`, `--spend` answers
  "nothing to pay for", and the only exits are hand-deleting rows or bumping `CORPUS_REV` — which
  re-opens the paid panel lane for a taxonomy change that never touched the corpus.
