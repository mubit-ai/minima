"""Scoring: capability prior + memory -> predicted success; cost; slider -> threshold."""

from __future__ import annotations

import random

from minima.memory.records import clamp01
from minima.recommender.types import ModelAggregate
from minima.schemas.common import TaskType
from minima.schemas.models_catalog import ModelCard

_DEFAULT_PRIOR = 0.5


def capability_prior(card: ModelCard, task_type: TaskType) -> float:
    """Prior probability that this model handles this task type well, in [0, 1]."""
    by_type = card.capability_by_task_type.get(task_type)
    if by_type is not None:
        return clamp01(by_type)
    intel = card.capability_priors.get("intelligence_index")
    return clamp01(intel) if intel is not None else _DEFAULT_PRIOR


def predicted_success(
    agg: ModelAggregate | None, prior: float, pseudocount: float
) -> tuple[float, float]:
    """Beta-smoothed success blended with the capability prior.

    Returns ``(predicted_success, confidence)``. With no evidence, predicted success
    falls back to the prior and confidence is 0.
    """
    alpha0 = prior * pseudocount
    beta0 = (1.0 - prior) * pseudocount
    if agg is None or agg.weight_sum <= 0.0:
        return clamp01(prior), 0.0
    p = (agg.weighted_success + alpha0) / (agg.weight_sum + alpha0 + beta0)
    confidence = 1.0 - 1.0 / (1.0 + agg.weight_sum)
    return clamp01(p), clamp01(confidence)


def estimate_cost(
    card: ModelCard,
    input_tokens: int,
    output_tokens: int,
    use_cache: bool = False,
    cache_fraction: float = 0.0,
) -> tuple[float, dict[str, float]]:
    """Flat token estimate. ``use_cache`` prices input fully at the cache-read rate (caching
    is REQUIRED); ``cache_fraction`` in (0,1] is the lever-aware blend — assume that fraction
    of input is served from cache at the read rate, the rest at the full rate."""
    if use_cache and card.cache_read_cost_per_mtok is not None:
        in_price = card.cache_read_cost_per_mtok
    elif cache_fraction > 0.0 and card.cache_read_cost_per_mtok is not None:
        f = min(1.0, cache_fraction)
        in_price = f * card.cache_read_cost_per_mtok + (1.0 - f) * card.input_cost_per_mtok
    else:
        in_price = card.input_cost_per_mtok
    cost_in = (input_tokens / 1_000_000.0) * in_price
    cost_out = (output_tokens / 1_000_000.0) * card.output_cost_per_mtok
    breakdown = {"input": round(cost_in, 8), "output": round(cost_out, 8)}
    return cost_in + cost_out, breakdown


def choose_cost_basis(
    aggs_by_id: dict[str, ModelAggregate | None],
    use_observed: bool,
    require_caching: bool,
    min_cost_n: int,
) -> str:
    """Pick ONE cost basis for the whole candidate set so costs are compared like-for-like.

    Returns the best tier EVERY candidate can support:
    - ``"rescaled"``: observed output-token behavior priced for THIS request (size-exact AND
      reasoning-aware) — when every candidate has >= ``min_cost_n`` output-token observations.
    - ``"observed"``: robust median realized $/call (reasoning-aware, size-approximate) — when
      every candidate has >= ``min_cost_n`` cost observations and caching is not requested
      (recalled history is non-cached, so the cache-aware estimate is the right basis there).
    - ``"estimate"``: flat (cache-aware) token estimate — cold-start / mixed-evidence fallback.
    """
    if not use_observed:
        return "estimate"
    aggs = list(aggs_by_id.values())
    if not aggs:
        return "estimate"
    if all(a is not None and a.observed_output_tokens(min_cost_n) is not None for a in aggs):
        return "rescaled"
    if not require_caching and all(
        a is not None and a.observed_cost(min_cost_n) is not None for a in aggs
    ):
        return "observed"
    return "estimate"


