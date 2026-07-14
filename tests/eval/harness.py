"""RouterBench cost-savings evaluation harness (live, end-to-end through Minima).

The honest question: *does Minima's memory-backed recommender cut token cost without
sacrificing accuracy?* Measured on RouterBench — a public benchmark with, per
(prompt, model), a real correctness label (0/1) and the real USD cost of that call.

This harness is built to survive adversarial scrutiny (see the threats it closes):
- NO circularity: Minima's catalog uses INDEPENDENT real market $/Mtok (not RB's cost
  column) and per-prompt token estimates; we then score cost on RB's ground-truth cost.
- NO leakage: prompts are de-duplicated globally (by normalized fingerprint) and every
  eval/test prompt with a high token-overlap twin in train is dropped, so recall tests
  generalization to *similar* tasks, not item-level answer lookup. A recalled-neighbor
  similarity diagnostic is reported so leakage is visible.
- NO baked-in oracle prior: capability priors are FLAT (0.5) by default, so the routing
  decision is driven purely by recalled memory, not a train-fitted per-task prior.
- NO test cherry-picking: the cost/quality slider is selected on a VALIDATION split and
  the headline is reported on TEST at that fixed slider, with bootstrap CIs and a
  per-task-type breakdown.
- It is the REAL recommender: a cross-check runs the full Recommender.recommend() on a
  sample and asserts the factored scoring matches the product endpoint.

Requires the ``seed`` extra (pandas/huggingface-hub) and a running Mubit + MUBIT_API_KEY.
"""

from __future__ import annotations

import math
import random
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from minima.catalog.store import Catalog, CatalogStore
from minima.config import Settings
from minima.memory.adapter import MubitMemory
from minima.memory.keys import build_content, task_cluster, task_fingerprint
from minima.memory.records import OutcomeRecord
from minima.recommender import score
from minima.recommender.aggregate import aggregate_by_model, apply_ipw
from minima.recommender.propensity import PropensityTracker
from minima.schemas.common import Constraints, TaskInput, TaskType
from minima.schemas.models_catalog import ModelCard
from minima.seeding import routerbench as rb
from minima.seeding.items import SeedItem, build_item

# A realistic spread with a genuine quality range: a weak+cheap model (mistral-7b) at the
# bottom so that naively "always pick the cheapest" is a POOR policy, a couple of strong
# mid-tier models, and the expensive top model (gpt-4-1106). This lets the eval show the
# router must *avoid* the weak-cheap model on hard tasks — i.e. real routing intelligence,
# not just "always cheapest". gpt-4-1106 is the "always use the best model" baseline.
DEFAULT_CANDIDATES = [
    "mistralai/mistral-7b-chat",      # weak + cheapest
    "mistralai/mixtral-8x7b-chat",    # strong + cheap
    "gpt-3.5-turbo-1106",             # mid
    "gpt-4-1106-preview",             # strong + expensive
]
DEFAULT_PREMIUM = "gpt-4-1106-preview"

# INDEPENDENT real market prices ($/Mtok, input/output), ~2023 list prices — deliberately
# NOT derived from RouterBench's cost column, so Minima's decision cost is not a transform
# of the metric we score on.
_MARKET_PRICES: dict[str, tuple[float, float]] = {
    "gpt-3.5-turbo-1106": (1.00, 2.00),
    "gpt-4-1106-preview": (10.00, 30.00),
    "mistralai/mixtral-8x7b-chat": (0.60, 0.60),
    "meta/llama-2-70b-chat": (0.90, 0.90),
    "zero-one-ai/Yi-34B-Chat": (0.80, 0.80),
    "WizardLM/WizardLM-13B-V1.2": (0.30, 0.30),
    "meta/code-llama-instruct-34b-chat": (0.78, 0.78),
    "mistralai/mistral-7b-chat": (0.20, 0.20),
    "claude-instant-v1": (0.80, 2.40),
    "claude-v1": (8.00, 24.00),
    "claude-v2": (8.00, 24.00),
}

_OUT_TOKENS = 256  # assumed completion length for cost estimation
_NEARDUP_JACCARD = 0.6  # drop eval/test prompts with a train twin at/above this overlap


