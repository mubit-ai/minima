from __future__ import annotations

from pathlib import Path
from typing import Any

from minima_harness.session import SessionManager, SessionStore
from minima_harness.session.format import EntryType


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
    return "\n".join(lines)