def rescaled_cost(
    card: ModelCard, agg: ModelAggregate, input_tokens: int, use_cache: bool, min_cost_n: int
) -> float | None:
    """Re-scale observed output behavior to the current request: this request's input tokens at
    the (cache-aware) input rate + the model's observed median output tokens at the output rate.
    None when there aren't enough output-token observations.
    """
    out_tokens = agg.observed_output_tokens(min_cost_n)
    if out_tokens is None:
        return None
    if use_cache and card.cache_read_cost_per_mtok is not None:
        in_price = card.cache_read_cost_per_mtok
    else:
        in_price = card.input_cost_per_mtok
    cost_in = (input_tokens / 1_000_000.0) * in_price
    cost_out = (out_tokens / 1_000_000.0) * card.output_cost_per_mtok
    return cost_in + cost_out


def effective_cost(
    card: ModelCard,
    agg: ModelAggregate | None,
    input_tokens: int,
    output_tokens: int,
    use_cache: bool,
    basis: str,
    min_cost_n: int,
    cache_fraction: float = 0.0,
) -> tuple[float, dict[str, float]]:
    """Cost used for ranking, on the caller-chosen ``basis`` (homogeneous across candidates).

    The token estimate assumes a fixed completion length, so it understates models that spend
    many output tokens on internal reasoning/thinking. ``"rescaled"`` re-prices observed output
    behavior for this request; ``"observed"`` uses the robust median realized $/call; both fall
    through to the (cache-aware) ``estimate`` when their evidence is absent.
    """
    if basis == "rescaled" and agg is not None:
        rc = rescaled_cost(card, agg, input_tokens, use_cache, min_cost_n)
        if rc is not None:
            obs_out = agg.observed_output_tokens(min_cost_n) or 0.0
            return rc, {"rescaled": round(rc, 8), "obs_output_tokens": round(obs_out, 1)}
    if basis == "observed" and agg is not None:
        observed = agg.observed_cost(min_cost_n)
        if observed is not None:
            return observed, {"observed_avg": round(observed, 8)}
    return estimate_cost(card, input_tokens, output_tokens, use_cache, cache_fraction)


def effective_cost_band(
    card: ModelCard,
    agg: ModelAggregate | None,
    input_tokens: int,
    use_cache: bool,
    basis: str,
    min_cost_n: int,
    q_low: float = 0.25,
    q_high: float = 0.75,
) -> tuple[tuple[float, float], str] | None:
    """Data-grounded predictable cost band ``((low, high), basis_label)`` matching the ranking
    ``basis`` — the honest range behind the point ``effective_cost``. ``"rescaled"`` re-prices
    the observed output-token band for this request (input fixed, output the band); ``"observed"``
    uses the realized $/call band directly. Returns ``None`` for the ``"estimate"`` basis or when
    evidence is below ``min_cost_n`` — the caller renders "no range yet" rather than fabricating.
    """
    if agg is None:
        return None
    label = f"p{int(round(q_low * 100))}_p{int(round(q_high * 100))}"
    if basis == "rescaled":
        band = agg.observed_output_tokens_band(min_cost_n, q_low, q_high)
        if band is not None:
            lo_out, hi_out = band
            in_price = (
                card.cache_read_cost_per_mtok
                if use_cache and card.cache_read_cost_per_mtok is not None
                else card.input_cost_per_mtok
            )
            cost_in = (input_tokens / 1_000_000.0) * in_price
            lo = cost_in + (lo_out / 1_000_000.0) * card.output_cost_per_mtok
            hi = cost_in + (hi_out / 1_000_000.0) * card.output_cost_per_mtok
            return (lo, hi), f"rescaled_{label}"
    if basis == "observed":
        band = agg.observed_cost_band(min_cost_n, q_low, q_high)
        if band is not None:
            return band, f"observed_{label}"
    return None


