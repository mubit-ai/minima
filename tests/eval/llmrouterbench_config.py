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

2. CANDIDATE SET (12 frontier models). Widened from an initial 5 because on a smoke run the
   5-set collapsed to one dominant model at every slider (one model was best-AND-cheap, so there
   was no routing tradeoff). 12 gives a rich Pareto frontier where different models win different
   prompts, so per-prompt routing actually matters. All 12 share full prompt overlap on the
   frontier suite EXCEPT swe-bench, which ``qwen3-235b-a22b-thinking-2507`` was not run on — so
   under the all-candidates-present rule swe-bench (500 prompts) drops out, leaving 13 datasets /
   ~13,096 usable prompts (96%). Record-weighted avg score over the common set (premium =
   gemini-2.5-pro, the highest):
     gemini-2.5-pro 0.598 | gpt-5 0.592 | qwen3-235b-a22b-2507 0.542 |
     qwen3-235b-a22b-thinking-2507 0.528 | deepseek-r1-0528 0.482 | kimi-k2-0905 0.456 |
     deepseek-v3.1-terminus 0.446 | glm-4.6 0.445 | gemini-2.5-flash 0.436 |
     deepseek-v3-0324 0.420 | claude-sonnet-4 0.399 | intern-s1 0.392

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
    "qwen3-235b-a22b-thinking-2507",
    "deepseek-r1-0528",
    "kimi-k2-0905",
    "deepseek-v3.1-terminus",
    "glm-4.6",
    "gemini-2.5-flash",
    "deepseek-v3-0324",
    "claude-sonnet-4",
    "intern-s1",
)

# The "always use the best model" baseline (highest avg score on the common set).
PREMIUM: str = "gemini-2.5-pro"

# Independent market list prices: (input_$/Mtok, output_$/Mtok). Provenance per model below.
# Pulled from BerriAI/litellm model_prices_and_context_window.json (the repo's price source).
# Open models priced at one representative serving tier (provider noted); exact values are not
# critical — independence from the scored dataset cost + rough ranking are (guard V2).
MARKET_PRICES: dict[str, tuple[float, float]] = {
    "gemini-2.5-pro": (1.25, 10.00),                  # litellm: gemini-2.5-pro (<=200k tier)
    "gpt-5": (1.25, 10.00),                           # litellm: gpt-5
    "qwen3-235b-a22b-2507": (0.09, 0.60),             # litellm: deepinfra Qwen3-235B-A22B-Instruct-2507
    "qwen3-235b-a22b-thinking-2507": (0.22, 0.88),    # litellm: fireworks qwen3-235b-a22b-thinking-2507
    "deepseek-r1-0528": (0.50, 2.15),                 # litellm: deepinfra DeepSeek-R1-0528
    "kimi-k2-0905": (0.60, 2.50),                     # litellm: moonshot kimi-k2-0905
    "deepseek-v3.1-terminus": (0.27, 1.00),           # litellm: deepinfra DeepSeek-V3.1-Terminus
    "glm-4.6": (0.40, 1.75),                          # litellm: openrouter z-ai/glm-4.6
    "gemini-2.5-flash": (0.30, 2.50),                 # litellm: gemini-2.5-flash
    "deepseek-v3-0324": (0.25, 0.88),                 # litellm: deepinfra DeepSeek-V3-0324
    "claude-sonnet-4": (3.00, 15.00),                 # litellm: claude-sonnet-4-20250514
    "intern-s1": (0.30, 1.00),                        # ESTIMATE: not in litellm; ~deepseek-v3 tier
}

# Provider per candidate (for the eval catalog + IPW grouping). The shipped harness `_provider`
# only recognises gpt-/claude-/llama/mistral; these ids need an explicit map.
PROVIDERS: dict[str, str] = {
    "gemini-2.5-pro": "google",
    "gpt-5": "openai",
    "qwen3-235b-a22b-2507": "alibaba",
    "qwen3-235b-a22b-thinking-2507": "alibaba",
    "deepseek-r1-0528": "deepseek",
    "kimi-k2-0905": "moonshot",
    "deepseek-v3.1-terminus": "deepseek",
    "glm-4.6": "zhipu",
    "gemini-2.5-flash": "google",
    "deepseek-v3-0324": "deepseek",
    "claude-sonnet-4": "anthropic",
    "intern-s1": "shanghai-ai-lab",
}


def provider_for(model_id: str) -> str:
    """Provider for a candidate id; falls back to the substring before '/' or 'other'."""
    if model_id in PROVIDERS:
        return PROVIDERS[model_id]
    return model_id.split("/")[0] if "/" in model_id else "other"


# Map each frontier dataset to a Minima TaskType *string* (the harness wraps this in
# TaskType(...) and falls back to "other" on miss). This sets the memory cluster tag and the
# build_content prefix; recall itself is semantic (by prompt), so the mapping only needs to be
# reasonable, not perfect. TaskType values: code, summarization, extraction, qa, reasoning,
# classification, translation, creative, rag, tool_use, other.
EVAL_DATASET_TASK_TYPE: dict[str, str] = {
    "aime": "reasoning",
    "arc-agi": "reasoning",
    "arenahard": "other",
    "arenahard_coding": "code",
    "arenahard_creative_writing": "creative",
    "arenahard_math": "reasoning",
    "gpqa": "qa",
    "hle": "qa",
    "livecodebench": "code",
    "livemathbench": "reasoning",
    "mmlupro": "qa",
    "simpleqa": "qa",
    "swe-bench": "code",
    "tau2": "tool_use",
}


def task_type_for(eval_name: str) -> str:
    """Dataset id -> Minima TaskType string (drop-in for ``routerbench._task_type_for``)."""
    return EVAL_DATASET_TASK_TYPE.get(eval_name, "other")
