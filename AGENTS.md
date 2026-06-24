# AGENTS.md

Guidance for both human and AI agents working in this repo.

## What this repo is

- **`src/minima/`** — Minima: a recommend-only LLM cost-optimization service (FastAPI,
  Python 3.11+). It does NOT proxy LLM calls. It tells you which model to run, you run
  it, judge quality, and feed the outcome back via `POST /v1/feedback` so its Mubit
  memory sharpens. See `docs/concepts.md` for the algorithm.
- **`client_sdk/minima_client/`** — bundled sync + async Python client (`AsyncMinimaClient`
  is what the harness uses). Ships inside the same wheel.
- **`src/minima_harness/`** — a lean Python port of `@earendil-works/pi`'s agent harness
  (`pi-ai` + `pi-agent-core`), made Minima-native. See its `LICENSE_PI`.

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
uv run mypy src/minima src/minima_harness     # typecheck
uv run pytest                              # unit + integration (hermetic, offline)
uv run pytest -m live                      # needs a running Mubit (make run-mubit)
uv run pytest tests/harness                # harness-only smoke
make run                                   # local Minima on :8080 (harness dev target)
```

Offline tests MUST stay hermetic: the `conftest.py` autouse fixture neutralizes `.env`.
Use `tests/factories.py:FakeMemory` + `create_app(...)` + `TestClient` for in-process
tests without Mubit. For the harness, the faux provider
(`minima_harness.ai.providers.register_faux_provider`) gives hermetic LLM calls.

## minima_harness build roadmap

Phases are independently verifiable; do not skip the verify step.

- **Phase 0 (done)** — scaffold: `ai/` types, registry, tools, usage, stream dispatcher,
  faux provider; `minima/config.py`; `tasks/` corpus; AGENTS.md; pyproject wiring.
- **Phase 1 (done)** — ported `pi-ai`: real providers (`anthropic`, `google`,
  `openai_compat` via raw httpx) registering into the provider registry (lazy, SDK
  optional); cross-provider compat (`ai/compat.py`). Tests: faux + hermetic SSE/SDK
  mapping + `-m live`.
- **Phase 2 (done)** — ported `pi-agent-core`: `Agent` + `agent_loop` async generator,
  events, tool execution loop (parallel via anyio), beforeToolCall/afterToolCall hooks,
  steering/follow-up, abort, max_turns guard.
- **Phase 3 (done)** — Minima integration: `minima/router.py` (recommend->set model,
  feedback), `minima/mapping.py` (model_id <-> Model), `minima/judge.py`
  (`QualityJudge` Protocol + `LLMJudge`/`DeterministicJudge`/`ConstJudge`),
  `minima/runtime.py` (`MinimaAgent`). Hermetic via FakeMemory+ASGI app; live test.
- **Phase 4 (done)** — `examples/harness_warmup.py` (demo + live modes),
  `docs/harness.md`, README + examples/README sections.
- **Phase A (done)** — cost observability: `RoutingResult` carries Minima's full ranked/
  rationale/warnings payload + `baseline_cost_usd`; `CostMeter`; `before_route`
  override/veto hook.
- **Phase B (done)** — code-quality-aware routing: `CodeHealthExtractor` +
  `ContextExtractor` protocol; `tags`/`difficulty`/`expected_input_tokens` from touched
  files flow into `recommend()` via `prompt(files=...)`, with a discrimination gate.
- **Phase C (done)** — token yield: `turns_taken` per prompt → `feedback(iterations=)` →
  `FeedbackRequest`/`OutcomeRecord` gain a backward-compatible `iterations` field.

## Hard rules

- Do NOT add the `openai` SDK as a dependency — the OpenAI-compatible provider uses raw
  `httpx` (matches PI's fetch approach; keeps deps lean). Reuse minima's existing
  optional extras (`anthropic`, `google-genai`) for those providers.
- Routing must be bypassable (`minima=None`) so the agent runtime works without Minima.
- Keep PI's wire discriminator values (`type: "toolCall"`, `role`, `stopReason`) so the
  shapes stay recognizable; snake_case the field names.
