# Benchmarks & methodologies to satisfy the eval criteria

**Companion to `CRITERIA.md`.** It answers: *which public benchmarks, datasets, and
methodologies can we actually use to satisfy each criterion we wrote down?*

Produced by a deep-research run: 5 search angles → 20 sources fetched → 100 claims extracted →
**25 adversarially verified (2-of-3 votes to kill a claim), 0 killed.** Every headline finding
rests on a peer-reviewed primary paper (COLM / ICLR / NAACL / ACL) plus a released HuggingFace
dataset or GitHub repo; the RouterBench finding is independently corroborated by Minima's *own*
working code.

### Confidence legend
- **[3-0]** / **[2-1]** — adversarial verification vote (unanimous / split-but-confirmed).
- **[lead]** — source surfaced in the run but its specific claims were **not** in the verified
  set. Treat as a pointer worth following, not an established fact. Verify before relying.

---

## TL;DR — what to use

| Dimension | Verdict | Use this |
|---|---|---|
| **H1** — savings vs accuracy retention vs always-premium | **Solved, off-the-shelf** | **RouterBench** (already wired into Minima's harness). Optionally upgrade to **LLMRouterBench** for a 2026 model pool with real per-call tokens+cost. |
| **H2** — online/sequential self-learning | **No ready-made artifact exists anywhere** | **MixLLM** as the methodology *template* (contextual bandit + offline→online continual training + Oracle + simulated feedback) on top of a RouterBench replay, plus the standard **prequential** evaluation method (Gama / scikit-multiflow / MOA). The §10 fixed-probe curve + shuffled control remain **net-new to build** — confirmed. |

The single most important research finding: **the (correct, cost) signal pair our §2 Path A
requires is shipped, ready to score offline, by several public datasets — but the self-learning
loop (§10) is not benchmarked by anyone publicly.** That asymmetry is the whole story.

---

## Part A — H1 artifacts (cost savings vs accuracy retention)

All of these can be scored **offline without re-running any model**, because each record carries
a per-(prompt, model) correctness label. They differ in whether they also ship cost, how fresh
the model pool is, and whether the label is objective correctness or subjective preference.

| Artifact | Scale | Correctness label | Cost / tokens shipped? | Released | Confidence |
|---|---|---|---|---|---|
| **RouterBench** | 405,467 outcomes / ~36,497 prompts × 11 LLMs × 8 datasets | binary exact-match (structured) + [0,1] GPT-4 rating (chat/code/RAG) | **Yes** — per-call USD | HF `withmartian/routerbench`, repo `withmartian/routerbench` | **[3-0]** |
| **LLMRouterBench** | 391,645 tuples / 23,945 prompts × 33 models × 21 datasets | `ground_truth` + `score` | **Yes** — `prompt_tokens`, `completion_tokens`, `cost` | HF `NPULH/LLMRouterBench`, repo `ynulihao/LLMRouterBench` | **[3-0]** |
| **RouteLLM** data | `lmsys-55k` (57,477) + `gpt4_dataset` (~119,101) | human **preference** / GPT-4-judge 1–5 | **No** (derive from token pricing) | HF `routellm/*`, repo `lm-sys/RouteLLM` | **[3-0]**, release **[2-1]** |
| **Hybrid LLM** (MixInstruct) | 20k (10k/5k/5k) × 11 responses | BARTScore quality | indirectly (binary large/small) | HF `llm-blender/mix-instruct` | **[2-1]** |
| **MixLLM** | RouterBench + Llama-3.1 ext. | inherits RouterBench | inherits RouterBench | arXiv:2502.18482 (see Part B) | **[3-0]** |
| RouterEval, RouterArena | — | — | — | repos exist | **[lead]** |

### A1 — RouterBench *(recommended for H1; already in the codebase)* **[3-0]**

The canonical artifact and the path of least resistance: **405,467 inference outcomes** across
**11 LLMs, 8 datasets** (MMLU, HellaSwag, Winogrande, ARC, GSM8K, MBPP, MT-Bench, + a RAG set)
and 64 tasks. Each record carries **both** a per-(prompt, model) performance label **and** a
per-call USD cost (proprietary = API pricing; open-source = Together AI). Correctness is binary
exact-match for structured tasks and normalized [0,1] GPT-4 ratings for conversational/code/RAG.

- **Why it's decisive for us:** Minima *already consumes exactly this dataset*.
  `src/minima/seeding/routerbench.py:detect_model_columns` pairs each `<model>` score column
  with its `<model>|total_cost` USD column, and `harness.py:prepare_rows` (lines 186–201) reads
  both `scores[m]` and `costs[m]` for every candidate. So H1 Path A is *operational today*.
- **Reusable methodology — AIQ:** RouterBench's standard metric is **AIQ (Average Improvement
  in Quality)** — the cost-normalized area under the cost-quality curve, computed over the
  **non-decreasing convex hull (Pareto frontier)** of routing strategies. This is a single-number
  summary of the *whole* (savings, retention) frontier — a useful complement to our §7
  point-estimate template (which reports one selected operating point). **[3-0]**
