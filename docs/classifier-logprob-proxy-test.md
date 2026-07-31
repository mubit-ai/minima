# Does a token-probability signal predict correctness where the self-report does not?

**Status:** preregistration. Written before the join was computed; results land in a second commit.
**Date:** 2026-07-31
**Corpus:** `r2-observer-steer`, unchanged. No new spend — this reads draws already bought.

---

## Why this document exists, and what it is not

Phase 1 concluded DO-NOT-BUILD on MUB-220–223 (readout §4). That call rests on **F3**: a perfect
gate over the adjudicated rows is worth `+85`, the shipped floor already banks `+74`, so the entire
prize a better confidence signal competes for is **11 net rows**, against **74** sitting unclaimed
because a boolean is `false`.

Nothing below can move F3. F3 is arithmetic over a ceiling.

What phase 1 never measured is a narrower question the owner asked directly: the readout shows the
**self-report** carries no information (§1.2, twice over), and it shows the classifier's **empirical
repeatability** is 79.3% with a mean absolute gap of +0.2014 (§1.2, `[self]`). It never crossed the
two. So there is no evidence in the arc about whether *repeatability* predicts *correctness* —
which is the closest observable proxy this ledger holds for what a logprob would report.

**This test is exploratory, not preregistered by MUB-219.** I said otherwise in conversation and
that was wrong: §7.2's preregistered re-test is entirely about live production traffic, gated on
`client_task_type IS NOT NULL >= 100`, with thresholds on harms, corrections and floor reach. It
contains no self-consistency-versus-correctness condition. Since no threshold was fixed in advance,
the thresholds below are fixed **now**, in a commit that precedes the one carrying the numbers.

---

## The proxy, and how good a proxy it is

A logprob is `P(label token)` read straight off the sampling distribution. This ledger has no
logprobs (`git grep -i logprob` is empty tree-wide). What it has is **10 draws per prompt at the
provider's default temperature** — so the modal-label frequency is a Monte-Carlo estimate of the
same distribution, at n=10.

| | 10-draw modal frequency | true logprob |
| -- | -- | -- |
| resolution | 0.1, band ±0.05 | exact |
| what varies | the whole generation (type, difficulty and confidence all resample) | the label token alone |
| cost | 10 calls | 1 call, one flag |
| bias | unbiased estimator of the same quantity | — |

It is a **noisy but unbiased** stand-in. A signal that fails here at n=10 could still succeed at
exact precision; a signal that succeeds here is real, because noise in the predictor attenuates
measured separation rather than manufacturing it. That asymmetry is why a positive result is
informative and a null result is weaker evidence than it looks.

## Population

The join is the intersection of three sets, on full `promptHash` at one corpus rev:

1. a **reference label** — unanimous panel only, `REFERENCE_CONSENSUS`, the scorer's own rule;
2. a **shipped-classifier replay label** — `claude-haiku-4-5` alone, `OVERRIDE_REPLAY_MODELS`,
   because `gpt-4o-mini` is priced but never shipped;
3. **≥1 readable self-consistency draw**.

Derived with the instrument's own functions (`resolveReferenceVerdicts`, `toModelReplays`,
`reduceSamples`, injected `promptHash`) and never a second hand-rolled join — the arc's standing
rule, and the reason `--score` and `--adjudicate` agree today.

**Predictor is the modal `task_type` frequency, not the pair.** The readout's `[self]` block makes
the `(task_type, difficulty)` pair primary, correctly, because `CLASSIFY_SYSTEM` defines the
self-report as sureness of both labels jointly. But the thing being scored here is `task_type`
against a `task_type` reference, so the pair would be a predictor of a quantity nobody is scoring.
Pair frequency is reported alongside as a secondary.

**Control is the raw self-report on the same rows** — same population, same denominator. Without
it "modal frequency separates correct from incorrect" is unfalsifiable, because the claim under
test is comparative: *where the self-report does not.*

---

## Thresholds, fixed now

Let `sep(x)` = mean of predictor `x` on correct rows − mean on incorrect rows, in percentage points.

| # | condition | **counts as signal at** |
| -- | -- | -- |
| **L1 · separation** | `sep(modalFreq)` on the joined rows | **≥ 15 points**, *and* `sep(selfReport) < 15` on the same rows. Both halves required: the claim is comparative. |
| **L2 · reach** | entries a modal-frequency gate could move, best threshold | **≥ 25 entries** (15% of 167 — the same bar §7's F4 set for the floor, so the two are read on one scale) |
| **L3 · monotonicity** | accuracy across modal-frequency bins, reportable cells only (n≥10) | **rises across ≥ 2 reportable bins**, no inversion between them |

**All three must hold** for the signal question to reopen. L1 alone is a correlation with no
demonstrated lever; L2 alone is reach with no signal; L3 alone is a shape that two cells can produce
by chance on this corpus.

### What passing does and does not license

Passing **does not** overturn DO-NOT-BUILD. F3's ceiling is untouched: even a perfect signal is
worth 11 net rows against the switch's 74, and that ordering is arithmetic, not an estimate.

Passing **does** mean the phase-2 line was closed on the *channel* argument alone and not on the
*signal* argument, that the readout's §4.2 caveat ("what DO-NOT-BUILD does not claim") is
load-bearing rather than decorative, and that a logprob deserves reconsideration **at the point the
override channel is switched on** — §6's item 1, which is already recommended first.

Failing means the signal argument now stands on its own evidence rather than on absence of it, and
§4 is stronger than it was written.

### The known confound, named before the result

The replay label is one draw; the modal frequency is computed from ten *other* draws of the same
model on the same prompt. If a prompt is unrepeatable, the single replay draw is closer to a coin
flip among the labels it wanders between — so "low modal frequency → more often wrong" is partly a
statement that **one draw of an unstable prompt is unreliable**, which is the mechanism a logprob
gate is meant to exploit, not an artifact that spoils it.

It becomes an artifact only if read as *"the classifier is worse on these prompts."* It is not: it
is *"one sample of the classifier is worse on these prompts."* The distinction matters because the
cheap fix it implies is **majority-vote over k draws**, not a gate. That is reported as a secondary
below, and it is a different intervention from the one MUB-220–223 propose.

### Secondary, reported but not gated

Accuracy of the **modal label** (majority vote over the 10 draws) against the same reference, versus
accuracy of the single replay label. This costs 10× at inference and is not a logprob, so it is not
what this test is about — but it is measurable for free here and it bears on §6.

### Sample-size honesty

The joined population is bounded above by 167 scored entries and will be smaller. Per-bin cells
will be single-digit in places. `MIN_REPORTABLE_SUPPORT` (n≥10) applies exactly as it does
everywhere else in this arc: cells below it are printed with `†` and never quoted as a percentage.
L3 is defined over reportable cells only, for that reason.
