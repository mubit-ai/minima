# 0003 — The regime boundary stays at the classifier's revision, not its change of author

- Status: accepted
- Date: 2026-07-30
- Written by: the regime-boundary investigation · read by MUB-226 and MUB-218

`REGIME_BOUNDARY_TS` stays at `1784738496` (v0.14.0). It marks a **revision** of the service's
classifier, which is the boundary MUB-224 measured and the one its question needs; the later change
of label **author** (v0.14.2) is a different boundary answering a different question, and the data
cannot support segmenting on it. The docstring beside the constant was corrected in `d20036e`; the
constant itself did not move.

## Context

The constant reproduces MUB-224's quoted 321/173 split exactly, but three findings made it
contestable: v0.14.2 shipped the embed classifier — a change of label author — and splits the same
494 decisions 452/42; the catch-all rate had already jumped a day *before* the pinned instant; and
no decision falls in the 19-hour gap the instant sits in, so the data cannot locate it.

Two different questions were in play, and one constant cannot serve both:

- MUB-224 asks **how big the opportunity in the service's labels is, and whether it is stable enough
  to quote as one number.** Its user story 12 wants segmentation *"so that I am never shown a blended
  average as a property of the system"* — a guard against blending, not a treatment effect.
- MUB-226 restates the same boundary as *"the label's author changed partway through the corpus …
  an aggregate that blends two different label authors describes nothing."*

MUB-226's sentence is false at the boundary it segments on. At `1784738496` the author did not
change: `c071670` is a revision of the same rule-based `classify.py`. MUB-224's text (*"the
classifier producing those labels materially changed"*) and MUB-224's number (110/321, 129/173) both
name v0.14.0 and agree with each other. MUB-226 inherited its parent's constant while substituting a
stronger rationale the constant does not carry — so the **text** is the error, not the constant.

## Decision

**Keep `1784738496`.** It is MUB-224's boundary arithmetically and textually, and the arc's question
is MUB-224's.

**Do not move to the author change.** It is the weaker cut on its own terms. Like for like — routed
to the service *and* carrying a task type — the catch-all rate barely moves across it: 217/383
(56.7%) then 22/42 (52.4%). Segmenting there does not protect against the blend MUB-224 exists to
prevent. It also costs MUB-226 most of its support (below).

**Answer the author question with provenance, not with a timestamp.** `router.ts` reads
`cluster_key_version` and `classification_profile.heuristic_task_type` off the server's recommend
response, so the server stamps which program labelled each row. 39 rows carry the stamp, and on them
the embed classifier and the heuristic **disagree on 24 of 39 (61.5%)** — the two authors observed
directly on the same prompts. That instrument is independent of this constant and strictly better
than any instant-based split.

## What the data cannot establish

**The boundary instant.** No decision falls between 2026-07-22T14:28:08Z and 2026-07-23T09:33:57Z,
so every instant in that 19-hour gap — including a naive midnight cut — yields the same 321/173. The
release record pins it; the data is silent. This is true of *this* boundary only: the v0.14.2 author
change sits in a still larger gap (2026-07-23T15:49:17Z → 2026-07-25T00:21:23Z, ~32.5h) but is
nonetheless identifiable, because the provenance stamp above does not depend on a timestamp.

**That the classifier caused the step.** `classify.py` is byte-identical from `94c75ac`
(2026-07-02) until `c071670`, yet across that one fixed labeller the like-for-like catch-all rate
steps 42/158 (26.6%) on 2026-07-03..07-20 to 68/94 (72.3%) on 07-21..the boundary. A **45.7-point
step under an unchanged labeller**, larger than the 30.9-point step across the boundary itself.
Nothing in the seven releases published on 2026-07-21 (v0.12.3 → v0.13.2) touches the labeller; the
two `recommender/` commits that day are `24658d4` (`engine.py`) and `c696c45`
(`engine.py`, `escalation.py`). **A rate that moves without a release is a finding about the traffic.**

**Any regime difference, attributed to the label author.** Regime is perfectly confounded with
working day — R1 spans 12 days and 136 runs, R2 is exactly **one calendar day** (2026-07-23) and 14
runs, R3 is 3 days and 9 runs. No version's traffic interleaves with another's, so there is no
contrast that separates "the classifier changed" from "the work changed." Segmenting here is honest
as a **refusal to blend**. It is not evidence about the classifier, and no reader should promote it
to one.

**How many regimes exist.** Three by the release record, zero the data can license. Denominators are
`routed='server' AND task_type IS NOT NULL` unless stated:

| regime | all rows | like-for-like | catch-all | days | runs |
| -- | -- | -- | -- | -- | -- |
| R1 pre-v0.14.0 | 321 | 252 | 110 (43.7%) | 12 | 136 |
| R2 v0.14.0→v0.14.2 | 131 | 131 | 107 (81.7%) | 1 | 14 |
| R3 post-v0.14.2 | 42 | 42 | 22 (52.4%) | 3 | 9 |

## Consequences for MUB-226

**Its adjudication scores 0 rows today, on any boundary.** 177 candidates are offered; 175 are set
aside as `replay gave no usable label` because MUB-218's replay has never run, and 2 for spanning the
boundary. Every four-way cell, every sweep row and every by-service-label bucket prints `0/0 (n/a)`,
and the derived floor prints `NONE`. Until the replay lands, the boundary choice changes nothing
about the readout, and this constant is unfalsifiable by the artifact that consumes it.

**Once the replay runs, the boundary decides the support.** The same 177 candidates split 103/72
(2 spanning) at v0.14.0 and 154/22 (1 spanning) at v0.14.2 — the author reading leaves **22 corpus
entries**, not the 42 decisions a row count suggests. In those 22 the service's initial-route labels
are `other=9 code=8 tool_use=2 reasoning=2 creative=1`: **every task type single-digit**, so
MUB-226's own unreportable rule consumes the entire after-side breakdown, and its central
deliverable — *"a floor derived as the self-report threshold where corrections exceed breakages,
with counts shown per candidate threshold"* — has no support at all. At v0.14.0 the after side is 72,
where the four headline cells are thin but reportable and `other=44` / `code=14` clear single digits
(6 of 8 types still unreportable).

**MUB-226's provenance paragraph needs correcting on the ticket**, replacing "two different label
authors" with the revision it actually segments on, and recording the author change as a separate
boundary with 22-row support. Deliberately not done here: this lane does not edit tickets.

**Every rate in this arc must keep naming its denominator.** MUB-224's headline pair, 110/321
(34.3%) and 129/173 (74.6%), is not like-for-like: the "before" 321 carries 68 pinned/offline rows
that never asked the service and 69 rows with no task type, and the "after" 173 carries neither.
Like for like it is 110/252 (43.7%) then 129/173 (74.6%). The step is real either way; the quoted
pair is not the comparison it sounds like. This is the fifth settled figure in this arc to have
measured a population it did not name.
