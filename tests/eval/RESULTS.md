# H1 results & analytics — Minima on LLMRouterBench (frontier suite)

Results of running the H1 cost-savings eval (`CRITERIA.md`) against the modern **LLMRouterBench**
2026 release via the backend built in `docs/PLAN/LLMRouterBench-H1-setup.md`. All runs are
against the **hosted Mubit** API, flat priors (memory-driven), one Mubit lane per run.

## TL;DR

- **The pipeline works end-to-end** against the modern benchmark; all validity guards function
  (and one — the V5 crosscheck — caught a real bug).
- **Minima captures large cost savings** (73–98%) by **tier selection** — picking one
  cost-effective model for the whole workload — and it **beats "always cheapest"** (avoids the
  weakest model). That part of H1 holds.
- **It does NOT do per-prompt routing**, and the trustworthy retention number is still open: the
  5-candidate run's 100% retention is a small-N artifact, and the 12-candidate run *misrouted*
  due to an infrastructure limit (hosted recall caps evidence per model).
- **Headline finding:** candidate count is bounded by recall capacity. Hosted Mubit returns
  ~50 recalled outcomes regardless of the requested limit, so evidence/model ≈ 50 ÷ N. Below
  ~8/model the router misranks models and can pick a **strictly dominated** one. Sweet spot on
  hosted: **≤ ~6 candidates**.

## Runs

| # | Candidates | Split (tr/val/test) | recall_limit | Verdict | Note |
|---|---|---|---|---|---|
| 1 | 5 | 150 / 26 / 35 | 40 | **PASS** (C1-C3) | clean but small-N; collapsed to qwen |
| 2 | 12 | 200 / 39 / 74 | 50 | **FAIL** (V5 crosscheck 0%) | `max_candidates=8` bug — guard caught it |
| 3 | 12 | 200 / 39 / 74 | 120→**50** | **valid; FAIL C3** | crosscheck fixed; evidence-starved misroute |

---

## Run 1 — 5 candidates (PASS, but small-N)

`gemini-2.5-pro, gpt-5, qwen3-235b-a22b-2507, claude-sonnet-4, deepseek-v3-0324`

```
crosscheck 100%   leakage 0%   avg evidence/prompt = 40 (8/model)
HEADLINE: 98.4% cheaper than always-gemini-2.5-pro @ 100% retention
  C1 98.4% (CI 95.5–99.5%) ✓   C2 +0.143 ✓   C3 ✓
```
Router picked **qwen3-235b-a22b-2507 for all 35 prompts** at every slider — on this sample qwen
*tied* premium on accuracy (0.629) at 1/60th the cost, so it Pareto-dominated.

**Caveats:** 100% retention is a small-N coincidence (full-data qwen 0.542 vs gemini 0.598 →
≈91% expected); retention CI **[75%, 131%]** confirms N=35 is too small. Oracle 0.800 vs router
0.629 → real per-prompt headroom the tier-selection misses.

---

## Run 3 — 12 candidates (VALID, FAIL C3) — the analytically rich one

Per-candidate ground truth on TEST (n=74), sorted by accuracy:

| model | acc | cost ($/74) | on Pareto frontier? |
|---|---|---|---|
| gpt-5 | **0.649** | 2.89 | ✅ (top accuracy) |
| gemini-2.5-pro *(premium)* | 0.608 | 4.07 | ❌ dominated by gpt-5 (better *and* cheaper) |
| qwen3-235b-a22b-thinking-2507 | 0.568 | 0.76 | ✅ |
| **qwen3-235b-a22b-2507** | 0.527 | **0.089** | ✅ **the sweet spot** |
| deepseek-r1-0528 *(← Minima picked this)* | 0.500 | 1.106 | ❌ dominated by qwen-thinking |
| deepseek-v3.1-terminus | 0.486 | 0.0995 | ❌ dominated by qwen-2507 |
| glm-4.6 | 0.473 | 0.774 | ❌ |
| gemini-2.5-flash | 0.439 | 0.725 | ❌ |
| claude-sonnet-4 | 0.426 | 0.807 | ❌ |
| intern-s1 | 0.419 | 0.390 | ❌ |
| kimi-k2-0905 | 0.412 | 0.152 | ❌ |
| deepseek-v3-0324 | 0.385 | 0.062 | ✅ (cheapest corner) |

**Pareto frontier:** `gpt-5 → qwen-thinking → qwen-2507 → deepseek-v3-0324`. A good router operates
on this frontier. Note two things: (1) the *premium baseline itself (gemini-2.5-pro) is dominated*
by gpt-5 here; (2) **`qwen3-235b-a22b-2507` is the cost-efficiency star** — 0.527 accuracy at
$0.089, beating every other model's cost-accuracy tradeoff except the two expensive top models.

