"""Data-grounded cost band (Phase 2a): observed/rescaled p25–p75, honest None fallback."""

from __future__ import annotations

import pytest

from minima.recommender import score
from minima.recommender.aggregate import aggregate_by_model
from minima.schemas.models_catalog import ModelCard
from tests.factories import make_evidence

CARD = ModelCard(model_id="m", provider="p", input_cost_per_mtok=3.0, output_cost_per_mtok=15.0)


def _agg(*, costs: list[float] | None = None, out_tokens: list[int] | None = None):
    ev = []
    i = 0
    for c in costs or []:
        i += 1
        ev.append(make_evidence("a", 1.0, entry_id=str(i), cost_usd=c))
    for o in out_tokens or []:
        i += 1
        ev.append(make_evidence("a", 1.0, entry_id=str(i), output_tokens=o))
    return aggregate_by_model(ev)["a"]


def test_observed_cost_band_monotonic_and_within_range():
    agg = _agg(costs=[0.01, 0.02, 0.03, 0.04, 0.05])
    band = agg.observed_cost_band(min_n=3, q_low=0.25, q_high=0.75)
    assert band is not None
    lo, hi = band
    assert lo <= hi
    assert 0.01 <= lo and hi <= 0.05


def test_observed_cost_band_widens_with_dispersion():
    tight = _agg(costs=[0.02, 0.02, 0.02, 0.02])
    wide = _agg(costs=[0.005, 0.02, 0.02, 0.08])
    tl, th = tight.observed_cost_band(min_n=3)
    wl, wh = wide.observed_cost_band(min_n=3)
    assert (th - tl) <= (wh - wl)


def test_band_none_below_min_n():
    agg = _agg(costs=[0.01, 0.02])
    assert agg.observed_cost_band(min_n=3) is None
    assert agg.observed_output_tokens_band(min_n=3) is None


def test_effective_cost_band_observed_basis():
    agg = _agg(costs=[0.01, 0.02, 0.03, 0.04])
    out = score.effective_cost_band(
        CARD, agg, 1000, use_cache=False, basis="observed", min_cost_n=3
    )
    assert out is not None
    (lo, hi), label = out
    assert lo <= hi
    assert label.startswith("observed_")


def test_effective_cost_band_rescaled_reprices_output():
    agg = _agg(out_tokens=[100, 200, 300, 400])
    out = score.effective_cost_band(
        CARD, agg, input_tokens=1000, use_cache=False, basis="rescaled", min_cost_n=3
    )
    assert out is not None
    (lo, hi), label = out
    assert lo < hi  # more output tokens at the high end -> higher cost
    assert label.startswith("rescaled_")
    # fixed input cost + output band re-priced at the card's output rate
    cost_in = 1000 / 1_000_000.0 * 3.0
    assert lo == pytest.approx(cost_in + (agg.observed_output_tokens_band(3)[0] / 1e6) * 15.0)


def test_effective_cost_band_estimate_and_none_agg():
    agg = _agg(costs=[0.01, 0.02, 0.03])
    assert score.effective_cost_band(CARD, agg, 1000, False, "estimate", 3) is None
    assert score.effective_cost_band(CARD, None, 1000, False, "observed", 3) is None
