# 0007 — `task_type` is the service's decision, and only while `client_task_type` is null

- Status: accepted
- Date: 2026-07-30
- Written by: the confidence-arc wiring pass — `d01ddd5`, review findings in `be9a22b` · read by
  MUB-226

## Context

`listRoutingDecisions` selected six columns and none of them was a task type, so MUB-226 — whose
whole subject is what an override would have replaced — reported the service's own label unreadable.
`routing_decisions` carries four task-type-ish columns; they are not interchangeable, and picking
the wrong one measures the wrong population with every symptom looking like a finding.

## Decision

The read takes all four together (`d01ddd5`), and `task_type` is the service's decision:

- **`task_type`** — the server's FINAL label: `classified_task_type` off the recommendation, which
  is `classification_profile.final_task_type`. The label the service actually routed on, and the one
  an override would have replaced. It also reproduces MUB-226's motivating figure exactly, where the
  other three do not.
- **`client_task_type`** — the HARNESS classifier's own label, recorded raw (pre-floor, telemetry
  only). NULL on all 494 rows: that classifier has never run.
- **`heuristic_task_type`** — the server's LEGACY regex opinion, reported even when another
  classifier won. Set on 39 of 494 rows and disagreeing with `task_type` on 24 of them, so it is the
  server's second opinion and never its label.
- **`classify_disagreement`** — NULL on all 494 rows. It needs a client classification, and it
  compares the client against the HEURISTIC rather than against the label an override would replace,
  so the ledger does not already record what MUB-226 reconstructs even when it is populated.

Because `task_type` is final, the server echoes a winning caller override back into it. It is
therefore the service's OWN decision only while `client_task_type` is null — true on all 494 rows
here, and asserted rather than assumed, which is why the read carries that column at all.
`serviceLabelOverridden` (`classifier_eval_wiring.ts`) is checked first and drops such a row under
the `service-label-overridden` exclusion, since adjudicating it would score the classifier against
its own output.

## The invariant: the tripwire cannot see a caller-supplied task type

`serviceLabelOverridden` is a tripwire, not a proof, and the gap is structural rather than a
weakness in the predicate (`be9a22b`).

`runtime.ts` skips the client classifier entirely when the caller supplies a task type — the
classify block is guarded on there being no effective task type already — so `client_task_type` is
null on exactly the rows where a caller override happened. That type is sent as `task_type` on the
recommend request (`router.ts`), returns as `classified_task_type`, and is written to the `task_type`
column by `writeDecision`. No column on that path records where the label came from, so a
caller-supplied type is indistinguishable in the ledger from the service's own.

The service does say. `ClassificationProfile` carries `task_type_source` and `caller_task_type`
(`schemas.ts`), and `router.ts` reads neither — it lifts only `heuristic_task_type` and
`heuristic_difficulty` off the profile — so the answer never reaches the insert.

**Closing this needs a new column, not a better predicate.** No query over the current schema
recovers it, because the fact is not in the schema. Anyone reading `serviceLabelOverridden = false`
on 494 rows and concluding "no overrides" has read it wrong: it says no HARNESS-classifier override,
on a ledger where that classifier has never run.

## Consequences

- MUB-226's exclusion counts are honest about the harness classifier and silent about caller
  overrides. The exposure is latent — the option exists on `promptRouted` and on the agent's
  constructor — and the day it is used there is no ledger signal that would tell a later reader it
  had been.
- Quoting the before/after catch-all pair takes its population with it. `task_type` gives 110/321
  (34.3%) before the regime boundary and 129/173 (74.6%) after, but the 321 denominator includes 68
  pinned/offline rows that never asked the service and 69 with no task type, where the 173 has
  neither. Like for like it is 43.7% → 74.6% (`be9a22b`).
