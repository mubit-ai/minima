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

---
---

# RESULTS

*Everything above this line was committed at `0445e9d`, before the join produced a number.*

```
bun packages/tui/scripts/logprob_proxy_probe.ts        # free, read-only, no network
```

## The population reconciles exactly against `--score`

```
corpus entries                                   238
no reference label (split/unvoted/incomplete)    -57   -> 181   = the readout's 181
replay abstained (stored null)                   -14   -> 167   = the readout's 167 scored
no self-consistency draws                         -2   -> 165   JOINED
        correct 146 · incorrect 19 · accuracy 88.5%
```

The two dropped entries were both correct, so `--score`'s 148/167 (88.6%) becomes 146/165 (88.5%)
here. Nothing else moved. That the chain lands on 181 and 167 — the readout's own two figures,
derived through the shipped resolvers rather than restated — is what says this join and `--score`
agree.

## Verdict: all three conditions FAIL

| | condition | threshold | measured | |
| -- | -- | -- | -- | -- |
| **L1** | separation | ≥ 15 pts, control < 15 | **8.1 pts** (control 1.5) | ✗ **FAIL** |
| **L2** | reach with value | ≥ 25 entries moved | **net is negative at every threshold** | ✗ **FAIL** |
| **L3** | monotonicity | rises across ≥2 reportable bins | **83.3 → 72.7 → 72.4 → 94.7** (inverted) | ✗ **FAIL** |

**The signal question is now closed on its own evidence rather than on absence of it.** §4's
DO-NOT-BUILD is stronger than it was written: it stood on the channel argument alone, and now the
signal argument stands too, independently.

## But the signal is real — it just has no profitable gate

Recording this because the failure above is easy to over-read. Repeatability **is** more informative
than the self-report. It is not enough, which is a different claim from "it is nothing":

```
rank statistic — P(a correct row scores above an incorrect one), 0.500 = no information
  modal task-type frequency   0.695     <- real, weak-to-moderate discrimination
  modal pair frequency        0.620
  raw self-report             0.580     <- the CONTROL, near chance
```

And the bin table's true shape is not the smooth curve L3 tested for — it is **a step at unanimity**:

| | accuracy |
| -- | -- |
| modal frequency **= 1.00** (all 10 draws agree), n=113 | **94.7%** |
| modal frequency **< 1.00**, n=52 | **75.0%** |

A **19.7-point** accuracy step, on a predictor that costs one flag to read. That is a genuine signal
and the self-report has nothing like it.

**So why does no gate profit from it?** Two reasons, both structural rather than statistical:

1. **The base rate is 88.5%.** With 19 errors in 165 rows, any gate spends right answers to buy
   wrong ones at a ratio the corpus sets. Dropping everything non-unanimous catches **13 of 19
   errors (68%)** and costs **39 of 146 right answers (27%)** — 3 : 1 against.
2. **6 of the 19 errors sit at modal frequency 1.00.** The classifier is *confidently, repeatably
   wrong* on them: ten draws, ten identical answers, all disagreeing with the panel. No repeatability
   signal can see these, and no logprob would either — they are exactly the failure mode §1.2's
   `[self]` caveat named ("ten identical wrong answers score 1.0"). **A third of this classifier's
   errors are invisible to any confidence signal by construction.**

The sweep is also **generous to the gate and still negative everywhere**: it scores a dropped-wrong
as a pure win, when in production dropping the override means falling back to the service label,
which is right on 22.6% of adjudicated rows. Priced properly the column is worse than printed.

## Secondary: majority vote is worth +2 rows

```
single replay label     146/165 (88.5%)
modal label, 10 draws   148/165 (89.7%)      +2 rows, at 10x inference cost
```

Not a logprob and not what MUB-220–223 propose. Recorded so nobody proposes it later as if it were
untested: **10× the classify spend buys two rows.**

## The feasibility check that closes it independently

Live probe against the API, 2026-07-31 (`request_id` in the transcript):

```
POST /v1/messages  model=claude-haiku-4-5  "top_logprobs":5
  -> 400 invalid_request_error: "top_logprobs: Extra inputs are not permitted"
POST /v1/messages  model=claude-haiku-4-5  "logprobs":true
  -> 400 invalid_request_error: "logprobs: Extra inputs are not permitted"
POST /v1/messages  model=claude-haiku-4-5  (control, no such param)
  -> 200, content "Hi"        <- the rejection is about the PARAMETER, not the model
```

**The shipped classifier cannot return a logprob at all.** `git grep -i logprob` is empty across both
trees, and it is empty because there is nothing to read.

The escape hatch is the other replayed model — OpenAI **does** return them:

```
gpt-4o-mini, top_logprobs:3  ->  "Hello" -0.00091 · "Hi" -7.00091 · "hello" -16.75091
```

But `gpt-4o-mini` is priced in `REPLAY_MODELS` precisely because it is **not** what production calls,
and on the identical 165 rows:

| model | logprob available? | accuracy, same rows |
| -- | -- | -- |
| `claude-haiku-4-5` (shipped) | **no** | **146/165 (88.5%)** |
| `gpt-4o-mini` | **yes** | 133/165 (80.6%) |

**Switching providers to obtain the signal costs 13 rows of accuracy — 7.9% of the joined set.** The
headroom a perfect signal competes for is F3's 11 net rows, 8.9% of the 124 adjudicated rows.

> Those two are **not subtractable**: different denominators (165 vs 124) and different quantities
> (raw accuracy vs net override value). Stated as shares because that is the only honest comparison
> available, and the point survives it — the cost of acquiring the signal and the entire prize it
> competes for are the same order of magnitude, pointing opposite ways. The trade is not obviously
> favourable and is certainly not free. Making it exactly comparable needs an adjudication re-run
> under a swapped classify model, which is a paid ticket nobody has opened.

## What this changes

**Nothing about the recommendation.** DO-NOT-BUILD stands, now on two independent legs instead of one:

- **the channel** (unchanged, F3): +74 from a boolean against +11 for a perfect signal;
- **the signal** (new): 8.1 pts separation, no profitable gate at any threshold, a third of errors
  invisible by construction, and the shipped provider exposes no logprob to begin with.

**One thing it does change.** Readout §4.2 ("what DO-NOT-BUILD does not claim") says the call rests
on the channel being off and not on probabilities being useless. That caveat was correct when
written and is now **narrower**: on this corpus, at this base rate, a probability signal is measured
and it does not pay. The caveat should now read as being about *other corpora and other base rates*,
not about this one.

**What is still not tested.** A true logprob at exact precision, on a model that returns one, at a
base rate where errors are common enough for a gate to profit. All three would have to change
together. The n=10 proxy attenuates rather than manufactures separation, so 8.1 pts is a floor and
not a ceiling — but it would have to reach 15 to clear L1, and L2 fails for reasons precision cannot
fix, because L2 fails on the *ratio of right to wrong answers a gate touches*, not on the predictor's
resolution.

