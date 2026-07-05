# AGENTS.md

Guidance for both human and AI agents working in this repo.

## What this repo is

- **`src/minima/`** — Minima: a recommend-only LLM cost-optimization service (FastAPI,
  Python 3.11+). It does NOT proxy LLM calls. It tells you which model to run, you run
  it, judge quality, and feed the outcome back via `POST /v1/feedback` so its Mubit
  memory sharpens. See `docs/concepts.md` for the algorithm.
- **`client_sdk/minima_client/`** — bundled sync + async Python client. Ships inside the
  same wheel.
- **`packages/tui/`** — the `minima` CLI/TUI (TypeScript/Bun, shipped via Homebrew:
  `brew tap mubit-ai/minima`). It replaced the old Python harness (`src/minima_harness`,
  removed in v0.7.0). See `packages/tui/README.md`.

## The Minima loop (always respect this)

```
recommend  ->  run the model yourself  ->  judge quality  ->  feedback
```

Minima never runs the model. Any harness owns model dispatch + quality judging. Feedback
MUST include realized `input_tokens` / `output_tokens` / `actual_cost_usd` / `latency_ms`
so the cost basis can climb `estimate -> observed -> rescaled` (the biggest accuracy
lever). Outcome thresholds: `success >= 0.8`, `partial >= 0.4`, else `failure`.

## Conventions

- `from __future__ import annotations` at the top of every module.
- Pydantic v2 `BaseModel` for serializable schemas; `@dataclass(slots=True)` for internal
  types; `StrEnum` for enums; `Protocol` for seams (`Memory`, `Reasoner`, `Provider`).
- Async-first. Bridge sync SDKs (Mubit) off the event loop via `anyio`/threadpools.
- `structlog` via `get_logger("minima.<sub>")`.
- ruff `line-length=100`, mypy `py311`. Never break the hot path: bookkeeping failures are
  logged-and-swallowed (`except Exception: # noqa: BLE001`).
- NO comments unless asked. Match existing style.

## Commands

```bash
uv sync --extra dev                       # install (uv is the package manager)
uv run ruff check . && uv run ruff format .  # lint + format
uv run mypy src/minima                     # typecheck
uv run pytest                              # unit + integration (hermetic, offline)
uv run pytest -m live                      # needs a running Mubit (make run-mubit)
make run                                   # local Minima on :8080
```

Offline tests MUST stay hermetic: the `conftest.py` autouse fixture neutralizes `.env`.
Use `tests/factories.py:FakeMemory` + `create_app(...)` + `TestClient` for in-process
tests without Mubit.

## Agent harness

The Python harness (`src/minima_harness`) was removed in v0.7.0. Its successor is the
TypeScript harness + TUI in `packages/tui` (the shipped `minima` CLI) — see
`packages/tui/README.md` for architecture, commands, and hard rules.
