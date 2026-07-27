# Infra blocker — hosted Mubit recall is unstable across identical queries

**Status:** blocks any downstream routing evaluation (Leg B of the classifier A/B, and the
`tests/eval` V5 crosscheck generally). **No classifier change can unblock it.**

**Attribution: NOT the ricedb `fix/control-vector-search` bug.** Tested and refuted — details
below. This needs its own root cause.

Probe: `scripts/eval/classifier_ab/recall_probe.py` · raw data `reports/data/recall_probe.json`
· lane `minima:recallprobe-76cb4f9a`, 60 seeded entries, 2026-07-28.

## What is broken

Five *identical* queries, same lane, same `limit=25`, seeded index at rest:

| pair | Jaccard of returned entry ids | identical order |
|---|---:|---|
| run0·run1 | 0.724 | no |
| run0·run2 | 0.724 | no |
| run0·run3 | 0.613 | no |
| run0·run4 | 0.667 | no |
| run1·run2 | 0.786 | no |
| run1·run3 | 0.852 | no |
| run1·run4 | 0.724 | no |
| run2·run3 | 0.667 | no |
| run2·run4 | 0.667 | no |
| run3·run4 | 0.724 | no |

- **0 of 10 pairs returned the same ordering.**
- **4 distinct top-5 orderings across 5 identical calls.**
- **33 distinct entry ids surfaced across the five calls, at a limit of 25** — roughly a
  quarter of the result set drifts in and out per call.

The instability is in the **tail**, not the head: the top-5 is stable in *composition* and
correct (see below). It is the ranks below that churn — which is exactly the region that
supplies evidence-per-model once a request spreads a fixed recall budget across N candidate
models.

### Why this blocks V5

`tests/eval/harness.py:_crosscheck` compares a pick derived from cached recall against a pick
derived from a fresh recall. With ~24% of the evidence set churning between two calls, the two
picks disagree on a large fraction of prompts regardless of what is being tested. The A/B
measured **0.50** against a 0.80 floor (and 0.25 on a second arm). `RESULTS.md` recorded
**100%** on 2026-06-12, so this is a regression, not a standing limitation.

## What is NOT broken — the ricedb hypothesis, tested

`ricedb@fix/control-vector-search` (`c76f5eb` on `-dev`, `4f72faa`; 2026-07-14; unmerged,
awaiting deploy) describes the control query handler's lane filter dropping every semantic
result for callers that ingest **without lane tags — naming Minima's `batch_insert`** — and
falling through to a recency fallback returning "a UUID-ordered, query-independent result set
with a constant placeholder score of 0.5."

The dates bracket neatly (healthy 2026-06-12 → root-caused 2026-07-14 → broken 2026-07-27), and
this probe seeds through exactly that untagged `batch_insert` path. **Every one of that
failure's signatures is absent:**

| Predicted by the bug | Observed |
|---|---|
| constant placeholder score ≈ 0.5 | 24 distinct scores out of 25; range 0.428–0.711 |
| degenerate / absent semantic component | `semantic` 0.99, 0.99, 0.99, 0.99, 0.76 … real and discriminative |
| recency-ordered fallback | `rank_by: "balanced"`; `recency: 0.0` on every entry |
| query-independent result set | queries discriminate cleanly (below) |

Query sensitivity, three topically orthogonal probes against one lane holding 20 entries per
family:

| query | top-5 family mix | full-25 family mix |
|---|---|---|
| python | **python 5** | python 12, finance 11, cooking 2 |
| cooking | **cooking 5** | cooking 15, python 6, finance 4 |
| finance | **finance 5** | finance 14, cooking 10, python 1 |

5/5 own-family at the head for all three. Jaccard between *orthogonal* queries is 0.19–0.22,
against 0.61–0.85 between *identical* ones — a clean separation, which is what a working
semantic index looks like and the opposite of what the recency fallback would produce.

So either that fix is already live in hosted, or it never affected this path. Either way the
observed failure is a different defect and the attribution should not be carried forward.

## Ask

Root-cause non-deterministic top-k selection in hosted recall: same query, same lane, same
limit, index at rest, ~24% membership churn and never a stable ordering. Candidates worth
checking first: unstable tie-breaking among near-equal fused scores, ANN search
non-determinism, or cross-replica/shard inconsistency in the fan-out.

Until it is fixed, `tests/eval`'s V5 crosscheck cannot pass and no downstream routing result
from this harness is trustworthy — including any future re-run of the classifier's Leg B.
