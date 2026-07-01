from __future__ import annotations

from pathlib import Path
from typing import Any

from minima_harness.session import SessionManager, SessionStore
from minima_harness.session.format import EntryType


def cost_position_for(per_model: dict[str, int]) -> float | None:
    """Mean normalized price-ladder position over used models (0=cheapest..1=priciest).

    The local TUI mirror of the server's routing-optimality ``cost_position``: lower means
    the agent is routinely landing on cheaper models within the available pool. Returns
    None when prices can't be resolved (offline / unknown models). Pure + registry-driven.
    """
    try:
        from minima_harness.ai.registry import all_models, find_model_by_id
    except Exception:  # noqa: BLE001 - registry unavailable
        return None
    prices = [m.cost.input + m.cost.output for m in all_models()]
    if not prices:
        return None
    lo, hi = min(prices), max(prices)
    if hi <= lo:
        return None
    weighted = 0.0
    counted = 0
    for model_id, count in per_model.items():
        model = find_model_by_id(model_id)
        if model is None:
            continue
        price = model.cost.input + model.cost.output
        weighted += ((price - lo) / (hi - lo)) * count
        counted += count
    return round(weighted / counted, 4) if counted else None


def aggregate_sessions(cwd: Path, n: int = 10) -> dict[str, Any]:
    """Aggregate stats from the last ``n`` local session files for this project."""
    mgr = SessionManager()
    summaries = mgr.list_sessions(cwd)
    stats: dict[str, Any] = {
        "sessions": 0,
        "prompts": 0,
        "total_in": 0,
        "total_out": 0,
        "total_cost": 0.0,
        "per_model": {},
    }
    ape_sum = 0.0  # Σ |actual−est| / actual  (mean absolute percentage error)
    pred_n = 0  # rows with both an estimate and a realized cost
    band_n = 0  # rows that carried a predicted cost band
    band_hits = 0  # rows where the realized cost landed inside the band
    for s in summaries[:n]:  # list_sessions is sorted most-recent-first → take the front n
        store = SessionStore.file_backed(s.path)
        stats["sessions"] += 1
        for e in store.entries:
            if e.type == EntryType.USER:
                stats["prompts"] += 1
            elif e.type == EntryType.ASSISTANT:
                p = e.payload
                stats["total_in"] += p.get("in_tokens", 0)
                stats["total_out"] += p.get("out_tokens", 0)
                actual = p.get("cost", 0.0)
                stats["total_cost"] += actual
                model = p.get("model", "?")
                stats["per_model"][model] = stats["per_model"].get(model, 0) + 1
                # Predictability (guard with .get so pre-Phase-4 rows are simply skipped).
                est = p.get("est_cost")
                if est is not None and actual > 0:
                    ape_sum += abs(actual - est) / max(actual, 1e-9)
                    pred_n += 1
                low, high = p.get("est_cost_low"), p.get("est_cost_high")
                if low is not None and high is not None and actual > 0:
                    band_n += 1
                    if low <= actual <= high:
                        band_hits += 1
    stats["cost_position"] = cost_position_for(stats["per_model"])
    stats["pred_n"] = pred_n
    stats["cost_mape"] = round(ape_sum / pred_n, 4) if pred_n else None
    stats["band_n"] = band_n
    stats["band_hit_rate"] = round(band_hits / band_n, 4) if band_n else None
    return stats


def format_stats(stats: dict[str, Any]) -> str:
    lines = [
        f"sessions: {stats['sessions']}",
        f"prompts: {stats['prompts']}",
        f"tokens: ↑{stats['total_in']} ↓{stats['total_out']}",
        f"cost: ${stats['total_cost']:.4f}",
    ]
    if stats["per_model"]:
        model_lines = ", ".join(f"{k}×{v}" for k, v in sorted(stats["per_model"].items()))
        lines.append(f"models: {model_lines}")
    if stats.get("cost_position") is not None:
        lines.append(
            f"cost position: {stats['cost_position']:.2f} (0=cheapest · 1=priciest in pool)"
        )
    if stats.get("cost_mape") is not None:
        lines.append(
            f"cost predictability: MAPE {stats['cost_mape']:.0%} "
            f"over {stats['pred_n']} est-vs-actual turn(s)"
        )
    if stats.get("band_hit_rate") is not None:
        lines.append(
            f"in-range: {stats['band_hit_rate']:.0%} of actuals landed in the predicted "
            f"band ({stats['band_n']} turn(s))"
        )
    return "\n".join(lines)
