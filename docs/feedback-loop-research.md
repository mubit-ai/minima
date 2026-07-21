# Feedback-Loop Research — literature survey mapped to the code (2026-07)

A three-track research pass (routing/bandit + OPE, label quality, memory/credit
assignment) over 2023–2026 papers and industry practice, mapped onto the feedback loop
as implemented in `feedbackSafely` (`packages/tui/src/minima/runtime.ts`) and
`POST /v1/feedback` (`src/minima/api/routers/feedback.py`). All arXiv IDs were verified
against sources at research time. Prioritized: shared plumbing first.

## The headline gap

Minima learns only from **absolute, chosen-arm outcomes**. RouteLLM (2406.18665), GiGPO
(2505.10978), and bandit-feedback routing (2510.07429) all derive their sample
efficiency from *comparative* signal — which the recovery ladder already generates for
free: a cheap model gate-failing and the escalated model gate-passing on the same task
is simultaneously a ground-truth preference pair, an anchor-state counterfactual, and
cascade-deferral training data. `parentRecId` already links escalation chains in the
local DB (`runtime.ts`); it is never sent on the wire. One `parent_rec_id` +
`escalation_reason` field on `FeedbackRequest` unlocks three literature families.

## Theme 1 — Exploit signal already generated but discarded

| Idea | Source | Mechanism → Minima fit |
|---|---|---|
| Preference pairs from the ladder | RouteLLM (2406.18665); dueling feedback (2510.00841) | Loser/winner per cluster from verified ladder escalations; pairwise win/loss counts feed posteriors naturally. Needs `parent_rec_id` on feedback. |
| Hindsight relabeling of failed runs | AgentHER (2603.21357) | Failed trajectories contain green mid-plan gates (already relayed as `step_outcomes`); also write them as positive per-step-type routing evidence. |
| Implicit negatives the scribe already mines | WildFeedback (2408.15549); PRELUDE (2404.15269); Joachims IPW debias (1608.04468) | User corrections / gate flips / judge–gate disagreements live only in local SQLite; send as weak signals (never `verified_in_production`). |
| Surrogate index over the ~85% unlabeled telemetry | Athey et al. surrogate index (NBER w26463) | Fit telemetry features → gate/judge label on the labeled slice; discounted pseudo-labels for the rest. |

## Theme 2 — Fix the judge

| Idea | Source | Mechanism → Minima fit |
|---|---|---|
| Length-debias (fixes known terse-answer misgrading) | LC-AlpacaEval (2404.04475); verbosity bias (2310.10076) | GLM correction on length delta, fit on gate-labeled turns; near zero cost. |
| Prediction-powered inference | PPI (2301.09633, Science); stratified PPI (2406.04291) | Gate+judge overlap turns = the gold/predicted pairs PPI needs; debiased per-arm success rates + continuous judge-drift meta-eval. |
| Uncertainty-driven judge allocation | Active eval acquisition (2410.05952); FreeAL (2311.15614) | Replace the uniform 15% coin flip with posterior-variance × calibration-error targeting. **Must log inclusion propensity or OPE breaks.** |
| Calibrated abstention + judge cascade | Trust-or-Escalate (2407.18370) | Simulated-annotator agreement = confidence; escalate haiku→sonnet judge only on low confidence. |
| Panel of small judges | PoLL (2404.18796) | 2–3 cross-family small judges beat one big judge at 7–8× lower cost; disagreement doubles as an uncertainty signal. |
| Judge distilled from the gate ledger | JudgeLM (2310.17631); Prometheus 2 (2405.01535); JudgeBench (2410.12784) | The gates ledger is a free, verbosity-blind (task, output, verdict) corpus; benchmark candidates on held-out gates + JudgeBench (generic judges collapse on objective coding pairs). |
| Weak-supervision label model | Snorkel (1711.10160); Dawid–Skene 1979; Calibrate-Don't-Curate (2605.09702); Ising aggregation (2601.22336) | Every signal becomes a labeling function with learned accuracies → P(success) for ~100% of turns; fractional Beta updates. Gives yellow-tier evidence a principled weight instead of demotion to telemetry. Provenance (`evidence_source="gate"`) never escalates. |

## Theme 3 — Bandit/estimator machinery (server-only)