- **Repo pipeline:** `convert_data.py` (normalize formats) → `evaluate_routers.py` (emit
  long-format results CSV + `EvaluationCollection`) → `visualize_results.py` (performance-vs-cost
  plot), config-driven via `configs/*.yaml` with `AbstractRouter`/`AbstractConvertor` extension
  points. **[3-0]**
- HF: `withmartian/routerbench` (0-shot + 5-shot, 1.47 GB). Paper: arXiv:2403.12031 (COLM 2024).
- **Caveat:** the 11 models are 2023-era (GPT-4-1106, Mixtral, etc.). Fine for a methodology
  proof; not representative of a 2026 production pool.

### A2 — LLMRouterBench *(recommended upgrade for a fresh model pool)* **[3-0]**

The largest and freshest alternative (Findings@ACL 2026): **391,645 query-model tuples** from
23,945 prompts across **21 datasets** and **33 models** (20 lightweight ~7B + 13 flagship from 8
providers), ~1.8B tokens, ~$2,771.84 to collect. Standardized JSON schema:
`origin_query, prompt, prediction, ground_truth, score, prompt_tokens, completion_tokens, cost`
— i.e. it ships **real per-call token counts and cost**, collected from OpenRouter and official
APIs, not estimated.

- **Reference H1 numbers:** top routing methods reach **up to +4% accuracy over Best Single**,
  *or* **up to 31.7% cost reduction while matching Best Single**.
- Released: GitHub `ynulihao/LLMRouterBench`, HF `NPULH/LLMRouterBench` (1.28 GB, ~187
  monthly downloads), plus Baidu Netdisk (password `mmbf`) + Google Drive mirrors.
- **Caveats:** the "+4% / 31.7%" are *best-case ceilings* for the top methods — **several routers
  fail to beat Best Single**, commercial OpenRouter routing scored **−24.7%**, and a **~19%
  relative gap to Oracle persists**. The HF dataset *viewer* currently throws a WebDataset config
  error, but the files remain accessible via the file browser / GitHub / mirrors.
- **For us:** the strongest candidate to *replace* RouterBench as the Path A backend, but the
  harness is currently hard-wired to `routerbench_0shot.pkl`'s `<model>|total_cost` columns — see
  the open question in Part E about the schema-adapter work.

### A3 — RouteLLM data **[3-0 on numbers; release 2-1]**

UC Berkeley / LMSYS (ICLR 2025). Useful mostly for its **concrete reference operating points
against always-using-GPT-4** (directly our H1 baseline framing):

- Matrix-factorization router: **95% of GPT-4 performance using only 26% GPT-4 calls** (~48%
  cheaper than random); **14% of calls (75% cheaper)** with data augmentation.
- Headline **>85% cost reduction on MT-Bench** (45% on MMLU, 35% on GSM8K) at 95% of GPT-4
  performance. Model pairs: GPT-4-Turbo vs Mixtral-8x7B; Claude 3 Opus vs Llama 3 8B.
- Data: `lmsys-arena-human-preference-55k` (57,477 rows; `model_a/model_b/prompt/response_a/
  response_b/winner_*`) and `routellm/gpt4_dataset` (~119,101 rows: `prompt, source,
  gpt4_response, mixtral_response, mixtral_score` 1–5 GPT-4-judge). The latter is what the
  Anyscale `llm-router` tutorial trains on.
