"""Cost predictability (Phase 4): est-vs-actual MAPE + within-band hit-rate in /stats."""

from __future__ import annotations

from minima_harness.session import SessionStore
from minima_harness.session.format import EntryType
from minima_harness.session.store import SessionSummary
from minima_harness.tui import analytics


def _session_with_rows(tmp_path, rows):
    path = tmp_path / "s.jsonl"
    store = SessionStore.file_backed(path)
    store.append(EntryType.USER, {"text": "task"})
    for r in rows:
        store.append(EntryType.ASSISTANT, r)
    return SessionSummary(
        session_id="s", path=path, display_name="s", mtime=1.0, n_entries=len(rows) + 1
    )


def test_aggregate_computes_mape_and_band_hit_rate(tmp_path, monkeypatch):
    summ = _session_with_rows(
        tmp_path,
        [
            # est close, actual inside band
            {"model": "flash", "cost": 0.0010, "est_cost": 0.0012,
             "est_cost_low": 0.0008, "est_cost_high": 0.0015},
            # est off, actual outside band
            {"model": "flash", "cost": 0.0030, "est_cost": 0.0010,
             "est_cost_low": 0.0008, "est_cost_high": 0.0015},
            # legacy row (no est_cost) -> excluded from both metrics
            {"model": "flash", "cost": 0.002},
        ],
    )
    monkeypatch.setattr(analytics.SessionManager, "list_sessions", lambda self, cwd: [summ])

    stats = analytics.aggregate_sessions(tmp_path)
    assert stats["pred_n"] == 2  # legacy row skipped
    assert stats["band_n"] == 2
    assert stats["band_hit_rate"] == 0.5  # one in-band, one out
    # MAPE = mean(|0.001-0.0012|/0.001, |0.003-0.001|/0.003) = mean(0.2, 0.667) ≈ 0.433
    assert 0.40 < stats["cost_mape"] < 0.47

    out = analytics.format_stats(stats)
    assert "cost predictability: MAPE 43%" in out
    assert "in-range: 50%" in out


def test_aggregate_back_compat_legacy_rows(tmp_path, monkeypatch):
    summ = _session_with_rows(tmp_path, [{"model": "flash", "cost": 0.002}])  # no est fields
    monkeypatch.setattr(analytics.SessionManager, "list_sessions", lambda self, cwd: [summ])
    stats = analytics.aggregate_sessions(tmp_path)
    assert stats["cost_mape"] is None
    assert stats["band_hit_rate"] is None
    out = analytics.format_stats(stats)
    assert "predictability" not in out
    assert "in-range" not in out
