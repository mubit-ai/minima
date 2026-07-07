# Benchmark criteria — does Minima's router cut cost without sacrificing accuracy?

**Status:** pre-registered acceptance criteria. Decide these BEFORE running, so the result is
a verdict and not a story we tell about whatever number came out.

---

## 1. The claim we are testing (falsifiable)

> **H1:** Routing with Minima costs materially less than *always using the premium model*,
> while keeping accuracy close to the premium model — and it achieves this by being
> **intelligent** (beating "always cheapest" and "random" routing), not merely by being cheap.

- **Null hypothesis (H0), what we'd accept as "Minima doesn't work":** Minima saves no
  meaningful cost, **OR** it saves cost only by giving up accuracy (i.e. it does no better
  than always-cheapest or random routing).

> **H2 (self-learning):** Minima's recommendations *improve as feedback accumulates*. A warm
> Minima (memory full of prior outcomes) routes strictly better — cheaper at equal accuracy, or
> more accurate at equal cost — than a cold, stateless Minima (empty memory). The improvement
> comes from the *correctness* of the feedback signal, not merely from having more rows of data.

- **Null for H2:** memory growth produces no reliable lift over the cold baseline, OR shuffled
  (signal-free) feedback lifts performance as much as real feedback.
- A result only counts if it could have come out the other way. If every possible run
  "passes", we measured nothing.

> **H1 is a snapshot question; H2 is a movie question.** They need different experiments — see
> §10. The shipped `harness.py` answers H1 only (it seeds memory once, then scores).

---

## 2. The unit of measurement

A **task** = one prompt with a knowable-correct answer. For each task and each candidate
model we must have BOTH:

| Signal | Meaning | Where it comes from |
|---|---|---|
| `correct(task, model)` ∈ {0,1} | did that model's answer pass a checker | RouterBench label (path A) or a per-task checker we write (path B) |
| `cost(task, model)` ∈ USD | the real token cost of that call | RouterBench cost column (A) or measured `usage` tokens × price (B) |

A **policy** maps `task → chosen model`. The whole benchmark is a comparison of policies
over the same task set, scored on the same ground truth.

---

## 3. Metrics (exact definitions — no hand-waving)

Over a held-out **TEST** set of N tasks, for a policy P:

```
accuracy(P) = (1/N) · Σ_tasks correct(task, P(task))
cost(P)     =          Σ_tasks cost(task,    P(task))
```

Then, always relative to the premium baseline:

```
savings(P)   = 1 − cost(P) / cost(always_premium)        # higher = cheaper
retention(P) = accuracy(P) / accuracy(always_premium)     # 1.0 = no accuracy lost
```

`savings` and `retention` are the two numbers the whole exercise produces. Every claim is a
point on the (savings, retention) plane.

---

## 4. Baselines — all four are required

A savings figure is meaningless without a comparator. We measure four policies besides Minima:

| Baseline | Role | What it proves about Minima |
|---|---|---|
| **always_premium** | the cost target to beat | Minima is *cheaper* |
| **always_cheapest** | the dumb-cheap policy | Minima is *intelligent*, not just cheap (it must be more accurate) |
| **random** | coin-flip floor | Minima beats chance on both axes |
| **oracle** (cheapest model that *would* have succeeded) | theoretical ceiling | how much headroom is left; sanity upper bound |

---

## 5. Acceptance criteria (PASS / FAIL)

The operating point (the cost↔quality slider) is chosen on a **VALIDATION** split and the
verdict is read on the **TEST** split at that fixed slider. No tuning on test.

**Minima PASSES iff ALL of:**

| ID | Criterion | Threshold | Rationale |
|---|---|---|---|
| **C1 — savings** | `savings(Minima) ≥ 0.30` | 30% cheaper than always-premium | a real, not rounding-error, cost cut |
| **C2 — not naive** | `accuracy(Minima) ≥ accuracy(always_cheapest) + 0.05` | +5 accuracy points | proves it *avoids* the weak/cheap model on hard tasks |
| **C3 — dominates random** | `accuracy(Minima) ≥ accuracy(random)` **AND** `cost(Minima) ≤ cost(random)` | Pareto-dominance | better on *both* axes than blind routing |
| **C4 — retention** | `retention(Minima) ≥ 0.95` *where the workload allows* | **reported, not a hard gate** | on hard-only slices only the premium model reaches 95%; we report the full retention frontier so the trade-off is visible rather than asserting a bar the data can't support |

**Self-learning criteria (H2 — see §10 for metric definitions):**