Baselines (TEST): premium `gemini-2.5-pro` 0.608 / $4.07 · always-cheapest `deepseek-v3-0324`
0.385 / $0.062 (98.5%) · random 0.491 / $0.994 (75.6%) · **oracle 0.824 / $0.504 (87.6%)**.

```
HEADLINE @ slider 1 (validation-selected): 72.9% savings (CI 64–79%), 82.2% retention (CI 68–98%)
  C1 72.9% ✓   C2 +0.115 ✓   C3 FAIL (router cost $1.106 > random $0.994)
```

**What went wrong:** the router picked **`deepseek-r1-0528`** (0.500 acc, $1.106) for all 74
prompts — a model that is **strictly dominated** by `qwen3-235b-a22b-2507` (higher accuracy *and*
12× cheaper). A correct router never picks a dominated model. So C3 failing is a genuine routing
**error**, not a hard-workload artifact.

---

## Why it misrouted: the recall-cap → evidence-starvation chain

1. `avg recall evidence/test-prompt = 50.0` in **both** the recall_limit=50 and recall_limit=120
   runs → **hosted Mubit returns ~50 recalled outcomes regardless of the requested limit.**
2. 50 outcomes ÷ 12 candidates ≈ **4 evidence/model** → Beta-smoothed `predicted_success` is
   noise-dominated → the router can't reliably rank qwen-2507 above deepseek-r1-0528.
3. Run 1 (5 candidates) had 50 ÷ 5 ≈ **10/model** → stable → it correctly found qwen.

So per-model evidence — not training volume — is the binding constraint, and it's set by
`50 ÷ N_candidates`. **≤ ~6 candidates keeps it ≥ 8/model.**

## The deeper finding: tier selection, not per-prompt routing

At the selected slider, Minima picked **one model for the entire workload** in *every* run (qwen
at 5 candidates, deepseek-r1 at 12). It does **workload-level tier selection**, not per-prompt
routing. Consequences:
- Widening 5 → 12 did **not** add routing granularity; it just diluted the evidence behind the
  single tier pick and made it noisier/wrong.
- The **oracle (0.824) vs best single model (gpt-5 0.649)** gap shows ~0.18 accuracy of per-prompt
  headroom exists — but tier selection structurally cannot capture it.
- **Savings is the "easy" axis** here (the premiums are wildly expensive on reasoning prompts —
  gemini $4.07, gpt-5 $2.89 per 74 prompts; even always-cheapest saves 98.5%). The discriminating
  axis is **accuracy/retention**, and that's the one still unsettled.

## Engineering findings (the durable ones)

1. **The V5 crosscheck guard works.** Run 2 failed because `RecommendRequest.max_candidates`
   defaults to **8** (`schemas/recommend.py:26`) and `_select_candidates` truncates to it after
   sorting by capability_prior — flat here, so it dropped an *arbitrary* 4 of 12 in the engine
   while the factored `_pick` scored all 12. Without the crosscheck, the eval would have printed
   numbers that don't reflect the product. **Product gotcha:** passing more `candidate_models`
   than `max_candidates` silently drops the excess.
2. **Hosted recall is capped at ~50 results** (verified: 50 vs 120 limit both yield 50). Plan
   accordingly for many-candidate evals.
3. The pipeline + all guards (V1 leakage 0%, V2 independent prices, V4 flat priors, V5 crosscheck)
   are functioning on the modern benchmark.

## What we can / cannot conclude

**Can:** the H1 plumbing is sound; Minima saves large cost via tier selection and beats
always-cheapest (avoids the weakest model); the modern-benchmark integration is faithful.

**Cannot (yet):** a trustworthy **retention** number (Run 1's 100% is small-N; Run 3's 82% is from
a misrouted, evidence-starved config); whether **per-prompt routing** adds value (it never
engaged); a **clean 12-candidate** result (blocked by the recall cap).

## Recommended next step

Run with **~6 candidates** spanning the frontier (premium → cost-efficiency star → cheap-weak) at
~8–10 evidence/model. Expectation: the router correctly settles on `qwen3-235b-a22b-2507`,
yielding a clean, *Pareto-correct* headline (~70%+ savings at a real, tighter retention) — the
trustworthy version of Run 1, on the richer suite. The recall cap makes 12 candidates a known
negative on hosted; H2's accumulation can't fix it (the cap is on results returned, not stored).