- **Two caveats that matter for our criteria:** (1) labels are **subjective preference / quality
  judgments, not objective correctness** — weaker evidence for our `correct(task,model)` than
  RouterBench's exact-match; (2) **neither dataset ships per-call cost** — the H1 cost axis must
  be derived externally from GPT-4/Mixtral token pricing before it satisfies §2 Path A.

### A4 — Hybrid LLM / MixInstruct **[2-1]**

ICLR 2024 binary cost-quality router. Reference point: **up to 40% fewer large-model calls at no
quality drop**; per-pair drops at a 40% cost-advantage of 0.2% (Llama-2 7B↔13B), 2.9% (Llama-2
13B↔GPT-3.5-turbo), 10.3% (FLAN-t5-800m↔Llama-2 13B); 22% fewer GPT-3.5-turbo calls at ~1% drop
(BARTScore). Data: **MixInstruct** (10k train / 5k val / 5k test, 11 responses each;
HF `llm-blender/mix-instruct` with BLEU/ROUGE/BERTScore/BARTScore). Narrower (binary router,
quality-score labels) than RouterBench; useful as a cross-check, not a primary backend.
The 2-1 vote was a methodological-scoping dissent, not a factual refutation.

---

## Part B — H2 methodology (online / sequential self-learning)

**The gap, confirmed [3-0]:** RouterBench and essentially all H1 artifacts are **batch/offline
only**. RouterBench evaluates supervised batch routers (KNN, MLP) and cascades on a 70/30 split —
no online, streaming, prequential, or bandit/regret methodology. **No public benchmark ships a
ready-made sequential streaming-feedback split with per-step correctness+cost and a shuffled-label
negative control.** Our §10 (the fixed-probe learning curve + L3 control) is therefore net-new —
exactly as the spec already flagged. The good news: we don't have to invent the *methodology*,
only the *harness*.

### B1 — MixLLM: the closest transferable template **[3-0]**

MixLLM (NAACL 2025, arXiv:2502.18482) is the strongest existing model for what §10 describes:

- A **dynamic contextual-multi-armed-bandit router** evaluated on **streaming queries that
  arrive sequentially**, with an explicit **offline → online continual-training stage**, an
  **Oracle upper bound** (best possible per-query), and **simulated user feedback** (satisfied
  iff response quality > 0.7 **and** waiting time < 15 s). Evaluated *on RouterBench* (extended
  with Llama-3.1 8B/70B), 80/20 split.
- **H1 number:** 97.25% of GPT-4's quality at **24.18% of GPT-4's cost** (λ=1.4), beating the
  best baseline OptLLM (96.39% quality at 32.94% cost). **[3-0]**
- **H2 result — "The Power of Continual Training"** (maps almost 1:1 onto our L1/L2/L3): **[2-1]**

  | offline:online split | Without online | Refined feedback (lift) | Binary feedback (lift) |
  |---|---|---|---|
  | 80:20 | 75.54% | 76.45% (**+1.21%**) | 75.93% (**+0.52%**) |
  | 50:50 | 71.98% | 72.99% (**+1.39%**) | 72.37% (**+0.53%**) |
  | 30:70 | 69.74% | 71.29% (**+2.22%**) | 70.65% (**+1.31%**) |

  Two things to steal from this table:
  1. **Lift grows as more data is allocated online** (+1.21 → +2.22%) — empirical support that
     our **L2 (positive trend)** is a real, observable effect, not wishful thinking.
  2. **Refined feedback > binary feedback at every split** — richer signal learns more from the
     same volume. This is precisely the spirit of our **L3 (signal-not-volume)**, and suggests a
     second axis worth testing: not just real-vs-shuffled, but *graded* vs *binary* feedback.