| ID | Criterion | Threshold | Rationale |
|---|---|---|---|
| **L1 — learning lift** | `accuracy(warm) ≥ accuracy(cold) + 0.03` at a fixed slider (or the savings analog at fixed accuracy) | +3 accuracy points, **with a bootstrap CI on the delta that excludes 0** | proves feedback *improves* routing — the not-stateless claim |
| **L2 — positive trend** | probe performance rises with memory size: Spearman ρ(memory_size, metric) > 0, final checkpoint ≥ first beyond CI noise | monotone-ish up | the lift is a *curve*, not a lucky endpoint |
| **L3 — signal not volume** | `real_lift > shuffled_lift` | strict | improvement comes from *correct* feedback, not just more data (negative control) |
| **L4 — convergence** | report `convergence_K` (feedback records to reach 90% of `warm − cold`) | **reported, not gated** | "how much data until it's useful" — a practical number, not a pass bar |

Plus: **report `savings` and `retention` with 95% bootstrap confidence intervals.** A point
estimate without a CI is not a result — it's a guess with extra decimals. For L1, the CI is on
the *delta* (warm − cold) — that it excludes 0 is the whole claim.

> These thresholds are a **decision**, not a law. 30% / +0.05 are the values the shipped eval
> uses (`test_routerbench_savings.py`). If you want a stricter or looser bar, change it *here,
> before running* — and write down why.

---

## 6. Validity guards (disqualifiers)

If ANY of these fails, the run is **void** regardless of how good the numbers look. These are
the ways an eval lies to you.

| ID | Guard | The threat it closes |
|---|---|---|
| **V1 — no leakage** | no TEST prompt is a near-duplicate of a TRAIN prompt; report the near-twin fraction | otherwise the router "recalls the answer" → measures memorization, not generalization |
| **V2 — no circularity** | the prices the router uses to *decide* are independent of the costs it's *scored* on | otherwise the cost metric is just a transform of the router's own input → rigged |
| **V3 — no cherry-picking** | slider chosen on validation, reported on test | otherwise we're picking the operating point that flatters the test set |
| **V4 — no baked-in oracle** | capability priors are flat (0.5); routing is driven by recalled memory | otherwise a train-fitted prior, not the memory system, makes the decision |
| **V5 — it's the real engine** | a sample re-runs the full `Recommender.recommend()` and must match the factored scoring (≥80%) | otherwise we benchmarked a lookalike, not the product |
| **V6 — causal ordering** (H2) | a recommendation at checkpoint *j* uses ONLY feedback from earlier checkpoints; probe tasks are NEVER fed back into memory | the temporal analog of V1: predict before you learn, or the curve is just leakage over time |
| **V7 — ingest barrier** (H2) | fed-back outcomes are confirmed recallable before the next checkpoint is scored | Mubit embeds on ingest with lag; without this the curve reflects *ingest timing*, not learning |

---

## 7. What a passing result looks like (template to fill in)

```
candidates       = [weak+cheap, strong+cheap, mid, strong+premium]
premium baseline = <model>          train=<n> val=<n> test=<n> (dropped <k> near-dup rows)
leakage          : near-twin fraction = <p>%   (V1: must be low)
engine crosscheck: factored↔endpoint = <p>%    (V5: must be ≥80%)

baselines on TEST:
  always_premium    acc=____  cost=$____   savings=  0.0%
  always_cheapest   acc=____  cost=$____   savings=____%
  random            acc=____  cost=$____   savings=____%
  oracle            acc=____  cost=$____   savings=____%   (ceiling)

Minima @ selected slider:
  savings   = ____%   (95% CI [__%, __%])      → C1: ≥30%?   [PASS/FAIL]
  retention = ____%   (95% CI [__%, __%])      → C4 reported
  vs cheapest: +____ accuracy                  → C2: ≥+0.05? [PASS/FAIL]
  vs random : more accurate AND cheaper?       → C3:         [PASS/FAIL]

VERDICT: H1 supported / not supported
```

---

## 8. Where each criterion already lives (Path A — RouterBench replay)

The shipped harness already instantiates this spec:

- Metrics & baselines — `harness.py:_baselines` (372), `fill()` savings/retention (510)
- C1/C2/C3 assertions — `test_routerbench_savings.py` (SAVINGS_FLOOR=0.30, +0.05, dominance)
- C4 frontier + bootstrap CIs — `harness.py:_bootstrap_ci` (355), frontier (536)
- V1 leakage — `_filter_neardup` (207) + `leaky_fraction` (589)
- V2 circularity — independent `_MARKET_PRICES` (62)
- V3 validation selection — operating-point selection (521)
- V4 flat priors — `build_catalog` (242)
- V5 engine crosscheck — `_crosscheck` (403), asserted ≥0.8

