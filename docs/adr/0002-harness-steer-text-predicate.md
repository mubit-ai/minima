# 0002 — One predicate owns what counts as harness-authored user-role text

- Status: accepted
- Date: 2026-07-30
- Implemented by `bcf0122` on `fix/observer-steer-predicate` (unmerged at the time of writing)

## Context

The observer writes its advisory notes into the user role, and `isHarnessSteerText` did not key on
their `[observer] ` prefix. Both consumers were therefore wrong in the same way from one omission:
the transcript drew the observer's claims as a full "▸ you" bubble, and the evaluation corpus
counted them as things a developer had asked for.

## Decision

Widen the shipped predicate. `OBSERVER_STEER_PREFIX` is exported from `stop_gate.ts` beside the
other steer prefixes, added to `isHarnessSteerText`, and the observer builds its note from that
constant — so the prefix and the message it describes cannot drift apart.

## Rejected alternative

A local prefix check in `classifier_eval.ts`. Its `partitionSteerText` docstring forbids precisely
that: *"The shipped predicate decides — never a prefix check re-implemented here, which would drift
the moment a new steer kind is added."* This was that drift, arriving on schedule. A two-line local
fix would have corrected the corpus and left the transcript still misattributing the same messages,
and the next steer kind would need fixing in both places.

## Consequences

- The corpus is 238 distinct prompts, not 243: five distinct observer steers left it, and raw steer
  exclusions went 41 → 46. Any figure quoted from a dry run before this change describes a
  different corpus — under [0001](0001-consensus-label-cache.md) that is a `corpus_rev` bump, and
  it is the change the revision column exists to make visible.
- Both callers changed behavior from one edit, which is the seam working as intended: the transcript
  compacts observer steers to a dim harness line, and the corpus drops them. The full text stays
  model-visible in both cases; only the projection changes.
- Anything that later needs to treat harness text differently — a new steer kind, a new consumer —
  extends this predicate rather than pattern-matching near its own call site.