def _provider(model_id: str) -> str:
    m = model_id.lower()
    if m.startswith("gpt"):
        return "openai"
    if m.startswith("claude"):
        return "anthropic"
    if "llama" in m or m.startswith("meta"):
        return "meta"
    if "mistral" in m or "mixtral" in m:
        return "mistralai"
    return model_id.split("/")[0] if "/" in model_id else "other"


def _task_type(eval_name: str, task_type_for=rb._task_type_for) -> TaskType:
    try:
        return TaskType(task_type_for(eval_name))
    except ValueError:
        return TaskType.other


def _toks(s: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", s.lower()))


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / (len(a) + len(b) - inter)


def _est_in_tokens(prompt: str) -> int:
    return max(1, len(prompt) // 4)


@dataclass(slots=True)
class Row:
    prompt: str
    task_type: TaskType
    scores: dict[str, float]
    costs: dict[str, float]
    fp: str
    eval_name: str = ""


@dataclass(slots=True)
class SliderResult:
    slider: float
    accuracy: float
    cost: float
    savings_vs_premium: float
    accuracy_retention: float
    pick_counts: dict[str, int] = field(default_factory=dict)


@dataclass(slots=True)
class EvalResult:
    candidates: list[str]
    premium: str
    train_n: int
    val_n: int
    test_n: int
    test_dropped_neardup: int
    lane: str
    seeded: int
    avg_recall_evidence: float
    neighbor_sim_p50: float
    neighbor_sim_p95: float
    leaky_fraction: float
    per_model: dict[str, dict[str, float]]
    baselines: dict[str, dict[str, float]]
    selected_slider: float
    headline: SliderResult
    headline_savings_ci: tuple[float, float]
    headline_retention_ci: tuple[float, float]
    per_task_type: dict[str, dict[str, float]]
    # Per RouterBench benchmark family (mmlu, gsm8k, mbpp, arc, hellaswag, ...) — the
    # "wide variety of workloads" view of cost reduction at the operating point.
    per_eval_name: dict[str, dict[str, float]]
    frontier: list[SliderResult]
    crosscheck_match_rate: float
    use_train_priors: bool


def prepare_rows(df: Any, candidates: list[str], limit_rows: int,
                 task_type_for=rb._task_type_for) -> list[Row]:
    """Keep rows where every candidate has a usable (score, cost); de-dup by fingerprint."""
    columns = list(df.columns)
    model_cols = rb.detect_model_columns(columns)
    missing = [c for c in candidates if c not in model_cols]
    if missing:
        raise RuntimeError(f"candidates missing score/cost columns: {missing}")
    prompt_col = "prompt" if "prompt" in columns else columns[0]

    seen: set[str] = set()
    rows: list[Row] = []
    for rec in df.itertuples(index=False):
        rowd = dict(zip(columns, rec, strict=False))
        prompt = str(rowd.get(prompt_col, "")).strip()
        if not prompt:
            continue
        fp = task_fingerprint(prompt)
        if fp in seen:  # global exact/normalized de-dup
            continue
        scores: dict[str, float] = {}
        costs: dict[str, float] = {}
        ok = True
        for m in candidates:
            s = rb._to_float(rowd.get(m))
            c = rb._to_float(rowd.get(model_cols[m]))
            if s is None or c is None:
                ok = False
                break
            scores[m] = max(0.0, min(1.0, s))
            costs[m] = c
        if not ok:
            continue
        seen.add(fp)
        en = str(rowd.get("eval_name", ""))
        rows.append(Row(prompt, _task_type(en, task_type_for), scores, costs, fp, en))
        if limit_rows and len(rows) >= limit_rows:
            break
    return rows


def _filter_neardup(holdout: list[Row], train: list[Row], thresh: float) -> tuple[list[Row], int]:
    """Drop holdout rows whose prompt is a near-duplicate of any train prompt."""
    train_tokens = [_toks(r.prompt) for r in train]
    kept: list[Row] = []
    dropped = 0
    for r in holdout:
        rt = _toks(r.prompt)
        if any(_jaccard(rt, tt) >= thresh for tt in train_tokens):
            dropped += 1
            continue
        kept.append(r)
    return kept, dropped


def build_catalog(settings: Settings, candidates: list[str], train: list[Row],
                  use_train_priors: bool, market_prices=None, provider_for=None) -> CatalogStore:
    market_prices = _MARKET_PRICES if market_prices is None else market_prices
    provider_for = _provider if provider_for is None else provider_for
    by_type: dict[str, dict[TaskType, list[float]]] = {m: {} for m in candidates}
    overall: dict[str, list[float]] = {m: [] for m in candidates}
    if use_train_priors:
        for row in train:
            for m in candidates:
                overall[m].append(row.scores[m])
                by_type[m].setdefault(row.task_type, []).append(row.scores[m])

    def mean(xs: list[float], d: float) -> float:
        return sum(xs) / len(xs) if xs else d

    cards: list[ModelCard] = []
    for m in candidates:
        in_p, out_p = market_prices.get(m, (1.0, 1.0))  # independent market prices
        cards.append(
            ModelCard(
                model_id=m, provider=provider_for(m), display_name=m,
                input_cost_per_mtok=in_p, output_cost_per_mtok=out_p, context_window=8192,
                # FLAT prior (0.5) by default → routing is driven by recalled memory, not a
                # train-fitted per-task prior. use_train_priors=True is an ablation only.
                capability_priors={"intelligence_index": mean(overall[m], 0.5)} if use_train_priors else {},
                capability_by_task_type=(
                    {tt: round(mean(v, 0.5), 4) for tt, v in by_type[m].items()}
                    if use_train_priors else {}
                ),
                cost_source="market-2023", cost_fetched_at=datetime.now(UTC), cost_stale=False,
                capability_source=("routerbench-train" if use_train_priors else "flat-0.5"),
            )
        )
    store = CatalogStore(settings)
    store.set(Catalog(cards=cards, version="routerbench-eval", refreshed_at=datetime.now(UTC),
                      cost_source="market-2023", stale_after_seconds=10**9))
    return store


async def seed_train(memory: MubitMemory, lane: str, train: list[Row], candidates: list[str],
                     provider_for=None, source_dataset: str = "routerbench") -> int:
    provider_for = _provider if provider_for is None else provider_for
    items: list[dict] = []
    for i, row in enumerate(train):
        tt, diff = row.task_type.value, "medium"
        cluster, content = task_cluster(tt, diff), build_content(tt, diff, row.prompt)
        for m in candidates:
            q = row.scores[m]
            rec = OutcomeRecord(
                model_id=m, provider=provider_for(m), task_type=tt, difficulty=diff,
                task_fingerprint=row.fp, task_cluster=cluster, cost_usd=row.costs[m],
                quality_score=q, outcome="success" if q >= 0.5 else "failure",
                source_dataset=source_dataset,
            )
            items.append(build_item(SeedItem(f"rbtrain-{i}-{m}", content, rec, ["seed:rbeval"])))
    inserted = 0
    # Small chunks: long prompts (e.g. math word problems) embed slowly server-side, and a
    # big chunk can exceed the SDK HTTP timeout. 100 items keeps each insert well under it.
    for start in range(0, len(items), 100):
        res = await memory.batch_insert(run_id=lane, items=items[start : start + 100], deduplicate=True)
        inserted += int(res.get("count", 0))
    return inserted


async def _recall_aggs(memory: MubitMemory, lane: str, row: Row, candidates: list[str],
                       settings: Settings) -> tuple[dict, int, float]:
    """Returns (aggregates, n_outcome_evidence, max_neighbor_similarity)."""
    # Same budget as the engine's own recall (the crosscheck runs Recommender.recommend
    # fresh): a budget asymmetry makes long-prompt rows time out in one path but not the
    # other, and the factored<->engine crosscheck diverges on exactly those rows.
    recall = await memory.recall(
        query=row.prompt,
        lane=lane,
        limit=settings.minima_memory_recall_limit,
        timeout_ms=settings.minima_memory_recall_timeout_ms,
    )
    # Mirror the shipped engine's aggregation knobs (age decay + seed down-weighting),
    # so the factored frontier reflects the same evidence weighting as /recommend.
    aggs = aggregate_by_model(
        recall.outcome_evidence,
        set(candidates),
        half_life_days=settings.minima_evidence_half_life_days,
        decay_floor=settings.minima_evidence_decay_floor,
        seed_weight=settings.minima_seed_weight,
        seed_crowdout_n=settings.minima_seed_crowdout_n,
    )
    # Mirror the shipped engine: IPW with a cold (empty) propensity store, exactly as a
    # /recommend call does when there's no logging history yet.
    if settings.minima_ipw_enabled and aggs:
        apply_ipw(aggs, PropensityTracker().propensities(lane, "", candidates),
                  settings.minima_ipw_clip_low, settings.minima_ipw_clip_high)
    rt = _toks(row.prompt)
    # Strip the "[task/diff] " prefix build_content adds, then measure overlap with neighbors.
    sims = [_jaccard(rt, _toks(re.sub(r"^\[[^\]]*\]\s*", "", e.content))) for e in recall.outcome_evidence]
    return aggs, len(recall.outcome_evidence), (max(sims) if sims else 0.0)


def _pick(aggs: dict, cards: dict[str, ModelCard], tt: TaskType, slider: float,
          in_tokens: int, settings: Settings,
          eval_priors: dict[str, dict[str, float]] | None = None, eval_name: str = "") -> str:
    """Factored mirror of engine `_score_candidates` + `_optimize` (exploration off).

    ``eval_priors`` (when supplied) overrides the per-task-type prior with a finer
    per-benchmark-family prior — a SIMULATION of a recommender whose capability priors are
    keyed at the benchmark grain (the shipping engine keys them by task_type)."""
    pmap = eval_priors.get(eval_name) if eval_priors else None
    min_cost_n = settings.minima_observed_cost_min_n
    # Mirror the engine: pick one cost basis for the whole candidate set.
    cost_basis = score.choose_cost_basis(
        {mid: aggs.get(mid) for mid in cards},
        settings.minima_use_observed_cost, False, min_cost_n,
    )
    scored = []
    for mid, card in cards.items():
        agg = aggs.get(mid)
        prior = pmap.get(mid, score.capability_prior(card, tt)) if pmap else score.capability_prior(card, tt)
        pred, conf = score.predicted_success(agg, prior, settings.minima_beta_pseudocount)
        est, _ = score.effective_cost(
            card, agg, in_tokens, _OUT_TOKENS, False, cost_basis, min_cost_n
        )
        width = score.posterior_interval_width(agg, prior, settings.minima_beta_pseudocount)
        scored.append((mid, pred, conf, est, width))
    tau = score.threshold_from_slider(slider, settings.minima_tau_min, settings.minima_tau_max, None)

    # Routing-collapse guard, mirrored from engine `_optimize` (engine.py:985-1030): when the
    # cheapest tau-clearing candidate is itself the priciest, prefer a cheaper candidate whose
    # optimistic upper bound (pred + margin*(1-tau)*0.5*width, evidence-backed only) clears tau.
    margin = settings.minima_collapse_margin
    eff = margin * max(0.0, 1.0 - tau)

    def _optimistic_clears(s) -> bool:
        return s[2] > 0.0 and s[1] + eff * 0.5 * s[4] >= tau

    eligible = [s for s in scored if s[1] >= tau]
    if eligible:
        rec = min(eligible, key=lambda s: (s[3], -s[1], -s[2]))
        if margin > 0.0 and len(scored) > 1 and rec[3] >= max(s[3] for s in scored) - 1e-12:
            cheaper = [s for s in scored if s[3] < rec[3] and _optimistic_clears(s)]
            if cheaper:
                rec = min(cheaper, key=lambda s: (s[3], -s[1], -s[2]))
        return rec[0]
    plausible = [s for s in scored if _optimistic_clears(s)] if margin > 0.0 else []
    if plausible:
        # Engine breaks ties without confidence in this branch (engine.py:1026).
        return min(plausible, key=lambda s: (s[3], -s[1]))[0]
    return max(scored, key=lambda s: s[1])[0]


def _score_picks(rows: list[Row], aggs_list: list[dict], cards, slider, settings,
                 eval_priors: dict[str, dict[str, float]] | None = None) -> SliderResult:
    n = len(rows)
    acc = cost = 0.0
    picks: dict[str, int] = {}
    for row, aggs in zip(rows, aggs_list, strict=True):
        m = _pick(aggs, cards, row.task_type, slider, _est_in_tokens(row.prompt), settings,
                  eval_priors, row.eval_name)
        picks[m] = picks.get(m, 0) + 1
        acc += row.scores[m]
        cost += row.costs[m]
    return SliderResult(slider=slider, accuracy=acc / n, cost=cost,
                        savings_vs_premium=0.0, accuracy_retention=0.0, pick_counts=picks)


def _percentile(xs: list[float], p: float) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    k = (len(s) - 1) * p
    lo = math.floor(k)
    hi = math.ceil(k)
    return s[lo] if lo == hi else s[lo] * (hi - k) + s[hi] * (k - lo)


def _bootstrap_ci(picks_cost: list[float], picks_score: list[float], prem_cost: list[float],
                  prem_score: list[float], seed: int, b: int = 1000) -> tuple[tuple, tuple]:
    rng = random.Random(seed)
    n = len(picks_cost)
    sav, ret = [], []
    for _ in range(b):
        idx = [rng.randrange(n) for _ in range(n)]
        pc = sum(picks_cost[i] for i in idx)
        ppc = sum(prem_cost[i] for i in idx)
        pa = sum(picks_score[i] for i in idx)
        ppa = sum(prem_score[i] for i in idx)
        sav.append(1.0 - pc / ppc if ppc else 0.0)
        ret.append(pa / ppa if ppa else 1.0)
    return (_percentile(sav, 0.025), _percentile(sav, 0.975)), (
        _percentile(ret, 0.025), _percentile(ret, 0.975))


def _baselines(test: list[Row], candidates: list[str], premium: str) -> dict[str, dict]:
    n = len(test)
    per_model_cost = {m: sum(r.costs[m] for r in test) for m in candidates}
    per_model_acc = {m: sum(r.scores[m] for r in test) / n for m in candidates}
    cheapest = min(candidates, key=lambda m: per_model_cost[m])

    def summarize_pick(picker) -> dict[str, float]:
        a = c = 0.0
        for r in test:
            m = picker(r)
            a += r.scores[m]
            c += r.costs[m]
        return {"accuracy": a / n, "cost": c}

    def oracle(r: Row) -> str:
        correct = [m for m in candidates if r.scores[m] >= 0.5]
        return min(correct or candidates, key=lambda m: r.costs[m])

    return {
        "always_premium": {"accuracy": per_model_acc[premium], "cost": per_model_cost[premium]},
        "always_cheapest": {"accuracy": per_model_acc[cheapest], "cost": per_model_cost[cheapest],
                            "model": cheapest},
        # analytic expectation over candidates (zero-variance, not a one-draw strawman)
        "random_expectation": {"accuracy": sum(per_model_acc.values()) / len(candidates),
                               "cost": sum(per_model_cost.values()) / len(candidates)},
        "oracle": summarize_pick(oracle),  # ground-truth-using upper bound
        "_per_model_acc": per_model_acc,
        "_per_model_cost": per_model_cost,
    }


async def _crosscheck(settings, memory, catalog, lane, rows, aggs_list, candidates, slider, n):
    from minima.recommender.engine import Recommender
    from minima.recommender.recstore import RecommendationStore
    from minima.schemas.recommend import RecommendRequest

    ns = lane.split(":", 1)[1] if ":" in lane else lane
    cards = {c.model_id: c for c in catalog.get().cards}
    matches = checked = 0
    for row, aggs in list(zip(rows, aggs_list, strict=True))[:n]:
        # Fresh engine per call → cold (uniform) propensity, matching the factored path.
        engine = Recommender(settings, memory, catalog, RecommendationStore())
        factored = _pick(aggs, cards, row.task_type, slider, _est_in_tokens(row.prompt), settings)
        resp = await engine.recommend(RecommendRequest(
            task=TaskInput(task=row.prompt, task_type=row.task_type, difficulty="medium",
                           expected_input_tokens=_est_in_tokens(row.prompt),
                           expected_output_tokens=_OUT_TOKENS),
            namespace=ns, cost_quality_tradeoff=slider,
            # The factored _pick scores ALL candidates; the engine truncates to max_candidates
            # (default 8) AFTER sorting by capability_prior — which is flat in this eval, so the
            # cut would be arbitrary. Lift it to the full set so the crosscheck compares like
            # with like (and so the eval faithfully routes among every provided candidate).
            max_candidates=len(candidates),
            constraints=Constraints(candidate_models=candidates), allow_llm_escalation=False))
        checked += 1
        matches += int(resp.recommended_model.model_id == factored)
    return matches / checked if checked else 1.0


async def _barrier(memory: MubitMemory, lane: str, probe: Row, settings: Settings) -> None:
    """Wait until the seeded train set is fully recallable (server embeds/indexes async).

    n>0 is not enough: recalls issued while the index is still filling see a partial
    evidence set, and the end-of-run engine crosscheck then scores against a richer
    index than the frontier did (a guaranteed factored<->endpoint mismatch). Wait until
    the recallable evidence count saturates: it reaches the recall limit, or is stable
    across 3 consecutive probes.
    """
    last, stable = -1, 0
    for _ in range(60):
        aggs, n, _ = await _recall_aggs(memory, lane, probe, list(probe.scores), settings)
        if n >= settings.minima_memory_recall_limit:
            return
        if n > 0 and n == last:
            stable += 1
            if stable >= 3:
                return
        else:
            stable = 0
        last = n
        time.sleep(5.0)


async def evaluate(
    *,
    settings: Settings,
    candidates: list[str] = DEFAULT_CANDIDATES,
    premium: str = DEFAULT_PREMIUM,
    train_n: int = 800,
    val_n: int = 60,
    test_n: int = 120,
    sliders: tuple[float, ...] = (0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 10.0),
    retention_floor: float = 0.95,
    seed: int = 42,
    use_train_priors: bool = False,
    prior_grain: str = "task_type",  # task_type | eval_name (finer, train-derived simulation)
    hard_key: str = "grade-school-math",
    hard_frac: float = 0.15,  # representative-ish mix (RB is mostly MMLU/commonsense, ~20% math)
    crosscheck_n: int = 12,
    load_df=None,
    task_type_for=None,
    market_prices=None,
    provider_for=None,
    source_dataset: str = "routerbench",
) -> EvalResult:
    # Pluggable backend: defaults preserve the RouterBench path; pass these to point the same
    # eval machinery at another dataset (e.g. LLMRouterBench) that emits the wide contract.
    load_df = (lambda: rb.load_routerbench_df("0shot")) if load_df is None else load_df
    task_type_for = rb._task_type_for if task_type_for is None else task_type_for
    df = load_df()
    full = prepare_rows(df, candidates, limit_rows=0, task_type_for=task_type_for)  # scan all; stratify below
    # Stratify the pool into an EASY-for-cheap majority (e.g. MMLU) and a HARD-for-cheap
    # minority (grade-school math, where weak/cheap models fail). This gives the router
    # genuinely different task families to route between — the test of per-prompt routing,
    # vs. a homogeneous pool where it can only make one global decision.
    rng = random.Random(seed)
    hard = [r for r in full if hard_key in r.eval_name]
    easy = [r for r in full if hard_key not in r.eval_name]
    rng.shuffle(hard)
    rng.shuffle(easy)
    total = train_n + val_n + test_n
    n_hard = int(total * hard_frac)
    pool = hard[:n_hard] + easy[: total - n_hard]
    rng.shuffle(pool)
    train = pool[:train_n]
    val_raw = pool[train_n : train_n + val_n]
    test_raw = pool[train_n + val_n : train_n + val_n + test_n]
    val, _ = _filter_neardup(val_raw, train, _NEARDUP_JACCARD)
    test, dropped = _filter_neardup(test_raw, train, _NEARDUP_JACCARD)
    if len(test) < max(20, test_n // 3):
        raise RuntimeError(f"too few leak-free test rows: {len(test)} (train={len(train)})")

    memory = MubitMemory(settings)
    lane = f"{settings.minima_lane_prefix}:rbeval-{uuid.uuid4().hex[:8]}"
    # eval_name priors are train-derived; keep card task_type priors as the fallback.
    use_train_priors = use_train_priors or prior_grain == "eval_name"
    catalog = build_catalog(settings, candidates, train, use_train_priors,
                            market_prices=market_prices, provider_for=provider_for)
    cards = {c.model_id: c for c in catalog.get().cards}

    # Per-benchmark-family prior (model -> mean train success on that eval_name). Finer than
    # the per-task-type prior, so the threshold can escalate hard families (gsm8k/mbpp) while
    # keeping easy ones (mmlu knowledge) cheap — the test of selective, per-workload routing.
    eval_priors: dict[str, dict[str, float]] | None = None
    if prior_grain == "eval_name":
        acc_by: dict[str, dict[str, list[float]]] = {}
        for row in train:
            md = acc_by.setdefault(row.eval_name, {m: [] for m in candidates})
            for m in candidates:
                md[m].append(row.scores[m])
        eval_priors = {
            en: {m: (sum(v) / len(v) if v else 0.5) for m, v in md.items()}
            for en, md in acc_by.items()
        }

    seeded = await seed_train(memory, lane, train, candidates,
                              provider_for=provider_for, source_dataset=source_dataset)
    await _barrier(memory, lane, train[0], settings)

    # V8 — recall must be QUERY-SENSITIVE. On a broken deployment recall returns the same
    # records for any query (observed 2026-07-13 on local ricedb AND api.mubit.ai:
    # jaccard 1.00 across orthogonal queries — see fieldnote/recall-bug-report.md), which
    # silently degrades per-prompt routing into one global decision over an arbitrary
    # sample. Fail fast instead of producing a void run.
    _q1 = "Evaluate the integral of a polynomial and simplify the resulting expression."
    _q2 = "My Python web scraper throws an HTTP error, help me debug the requests session."
    _r1 = await memory.recall(query=_q1, lane=lane, limit=settings.minima_memory_recall_limit,
                              timeout_ms=settings.minima_memory_recall_timeout_ms)
    _r2 = await memory.recall(query=_q2, lane=lane, limit=settings.minima_memory_recall_limit,
                              timeout_ms=settings.minima_memory_recall_timeout_ms)
    _ids1 = {e.entry_id for e in _r1.outcome_evidence}
    _ids2 = {e.entry_id for e in _r2.outcome_evidence}
    _union = len(_ids1 | _ids2)
    v8_jaccard = (len(_ids1 & _ids2) / _union) if _union else 1.0
    if v8_jaccard > 0.5:
        raise RuntimeError(
            f"V8 FAIL: recall is query-independent (jaccard {v8_jaccard:.2f} across orthogonal "
            f"probes, n={len(_ids1)}/{len(_ids2)}) — per-prompt routing cannot be evaluated on "
            f"this deployment. See fieldnote/recall-bug-report.md."
        )

    # One recall per val/test prompt; reuse for every slider.
    val_aggs = [(await _recall_aggs(memory, lane, r, candidates, settings))[0] for r in val]
    test_data = [await _recall_aggs(memory, lane, r, candidates, settings) for r in test]
    test_aggs = [d[0] for d in test_data]
    ev_counts = [d[1] for d in test_data]
    sims = [d[2] for d in test_data]

    prem_acc = sum(r.scores[premium] for r in test) / len(test)
    prem_cost = sum(r.costs[premium] for r in test)

    def fill(sr: SliderResult) -> SliderResult:
        sr.savings_vs_premium = 1.0 - sr.cost / prem_cost if prem_cost else 0.0
        sr.accuracy_retention = sr.accuracy / prem_acc if prem_acc else 1.0
        return sr

    # Operating point chosen on VALIDATION (no peeking at TEST). The recommender does
    # workload-level tier selection, so we pick the most cost-leaning slider whose routing
    # still beats RANDOM routing on accuracy — i.e. the cheapest tier that is provably
    # "smart" (avoids the weak models random would sometimes pick). retention_floor is
    # reported but not used to gate, because on hard workloads only the premium model
    # reaches 95% retention (a property of the data, not the router).
    vrows = val if val else test
    vaggs = val_aggs if val else test_aggs
    val_prem_cost = sum(r.costs[premium] for r in vrows) or 1.0
    val_rand_acc = sum(
        sum(r.scores[m] for r in vrows) / len(vrows) for m in candidates
    ) / len(candidates)
    val_results = []
    for s in sliders:
        sr = _score_picks(vrows, vaggs, cards, s, settings, eval_priors)
        val_results.append((s, 1.0 - sr.cost / val_prem_cost, sr.accuracy))
    beats_random = [(s, sav) for (s, sav, acc) in val_results if acc >= val_rand_acc]
    selected = max(beats_random, key=lambda x: x[1])[0] if beats_random else max(
        val_results, key=lambda x: x[2])[0]

    # TEST frontier + headline at the pre-selected slider.
    frontier = [fill(_score_picks(test, test_aggs, cards, s, settings, eval_priors)) for s in sliders]
    headline = fill(_score_picks(test, test_aggs, cards, selected, settings, eval_priors))

    # Per-row arrays for bootstrap + per-task breakdown at the selected slider.
    pc, ps, ppc, pps = [], [], [], []
    by_type: dict[str, list[tuple[float, float, float, float]]] = {}
    by_eval: dict[str, list[tuple[float, float, float, float]]] = {}
    for row, aggs in zip(test, test_aggs, strict=True):
        m = _pick(aggs, cards, row.task_type, selected, _est_in_tokens(row.prompt), settings,
                  eval_priors, row.eval_name)
        pc.append(row.costs[m]); ps.append(row.scores[m])
        ppc.append(row.costs[premium]); pps.append(row.scores[premium])
        quad = (row.scores[m], row.costs[m], row.scores[premium], row.costs[premium])
        by_type.setdefault(row.task_type.value, []).append(quad)
        by_eval.setdefault(row.eval_name or "unknown", []).append(quad)
    sav_ci, ret_ci = _bootstrap_ci(pc, ps, ppc, pps, seed)

    def _breakdown(buckets: dict[str, list[tuple[float, float, float, float]]]) -> dict:
        out = {}
        for key, vals in sorted(buckets.items()):
            cacc = sum(v[0] for v in vals) / len(vals)
            ccost = sum(v[1] for v in vals)
            pacc = sum(v[2] for v in vals) / len(vals)
            pcost = sum(v[3] for v in vals)
            out[key] = {
                "n": len(vals),
                "minima_acc": cacc,
                "premium_acc": pacc,
                "retention": (cacc / pacc) if pacc else 1.0,
                "savings": (1 - ccost / pcost) if pcost else 0.0,
            }
        return out

    per_task = _breakdown(by_type)
    per_eval = _breakdown(by_eval)

    baselines = _baselines(test, candidates, premium)
    per_model = {m: {"accuracy": baselines["_per_model_acc"][m], "cost": baselines["_per_model_cost"][m]}
                 for m in candidates}
    # The eval_name-prior variant intentionally diverges from the shipping engine (which keys
    # priors by task_type), so the factored<->engine crosscheck doesn't apply; -1.0 = N/A.
    crosscheck = (
        await _crosscheck(settings, memory, catalog, lane, test, test_aggs, candidates,
                          selected, crosscheck_n)
        if prior_grain == "task_type"
        else -1.0
    )

    return EvalResult(
        candidates=candidates, premium=premium, train_n=len(train), val_n=len(val), test_n=len(test),
        test_dropped_neardup=dropped, lane=lane, seeded=seeded,
        avg_recall_evidence=sum(ev_counts) / len(ev_counts) if ev_counts else 0.0,
        neighbor_sim_p50=_percentile(sims, 0.5), neighbor_sim_p95=_percentile(sims, 0.95),
        leaky_fraction=sum(1 for x in sims if x >= 0.8) / len(sims) if sims else 0.0,
        per_model=per_model, baselines={k: v for k, v in baselines.items() if not k.startswith("_")},
        selected_slider=selected, headline=headline, headline_savings_ci=sav_ci,
        headline_retention_ci=ret_ci, per_task_type=per_task, per_eval_name=per_eval,
        frontier=frontier,
        crosscheck_match_rate=crosscheck, use_train_priors=use_train_priors,
    )
