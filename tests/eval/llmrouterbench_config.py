"""Phase 2 config for the LLMRouterBench H1 eval — candidate set, premium, prices, providers.

This is the *design* output of Phase 2 in ``docs/PLAN/LLMRouterBench-H1-setup.md``: the
deliberate choices the eval rests on, with the reasoning inline so they can be argued with.
Phase 3 (the wide-DataFrame pivot in ``minima.seeding.llmrouterbench``) and Phase 4 (the test
``test_llmrouterbench_savings.py``) import from here.

Why these choices (measured against the real release, not guessed):

1. COVERAGE REGIME. The release splits into two near-disjoint suites: the lightweight ~7-9B
   open models were run on an easier/broad 22-dataset set, while the flagships were run on a
   harder 14-dataset *frontier* suite (aime, gpqa, hle, swe-bench, livecodebench, …). gpt-5's
   datasets are NOT a subset of Qwen3-8B's — so you cannot mix a cheap 8B model with a flagship
   on shared prompts. We use the **14-dataset frontier suite**, where 12 capable models all have
   FULL prompt-level overlap (verified: all 5 candidates ran the identical prompts on all 14
   datasets, ~13,596 usable shared prompts).

2. CANDIDATE SET. Chosen for a real cost-quality spread on that common set (scores below are the
   record-weighted avg over the 14 datasets; ``$/call`` is the dataset's realized cost):
     - gemini-2.5-pro   score 0.598  $0.0684  -> PREMIUM (best & priciest; the C1 baseline)
     - gpt-5            score 0.592  $0.0393  -> near-premium but cheaper; router should prefer it
     - qwen3-235b-2507  score 0.542  $0.0018  -> COST-PERF HERO: ~91% of premium quality at ~3% cost
     - claude-sonnet-4  score 0.399  $0.0195  -> DOMINATED distractor (pricier AND worse than qwen)
     - deepseek-v3-0324 score 0.420  $0.0013  -> CHEAPEST & weak: the "always-cheapest" trap
   This makes the criteria meaningful: always-cheapest is genuinely weak (C2), there is a
   cheap-and-good hero to find (big savings story), and a strictly-dominated expensive model
   (proves the router doesn't overpay for brand).

3. REAL COST FOR EVERY CANDIDATE. All five were served via paid providers in the benchmark, so
   each has a non-zero realized ``cost`` to score on — this set sidesteps the open-model ``$0``
   pricing problem flagged in Phase 1 (which only affects the locally-run ~8B models).

4. INDEPENDENT DECISION PRICES (guard V2 — no circularity). The eval SCORES the router on the
   dataset's realized ``cost`` column, but the router must DECIDE using prices that are
   *independent* of that column, or the cost metric is just a transform of the router's own
   input. So MARKET_PRICES below are list $/Mtok pulled from the LiteLLM price file
   (the same source Minima's production catalog uses, ``MINIMA_LITELLM_PRICES_URL``) — NOT the
   dataset cost. Open-model serving prices vary by provider/tier; we take one consistent
   aggregator tier (DeepInfra serving) and document it. Exact values don't matter — independence
   and rough ranking do.
"""

from __future__ import annotations

# The 14-dataset frontier suite (intersection where all candidates share prompts).
EVAL_DATASETS: tuple[str, ...] = (
    "aime", "arc-agi", "arenahard", "arenahard_coding", "arenahard_creative_writing",
    "arenahard_math", "gpqa", "hle", "livecodebench", "livemathbench",
    "mmlupro", "simpleqa", "swe-bench", "tau2",
)

# Candidate model ids — VERBATIM as they appear in the release's ``model_name`` field.
CANDIDATES: tuple[str, ...] = (
    "gemini-2.5-pro",
    "gpt-5",
    "qwen3-235b-a22b-2507",
    "claude-sonnet-4",
    "deepseek-v3-0324",
)

# The "always use the best model" baseline (highest avg score on the common set).
PREMIUM: str = "gemini-2.5-pro"

# Independent market list prices: (input_$/Mtok, output_$/Mtok). Provenance per model below.
# Pulled from BerriAI/litellm model_prices_and_context_window.json (the repo's price source).
MARKET_PRICES: dict[str, tuple[float, float]] = {
    "gemini-2.5-pro": (1.25, 10.00),       # litellm: gemini-2.5-pro (<=200k tier)
    "gpt-5": (1.25, 10.00),                # litellm: gpt-5
    "claude-sonnet-4": (3.00, 15.00),      # litellm: claude-sonnet-4-20250514
    "qwen3-235b-a22b-2507": (0.09, 0.60),  # litellm: deepinfra/Qwen3-235B-A22B-Instruct-2507
    "deepseek-v3-0324": (0.25, 0.88),      # litellm: deepinfra/deepseek-ai/DeepSeek-V3-0324
}

# Provider per candidate (for the eval catalog + IPW grouping). The shipped harness `_provider`
# only recognises gpt-/claude-/llama/mistral; these ids need an explicit map.
PROVIDERS: dict[str, str] = {
    "gemini-2.5-pro": "google",
    "gpt-5": "openai",
    "claude-sonnet-4": "anthropic",
    "qwen3-235b-a22b-2507": "alibaba",
    "deepseek-v3-0324": "deepseek",
}


def provider_for(model_id: str) -> str:
    """Provider for a candidate id; falls back to the substring before '/' or 'other'."""
    if model_id in PROVIDERS:
        return PROVIDERS[model_id]
    return model_id.split("/")[0] if "/" in model_id else "other"
