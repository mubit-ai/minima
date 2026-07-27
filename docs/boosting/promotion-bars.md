# Promotion bars — what "field-validated" means for TTSR and LSP

TTSR (`MINIMA_TUI_TTSR`) and LSP diagnostics (`MINIMA_TUI_LSP`) ship opt-in "until
field-validated". That phrase had no threshold behind it, so it could never be met and the
flags would have stayed opt-in by default rather than by decision. This file is the
threshold. Numbers are the owner's; the measurement method is what makes them arguable.

Everything below is queried from `events`. `events.payload` is free-form JSON, so the
telemetry needed **no migration** — `ttsr_fire` and `lsp_probe` rows are written by the
harness (`src/cli/main.ts`) and are fail-open: a broken audit write never costs a turn.

## Why this exists at all

The LSP seam-freeze review found a refused-handshake defect that made every edit report
`timeout` and return nothing, silently, for a whole session. Nobody would have remembered
that as "LSP felt bad" — it looks like a slow server. A bar you can only argue from
recollection is not a bar. Note also what the LSP numbers below do to today's build: in a
workspace without local typescript the timeout rate was **100%**, so this bar would have
caught the defect before promotion, without a single session of dogfooding.

## TTSR

The risk is false positives: a tripwire that aborts a turn doing legitimate work. Firings
should be rare, which makes **adjudicating every one of them** feasible — and is also why a
rate-based precision target is the wrong shape.

| Criterion | Threshold |
|---|---|
| Exposure | ≥20 sessions, ≥200 turns, ≥3 distinct repos |
| Firing rate | ≤2% of turns (nuisance ceiling, independent of correctness) |
| **Correctness** | **every firing in the window is adjudicated, and zero are false positives** |
| Anti-vacuity | ≥10 genuine firings adjudicated as correct |
| Cost | retry-induced token overhead ≤1% of trial spend |

**On the correctness clause.** The earlier draft said "≥95% precision with zero false
positives", which is self-contradictory — zero false positives *is* 100% precision, and at
promotion time someone would reasonably argue either reading. The unambiguous formulation is
the one above: a census, not a rate. Every firing is looked at; none may be wrong. If the
window produces so many firings that adjudicating each is impractical, the ≤2% nuisance
ceiling has already failed and promotion stops there anyway.

**On anti-vacuity.** Zero firings across 200 turns is not evidence the tripwire is safe; it
is evidence it never ran, and "no false positives" over an empty set is trivially true. At
least 10 genuine firings must be observed. If natural firings are too rare to reach 10,
provoke them deliberately in a controlled set and count those — a provoked firing still
proves the abort → inject → retry path behaves.

```sql
-- exposure + firing rate
SELECT
  (SELECT COUNT(*) FROM events WHERE type = 'assistant')   AS turns,
  (SELECT COUNT(*) FROM events WHERE type = 'ttsr_fire')   AS fires,
  (SELECT COUNT(DISTINCT run_id) FROM events)              AS sessions;

-- every firing, with its rule and run, for adjudication
SELECT run_id, ts, json_extract(payload, '$.rule_id') AS rule
FROM events WHERE type = 'ttsr_fire' ORDER BY ts;
```

Adjudication is manual and stays manual: whether a given abort was correct is a judgement
about intent, and no proxy in the ledger settles it.

## LSP diagnostics

The risk is different — diagnostics are advisory and additive, so a wrong one is noise. What
matters is whether the feature *works* and what it costs on the tool-result critical path.

| Criterion | Threshold |
|---|---|
| Exposure | ≥500 probes, ≥10 sessions, ≥2 languages |
| Works | `status='ok'` ≥90% of probes on supported extensions |
| Fails loudly | `status='timeout'` ≤2% |
| Latency | p95 ≤900 ms, **warm probes only** (see below) |
| Lifecycle | zero leaked server processes at session end |
| Prerequisite | cold-start strategy chosen and implemented |

**On the p95 clause.** The earlier draft said "p95 ≤900 ms" without saying what it measured,
and against measured cold starts of 1264–1421 ms it was unreachable — the bar would have
failed on arithmetic rather than on quality. Cold start is a one-time project load per
server per session; warm probes run 364–558 ms, including on files the server has not seen
before. So:

- **p95 ≤900 ms applies to warm probes** — every probe after the first for a given server.
- **Cold start is governed separately**, and it is a *prerequisite*, not a criterion: the
  first-edit latency strategy (raise the budget / warm at session start / accept a
  diagnostic-free first edit) must be chosen and shipped before this bar can be run at all.
  Until then the first probe of every session sits within ~80 ms of the 1500 ms budget on a
  fast machine, and over it on a slow one — which shows up as `timeout`, contaminating the
  ≤2% criterion with something that is not a failure of diagnostics.

Distinguishing cold from warm in SQL needs the first probe per `(run_id, ext)`:

```sql
-- status mix (the whole bar's denominator)
SELECT json_extract(payload,'$.status') AS status, COUNT(*) AS n
FROM events WHERE type = 'lsp_probe' GROUP BY status;

-- warm-only latency distribution: drop each run's first probe per extension
WITH p AS (
  SELECT run_id, ts,
         json_extract(payload,'$.ext')        AS ext,
         json_extract(payload,'$.latency_ms') AS ms,
         ROW_NUMBER() OVER (
           PARTITION BY run_id, json_extract(payload,'$.ext') ORDER BY ts
         ) AS seq
  FROM events WHERE type = 'lsp_probe'
)
SELECT ext, COUNT(*) AS warm_probes,
       MAX(ms) AS worst_ms,
       AVG(ms) AS mean_ms
FROM p WHERE seq > 1 GROUP BY ext;
```

(Exact p95 wants a percentile over the ordered set; `worst_ms` and the count are enough to
see whether the bar is anywhere near being met, and the full distribution is one `SELECT ms`
away.)

Leak checking stays out-of-band, the way it was verified during the seam-freeze review:
`pgrep -f <server-binary>` after quitting the harness.

## What promotion actually means

Meeting a bar makes the flag *eligible* to flip, not flipped. Promotion is a deliberate
decision that also updates `tests/kill-switches.test.ts` — moving the row from the opt-in
table to the default-ON table, where `=0` becomes a published rollback promise.