def threshold_from_slider(
    cost_quality_tradeoff: float, tau_min: float, tau_max: float, min_quality: float | None = None
) -> float:
    """Map the 0..10 slider to a minimum acceptable predicted-success threshold.

    0 = accept the cheapest model clearing ``tau_min``; 10 = require ``tau_max``.
    """
    cq = max(0.0, min(10.0, cost_quality_tradeoff))
    tau = tau_min + (cq / 10.0) * (tau_max - tau_min)
    if min_quality is not None:
        tau = max(tau, min_quality)
    return tau


def ranking_score(predicted: float, normalized_cost: float, cost_quality_tradeoff: float) -> float:
    """Smooth blend used to order the returned list (distinct from the hard threshold)."""
    cq = max(0.0, min(10.0, cost_quality_tradeoff))
    lam = 0.3 + 0.07 * cq  # cq=0 -> 0.3 (cost-leaning); cq=10 -> 1.0 (quality-only)
    return lam * predicted - (1.0 - lam) * normalized_cost


def posterior_interval_width(
    agg: ModelAggregate | None, prior: float, pseudocount: float
) -> float:
    """Approximate 95% credible-interval width of the Beta-smoothed success estimate.

    Normal approximation on the posterior mean: width = 2 * 1.96 * sqrt(p(1-p)/n_eff)
    where n_eff = weight_sum + pseudocount. With no evidence the width is maximal (1.0) —
    "we know nothing" reads as full uncertainty, the natural escalation signal.
    """
    p, _ = predicted_success(agg, prior, pseudocount)
    n_eff = (agg.weight_sum if agg is not None else 0.0) + max(pseudocount, 1e-9)
    width = 2.0 * 1.96 * (max(p * (1.0 - p), 1e-9) / n_eff) ** 0.5
    return min(1.0, width)


def beta_params(
    agg: ModelAggregate | None, prior: float, pseudocount: float
) -> tuple[float, float]:
    """Beta posterior (alpha, beta) for a candidate's success — the conjugate of
    :func:`predicted_success` (whose mean is alpha / (alpha + beta)). Both are floored at a
    tiny positive value so they are valid Beta parameters for sampling.
    """
    alpha0 = prior * pseudocount
    beta0 = (1.0 - prior) * pseudocount
    if agg is None or agg.weight_sum <= 0.0:
        return max(alpha0, 1e-6), max(beta0, 1e-6)
    alpha = agg.weighted_success + alpha0
    beta = (agg.weight_sum - agg.weighted_success) + beta0
    return max(alpha, 1e-6), max(beta, 1e-6)


def thompson_select(
    items: list[tuple[str, float, float, float]],
    tau: float,
    rng: random.Random,
    samples: int = 128,
) -> tuple[str, dict[str, float]]:
    """Posterior-sampling (Thompson) selection over the cost-aware objective.

    ``items`` is ``(model_id, alpha, beta, est_cost_usd)`` per candidate. Each Monte-Carlo
    round samples theta_m ~ Beta(alpha_m, beta_m) and picks the cheapest model whose sampled
    success clears ``tau`` (falling back to the highest sampled success when none clears).
    The selection frequencies ARE the propensities (so IPW/off-policy evaluation stay valid),
    and the returned pick is sampled proportional to those frequencies — consistent with them.
    """
    if not items:
        return "", {}
    counts = {m: 0 for m, _, _, _ in items}
    for _ in range(max(1, samples)):
        theta = {m: rng.betavariate(a, b) for m, a, b, _ in items}
        clears = [(m, cost) for m, _, _, cost in items if theta[m] >= tau]
        if clears:
            pick = min(clears, key=lambda mc: (mc[1], -theta[mc[0]]))[0]
        else:
            pick = max(items, key=lambda it: theta[it[0]])[0]
        counts[pick] += 1
    total = sum(counts.values()) or 1
    propensities = {m: counts[m] / total for m in counts}
    pick_id = rng.choices(list(counts), weights=[counts[m] for m in counts], k=1)[0]
    return pick_id, propensities