| Idea | Source | Mechanism → Minima fit |
|---|---|---|
| Estimator suite next to fixed-clip DR | SWITCH (1612.01205); DR-shrinkage (1907.09623); SNIPS (Swaminathan & Joachims 2015) | Compute all in `metrics/ope.py`; alarm on disagreement (= propensities or reward model wrong). |
| Discounted posteriors + change-point resets | Discounted TS (2305.10718); sliding-window TS (2409.05181); TS-CD (2009.02791) | CUSUM detects; now act: decay Beta counts continuously, hard-reset on CUSUM fire or provider snapshot change. Needs feedback to echo the exact provider model snapshot string. |
| Off-policy *learning* (not just OPE) | Bandit-feedback routing (2510.07429) | Train a preference-conditioned challenger policy on the existing replay log; replaces the single global tau. |
| Neural-linear bandit over Mubit embeddings | Bandits Showdown (1802.09127); NeuralUCB (1911.04462); MixLLM (2502.18482) | Use recall-time embeddings as context so evidence generalizes across clusters (fixes n≈1 per-cell fragmentation). Log the sampled head draw for OPE. |
| Model-probe cold start | UniRoute (2502.08773); GraphRouter (2410.03834); LLM Bandit (2502.02743) | New catalog model: run a probe set once, init posteriors from k-nearest models instead of Beta(1,1). |
| Shadow challenger replay | Replay eval (1003.5956); interleaving (Chapelle et al. 2012) | Log would-have-chosen per challenger; promote when replay + SNIPS/SWITCH agree. Zero extra LLM spend. |
| Delayed gate verdicts as censored | Chapelle KDD'14; Vernade (1706.09186) | Late CI/user verdicts are censored positives, not negatives; piggybacks on `occurrence_time`. |
| Budget-aware pacing | C2MAB-V (2405.16587) | Optional `remaining_budget`/`horizon` on recommend → session-level exploration pacing. |
| MRDR | (1802.03493) | Train the DR reward model to minimize DR variance; near-free after the estimator refactor. |

## Theme 4 — Memory & credit assignment

| Idea | Source | Mechanism → Minima fit |
|---|---|---|
| Harmful-vs-useless recall votes | Experience-Following (2505.16067) | Weight invalidation by the outcome of the recommendation the entry informed — recalled-before-failure tombstones faster. Small change to `_apply_recall_votes`. |
| Learned recall re-scoring | Memento/AgentFly (2508.16153) | Reinforcement credit per entry = training data for similarity × learned-utility re-scoring at recall→aggregate. Credit currently only prunes. |
| Contrastive lessons | ExpeL (2308.10144) | Scribe pairs a green-gate and red-gate run in the same cluster (cheap SQL) → differential lessons, with vote counters on promoted lessons. |
| Workflow induction from the gates ledger | AWM (2409.07429); Voyager (2305.16291) | Recurring gate-verified step sequences → procedural memories that ship with executable `verify` checks. Inject as guidance, never override. |
| Distrust LLM step-blame | Who&When (2505.00212: 14% step-attribution accuracy); CAR (2606.08275) | `/v1/diagnose` briefs are hypotheses; gate evidence is free ground-truth blame. Sampled counterfactual replay in a worktree lets the measured red→green flip author the lesson. |
| Decay + version discount | MemoryBank (2305.10250) | Ebbinghaus-style decay reset by reinforcement; hard-discount records predating a provider model bump (catalog knows dates). |
| DP federated cross-tenant priors | (2302.13945); user-level DP (2306.05275) | Share noised per-(cluster, model) sufficient statistics into a common cold-start lane; org Mubit stays the boundary. |
| Seed as prior, not records | RouteLLM transfer result | RouterBench seeds become a low-weight prior in the estimate tier that tenant observations monotonically override. |

## What the literature validates (do not change)

- **Step signals stay a separate channel.** PRM lessons (Qwen 2501.07301; AgentPRM
  2502.10325; Math-Shepherd 2312.08935; Lightman 2305.20050): noisy step rewards must
  not be summed into outcome posteriors. Minima's split — `step_outcomes` → memory,
  trajectory label → posterior — is the recommended architecture. At most, a red
  terminal step may cap the trajectory label (min-style).
- **No fabricated quality; gate-only `verified_in_production`.** Every weak-label idea
  raises *coverage*; none may escalate evidence *provenance*.
- **Propensity logging discipline** is what makes replay/OPE possible at all.

## Sequencing

| Phase | Work | Unlocks |
|---|---|---|
| 1 | One schema PR: `parent_rec_id`, `escalation_reason`, provider model-snapshot echo, judge inclusion-propensity (+ both TS mirrors + clients) | preference pairs, cascade learning, version resets, active judging |
| 2 | Judge length-debias + PPI rectifier (server-side; data already exists) | fixes the known judge defect; honest estimates |
| 3 | OPE refactor: SNIPS/SWITCH/shrinkage + discounted posteriors + shadow-challenger replay | safe policy iteration |
| 4 | Weak-supervision label model + implicit signals + surrogate index | ~100% label coverage |
| 5 | Neural-linear bandit, model-probe cold start, workflow induction, learned recall scoring | structural upgrades |

Cross-cutting integrity rules: (a) any non-uniform sampling logs its inclusion
probability; (b) probabilistic labels never escalate provenance; (c) surrogate/implicit
signals enter down-weighted, never as verified evidence.