Run: `MUBIT_ENDPOINT=… MUBIT_API_KEY=… uv run --extra seed pytest -m eval -s -q`
Smoke-test small first: `MINIMA_EVAL_TRAIN_N=150 MINIMA_EVAL_TEST_N=40`.

---

## 9. If we also do Path B (live A/B on our own tasks)

The metric definitions in §3–§4 are **identical**. What changes:

- **Ground truth is now ours to produce:** we must write a `checker(answer, expected)` per task
  (the hard part), and we measure `cost` from the provider's real `usage` token counts.
- **Thresholds may loosen:** N is small (tens, not hundreds), so CIs are wide — treat it as a
  confirmation/anecdote, not the headline statistic.
- **New guard:** the checker must be trustworthy (deterministic, not "ask an LLM if it's right"
  unless that judge is itself validated).
- **What's new to build:** recommend → actually run *both* recommended and premium models →
  check both → tabulate. (`test_cost_savings_spotcheck_live.py` measures real tokens but does
  NOT route through Minima, so it doesn't answer H1.)

---

## 10. The self-learning dimension (H2) — does it improve with feedback?

§1–§9 measure a **snapshot**: seed a fixed memory, then route. That answers *"given accumulated
memory, does it route well?"* — it does NOT prove Minima learns. The shipped harness is a batch
design: `seed_train` (`harness.py:258`) loads all training outcomes at once, `_barrier` waits
until recallable, then it does one recall per probe and scores. **Freeze-frame, not a movie.** A
stateless router with good priors could pass §1–§9. H2 needs a *temporal* experiment.

### The method — predict-before-you-update (a learning curve)

| Design | How | Trade-off |
|---|---|---|
| **Prequential / streaming** | process tasks in order; for each, recommend using only earlier memory, then feed back the outcome; report rolling-window performance | leakage-free by construction, realistic; but the test tasks differ each window → noisy curve |
| **Fixed-probe learning curve** *(recommended)* | hold out a fixed leak-free probe set; grow memory in K-record increments (checkpoints 0, K, 2K, … full); re-score the SAME probe at each checkpoint; plot vs memory size | clean apples-to-apples yardstick; **checkpoint 0 = cold/stateless baseline**, asymptote = warm; more expensive (re-probe each checkpoint) |

### Learning metrics (exact definitions)

```
cold = probe performance at memory size 0      (stateless Minima)
warm = probe performance at full memory

learning_lift_acc     = accuracy(warm) − accuracy(cold)   # at a fixed slider/cost
learning_lift_savings = savings(warm)  − savings(cold)    # at a fixed accuracy target
convergence_K         = #feedback records to reach 90% of (warm − cold)
```

### Negative control (the honesty check that makes L3 meaningful)

Run a third arm: **shuffled feedback** — same volume of outcomes, but with the model↔outcome
labels permuted so the *signal* is destroyed and only the *volume* remains. If shuffled feedback
lifts performance as much as real feedback, the eval is measuring "rows in the DB," not learning.
`real_lift > shuffled_lift` is the claim (L3).

### What a learning result looks like (template)

```
probe set = <M> fixed leak-free tasks      checkpoints = [0, K, 2K, …, full]
shuffles averaged = <s>   (curve is order-dependent; average ≥3 seeds)

  memory_size   accuracy   savings    (real feedback)
        0        ____       ____       <-- COLD (stateless)
        K        ____       ____
       2K        ____       ____
      ...        ____       ____
     full        ____       ____       <-- WARM

  learning_lift_acc = warm − cold = ____   (95% CI [__, __])   → L1: ≥+0.03 & CI excludes 0?  [PASS/FAIL]
  trend ρ(size, acc) = ____                                     → L2: > 0?                     [PASS/FAIL]
  real_lift ____  vs  shuffled_lift ____                        → L3: real > shuffled?         [PASS/FAIL]
  convergence_K = ____ records to 90% of lift                   → L4: reported

VERDICT: H2 supported / not supported
```

### Status: NOT yet built

The fixed-probe learning curve is **net-new**, but `harness.py` reuses cleanly (same recall +
`_pick` scoring path). Building it means: incremental `seed_train` in K-sized chunks, a `_barrier`
after each chunk (V7), re-score the held-out probe at each checkpoint (V6 — never feed the probe
back), and a third shuffled-label arm. Reuse the existing leakage filter (`_filter_neardup`) to
keep the probe clean against the growing train stream.
