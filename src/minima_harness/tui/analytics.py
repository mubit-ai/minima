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
    for s in summaries[-n:]:
        store = SessionStore.file_backed(s.path)
        stats["sessions"] += 1
        for e in store.entries:
            if e.type == EntryType.USER:
                stats["prompts"] += 1
            elif e.type == EntryType.ASSISTANT:
                p = e.payload
                stats["total_in"] += p.get("in_tokens", 0)
                stats["total_out"] += p.get("out_tokens", 0)
                stats["total_cost"] += p.get("cost", 0.0)
                model = p.get("model", "?")
                stats["per_model"][model] = stats["per_model"].get(model, 0) + 1
    stats["cost_position"] = cost_position_for(stats["per_model"])
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
    return "\n".join(lines)