- **Honest limitation (why it's a template, not a drop-in):** MixLLM's continual-training result
  is **NOT a true sequential/prequential curve** — the authors ran **one** online test at the end
  for three *static* split configurations. So it's "learning-curve-*style*," not a learning curve.
  Our §10 fixed-probe design (re-score a held-out probe at growing memory checkpoints) is
  *stronger* than what MixLLM actually did. We are not behind the literature here — we'd be
  slightly ahead of it.

### B2 — Standard streaming-evaluation methodology (the method to adopt) **[lead]**

The discipline that already solved "how do you measure an online learner without cheating" is
data-stream mining. The canonical method is **prequential evaluation (interleaved
test-then-train)**: each item is first used to *test* (predict before the label is seen), then to
*train*. This is exactly our §10 "predict-before-you-update" rule, and it's leakage-free by
construction.

- **Gama et al., prequential error / forgetting mechanisms** — the foundational reference for
  test-then-train with fading factors / sliding windows (`site.uottawa.ca/ICML08WS/papers/J_Gama.pdf`). **[lead]**
- **scikit-multiflow `EvaluatePrequential`** — a ready, documented implementation of the
  prequential loop with rolling-window metrics; a concrete API to mirror when we build the §10
  harness. **[lead]**
- **MOA (Massive Online Analysis), evaluation chapter** — textbook treatment of holdout vs
  prequential vs windowed evaluation for streams (`book.moa.cms.waikato.ac.nz/chapter_6.html`). **[lead]**

**Recommendation:** adopt **prequential / rolling-window** as the *realistic* arm and our
**fixed-probe learning curve** (§10) as the *clean-yardstick* arm. They're complementary: the
fixed probe gives an interpretable cold→warm curve; prequential gives the production-realistic
streaming number. Both are leakage-free.

### B3 — Bandit / regret framing (an alternative H2 lens) **[lead]**

If we want to frame self-learning as a bandit problem (which fits Minima's explore/exploit
posture), the metric becomes **cumulative regret vs the Oracle** rather than retention-vs-premium.
Relevant pointers surfaced (all **[lead]** — not individually verified this run):

- arXiv:2510.00841 — *LLM Routing with Dueling Feedback* (online routing from pairwise feedback).
- arXiv:2505.12601 — kNN vs learned routers, online setting.
- arXiv:2506.17670, arXiv:2503.10657 — bandit/regret framing for routing.

These would supply **regret-curve baselines** and possibly released code usable as H2 comparators.
Worth a follow-up scoping pass before committing — see open questions.

---

## Part C — Mapping each criterion to an artifact / method

| Criterion (from `CRITERIA.md`) | Satisfied by | Status |
|---|---|---|
| §2 Path A — (correct, cost) per (task, model) | RouterBench (in-repo) / LLMRouterBench | ✅ available now |
| C1 savings, C2 not-naive, C3 dominates-random | RouterBench replay via `harness.py` | ✅ already asserted in `test_routerbench_savings.py` |
| C4 retention frontier + bootstrap CIs | `harness.py` frontier; AIQ as a frontier summary | ✅ frontier built; AIQ optional add |
| Reference operating points to sanity-check our savings% | RouteLLM (95%@26% calls), MixLLM (97.25%@24.18%), Hybrid LLM (40%), LLMRouterBench (+4%/31.7%) | ✅ external anchors |
| L1 learning lift (cold→warm) | **net-new** harness; MixLLM continual table as the precedent | ⛔ build it (§10) |
| L2 positive trend | **net-new**; MixLLM shows lift grows with online data | ⛔ build it |
| L3 signal-not-volume (shuffled control) | **net-new**; MixLLM refined>binary is the analog | ⛔ build it |
| L4 convergence-K | **net-new** (no precedent reports this) | ⛔ build it |
| V6 causal ordering, V7 ingest barrier | prequential test-then-train (Gama / scikit-multiflow / MOA) | 🔧 adopt the method, implement |

---

## Part D — Caveats & risks (read before quoting any number)

1. **All headline savings figures are best-case operating points**, not guarantees. RouteLLM's
   85%/26%/14% are MT-Bench-favorable and shrink on MMLU/GSM8K; MixLLM's 24.18% is one λ under a
   30 s latency constraint; Hybrid LLM's 40% is one point on the curve; LLMRouterBench's +4%/31.7%
   are ceilings where *several routers fail to beat Best Single*. Use them as **sanity anchors for
   our own measured numbers, not as targets to match.**
2. **The inflated-headroom critique** (arXiv:2605.07395, *Unsolvability Ceiling in Multi-LLM
   Routing*, **[lead]**): exact-match vs LLM-judge scoring can inflate apparent routing savings by
   ~13–17pp on knowledge benchmarks, and gains may not transfer to production query distributions.
   This bears directly on our guards **V2 (circularity)** and **V3 (no cherry-picking)** — our
   reports must state the scoring method and treat headroom skeptically. RouterBench mixes
   exact-match and GPT-4-rating labels, so this applies to us.
3. **Label type varies.** RouterBench/LLMRouterBench give objective-ish correctness; RouteLLM's
   55k and `gpt4_dataset` give *preference/quality* judgments. Our `correct(task,model)` is
   cleanest on the former.
4. **Cost-axis gaps.** `routellm/gpt4_dataset` and `lmsys-55k` ship **no per-call cost** — cost
   must be derived from token pricing before they satisfy §2 Path A. RouterBench and
   LLMRouterBench do not have this problem.
5. **Two H2 findings were 2-1 split votes** (the Hybrid-LLM and MixLLM-continual claims). The
   dissent was methodological scoping, not factual refutation, so confidence rests on the verbatim
   primary-source numbers rather than unanimity. Treat those rows as "verified-with-an-asterisk."
6. **No negative-control precedent.** No source we found runs a shuffled-label control for routing
   self-learning. Our **L3** would be novel — which is good for rigor but means there's no
   reference number to expect.

---

## Part E — Open questions (worth a follow-up before building)

1. Is there *any* public dataset that ships a ready-made sequential streaming-feedback split
   (per-step correctness+cost) **with** a shuffled-label control, so §10's curve could be replayed
   offline instead of built on top of a RouterBench replay? (Research says: not found — but a
   targeted bandit-routing scoping pass might surface one.)
2. For H2, which standard to adopt as the headline — **prequential rolling-window accuracy**, or
   **bandit cumulative-regret vs Oracle**? Do the bandit-routing papers (arXiv:2510.00841 dueling
   feedback; NeuralUCB/BaRP/PILOT) ship regret-curve baselines + code we can reuse as comparators?
3. Does switching RouterBench's exact-match labels to an LLM-judge materially change Minima's
   measured savings/retention (the arXiv:2605.07395 critique)? This is a concrete robustness check
   on our own headline number.
4. Should **LLMRouterBench** replace RouterBench as the Path A backend (fresher 33-model 2026 pool,
   real per-call tokens+cost)? What schema-adapter work would swapping it into `harness.py`
   (currently hard-wired to `routerbench_0shot.pkl`'s `<model>|total_cost` columns) require?

---

## Sources

**Primary (verified findings rest on these):**
- RouterBench — arXiv:2403.12031 (COLM 2024); HF `withmartian/routerbench`; repo `withmartian/routerbench`
- LLMRouterBench — arXiv:2601.07206v1; repo `ynulihao/LLMRouterBench`; HF `NPULH/LLMRouterBench`
- RouteLLM — arXiv:2406.18665 (ICLR 2025); LMSYS blog 2024-07-01; repo `lm-sys/RouteLLM`; HF `routellm/*`
- Hybrid LLM — OpenReview `02f3mUtqnM` / arXiv:2404.14618 (ICLR 2024); HF `llm-blender/mix-instruct`
- MixLLM — ACL `2025.naacl-long.545` / arXiv:2502.18482 (NAACL 2025)
- Local corroboration — `src/minima/seeding/routerbench.py`, `tests/eval/harness.py`

**Leads (surfaced, not individually verified this run):**
- Methodology — Gama et al. prequential (uottawa ICML08WS); scikit-multiflow `EvaluatePrequential`; MOA book ch.6
- Bandit/regret — arXiv:2510.00841, arXiv:2505.12601, arXiv:2506.17670, arXiv:2503.10657
- Critique — arXiv:2605.07395 (inflated-headroom), arXiv:2504.07113 (router robustness)
- Other benchmarks — RouterEval (`MilkThink-Lab/RouterEval`), RouterArena (`RouteWorks/RouterArena`), arXiv:2502.03261

*Run stats: 5 angles · 20 sources fetched · 100 claims extracted · 25 verified · 0 killed · 102 agents.*
