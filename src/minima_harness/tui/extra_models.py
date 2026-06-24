from __future__ import annotations

import json
import logging
from pathlib import Path

from minima_harness.ai.types import Model, ModelCost
from minima_harness.tui.customize import GLOBAL_DIR

_log = logging.getLogger("minima_harness.tui.extra_models")


def load_extra_models(cwd: Path) -> list[Model]:
    """Read ``models.json`` (global + project) → OpenAI-compatible Model list."""
    out: list[Model] = []
    for path in (GLOBAL_DIR / "models.json", cwd / ".pi" / "models.json"):
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        entries = data.get("models", []) if isinstance(data, dict) else data
        for m in entries:
            if not isinstance(m, dict) or "id" not in m:
                continue
            try:
                out.append(
                    Model(
                        id=m["id"],
                        provider=m.get("provider", "openai-compat"),
                        api="openai-completions",
                        name=str(m.get("name") or m["id"]),
                        cost=ModelCost(
                            input=float(m.get("input_cost", 0.0)),
                            output=float(m.get("output_cost", 0.0)),
                        ),
                        context_window=int(m.get("context_window", 128_000)),
                        max_tokens=int(m.get("max_tokens", 4096)),
                        base_url=m.get("base_url"),
                    )
                )
            except Exception:  # noqa: BLE001
                _log.warning("bad models.json entry: %s", m)
    return out


def register_extra_models(cwd: Path) -> None:
    from minima_harness.ai import register_model

    for model in load_extra_models(cwd):
        register_model(model)
