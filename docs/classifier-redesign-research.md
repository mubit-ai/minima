# Classifier Redesign — Research Summary

How Minima's task classifier should evolve, grounded in what actually shipped in
2023–2026 router products and routing papers. Phase 0 (the quick fixes) landed with this
document; the later phases are design targets, not commitments.

## 1. The current design and its measured failure

`src/minima/recommender/classify.py` is a regex table: 10 `_FEATURE_RULES`
(one per task type), strongest-signal-wins by `findall` hit count, plus a word-count
difficulty ladder (`<40` words → easy, `<150` → medium, `<400` → hard, else expert) with
±1 shifts for hard/easy types. It is fast (<1 ms), deterministic, and free — properties
worth keeping on the hot path.

The measured failure (live, 2026-07): **"build me a website for my bakery"**.

- No rule contained build/create/website vocabulary and the file-extension alternation
  omitted `html`/`css`, so the prompt classified `task_type=other`.
- Seven words → `difficulty=easy`. Cluster: `other:easy`.
- At cold start every candidate sat on its catalog prior; gemini-2.5-flash's `other`
  prior (0.76) cleared the default tau (0.735) by 0.025 and won as cheapest-eligible —
  a weeks-long agentic build task priced like a one-line answer.

Two structural lessons, bigger than the missing keywords:

1. **Length is not difficulty.** Word count measures the *ask*, not the *artifact*. Every
   generative "build X" prompt is short; the requested scope is what's large.
2. **`other` is an unpriced sink.** Whatever falls through the regex lands in one cluster
   whose statistics mean nothing, keyed to priors that were never calibrated for it.

Phase 0 fixed the immediate misroute: web/build vocabulary + `html|css|scss|sass|less|vue|svelte`
extensions in the code rule, a `my|our|your` fix-verb alternation (complaint prompts like
"fix my landing page" now migrate to `code:*` clusters), a build-scope difficulty floor
(generative verb + substantial artifact noun → at least medium), a generalized
neighbor-vote refinement (type **and** difficulty, gated on heuristic confidence), and a
cold-start eligibility margin so a coarse prior scraping past tau can't win on price alone.

## 2. Verified prior art

- **OpenRouter** — a ~30-type task taxonomy with per-type model performance statistics;
  routing consults the task type's own leaderboard. The taxonomy is the product: types
  are chosen so that per-type stats are *stable and discriminative*.
- **NVIDIA (Prompt Task/Complexity classifier)** — a DeBERTa backbone with multiple
  classification heads: task type plus a **length-free complexity formula**
  `0.35·creativity + 0.25·reasoning + 0.15·constraint + 0.15·domain-knowledge +
  0.05·contextual + 0.05·few-shots`. Complexity is a property of the *work*, scored from
  learned heads — the strongest existing refutation of word-count difficulty.
- **Arch-Router (Katanemo)** — routes are *config-defined* by the operator
  (domain + action descriptions); a 1.5B model matches prompts to route descriptions.
  Taxonomy lives in configuration, not code — operators extend it without retraining.
- **semantic-router (Aurelio)** — routes anchored by example *utterances*, embedded once;
  classification is nearest-anchor similarity. Tiny, dependency-light, no training loop —
  the minimal viable semantic upgrade from regex.
- **UniRoute (Google, 2025)** — theoretical treatment of routing to *unseen* models via
  cluster-keyed statistics: per-cluster error estimates transfer as long as the cluster
  key is meaningful. This blesses Minima's `task_type:difficulty` cluster design — and
  makes cluster-key *quality* the binding constraint on everything downstream.
- **RouteLLM / Not Diamond** — taxonomy-free: learn win-rate predictors directly from
  preference data. Stronger ceiling, but label-hungry (tens of thousands of comparisons)
  and cold-start-blind — the wrong shape for Minima's recommend-only, evidence-first loop.

## 3. Method tiers for a shipped classifier

| Tier | Method | Cost | Notes |
|------|--------|------|-------|
| 0 | Regex + tables (today) | free | Keep as fallback forever; it is the abstention floor. |
| 1 | Caller/LLM classification via the existing caller seam | caller's tokens | `task_type` supplied by the harness; zero server dependency. |
| 2 | **Model2Vec** static embeddings (numpy-only, 8–30 MB) | ~0.2 ms/prompt | Distilled static vectors, no torch/onnx dependency — fits the dependency-light core. |
| 2+ | ONNX-int8 sentence encoders | ~5–15 ms | Optional extra (`[classifier]`), better accuracy, heavier wheel. |
| 3 | **SetFit** fine-tune (contrastive, ~8 labels/class) | one-off training | The known recipe for high-accuracy small classifiers from tiny label budgets. |
| 3+ | LLM-distillation loop | offline batch | Label recent traffic with a big model, retrain the small one; repeat on drift. |

**The open-set trap:** intent benchmarks flatter closed-set accuracy. CLINC150-style
results run ~96.9% in-scope while out-of-scope recall drops to ≤66% for encoders trained
without an explicit OOS class. Any learned classifier here must ship with a *trained*
`other` class plus distance-margin abstention (near-tie or far-from-all-anchors → abstain
to `other` and let neighbor votes / the caller decide) — otherwise the unpriced-sink
failure returns wearing an embedding.

## 4. Phased plan

- **Phase 0 (this change):** vocabulary + scope floor + confidence-gated neighbor
  refinement + cold-start margin. Pure Python, no new dependencies, regression-pinned.
- **Phase 1 — client-side LLM classification:** the harness (which already runs models)
  classifies with its own tokens and supplies `task_type`/`difficulty` through the
  existing caller-override seam. The server stays dependency-light; caller labels keep
  winning over heuristics, unchanged.
- **Phase 2 — shipped static-embedding classifier:** Model2Vec anchors per task type
  (semantic-router shape), trained `other` + distance-margin abstention, behind a setting
  with the regex as fallback. Difficulty becomes a second head scored on NVIDIA-style
  work-property features, not length.
- **Phase 3 — `domain:action` taxonomy with cluster-key versioning:** Arch-Router-style
  config-defined routes replace the fixed 11-type enum; cluster keys carry a version so
  old memory keeps aggregating under old keys while new traffic accrues under new ones
  (UniRoute's transfer argument is what makes the migration safe).

Ordering rationale: each phase upgrades the *cluster key* without invalidating accumulated
memory, and every tier keeps a deterministic, free fallback — the recommend-only server
never grows a hard model dependency for classification.
