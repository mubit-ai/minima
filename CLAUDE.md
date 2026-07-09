# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Two shipped-in-one-wheel Python packages, a bundled client SDK, and a separate TypeScript harness:

- **`src/minima/`** — Minima: a **recommend-only** LLM cost-optimization service (FastAPI, Python 3.11+). It never proxies, runs, or caches an LLM call. It answers "which model should I run for this task?" and learns from the outcome you report back. Memory is backed by [Mubit](https://docs.mubit.ai) and is the *only* external dependency of the core recommender.
- **`src/minima_harness/`** — a from-scratch Python port of [`@earendil-works/pi`](https://github.com/earendil-works/pi)'s agent toolkit (`pi-ai` + `pi-agent-core`), made Minima-native. It is the "run the model yourself" half of the loop, packaged: an `Agent` runtime with tool calling + a `MinimaAgent` that routes each prompt through Minima and feeds realized tokens/cost/quality back. Also ships a Textual TUI (`minima-harness`). See `src/minima_harness/LICENSE_PI` for MIT attribution.
- **`client_sdk/minima_client/`** — bundled sync + async Python client. `AsyncMinimaClient` is what the Python harness talks to.
- **`packages/tui/`** — `minima-tui` (v0.6.0): a **TypeScript/Ink port of `src/minima_harness/`**, run on **Bun** (`bun:sqlite`, `>=1.2`). Same `route → run → judge → feedback` loop, same `/v1/*` contract to the Python service, but with its own SQLite persistence spine (`src/db/minima_db.ts`, event-sourced, WAL) and a `BudgetLedger`. This is the **active harness** for new agent-runtime work (see the Ground-Truth Core roadmap below); the Python harness is now effectively the reference implementation it was ported from. Separate toolchain — not part of the Python wheel or `uv`.

### The Minima loop (respect this everywhere)

```
recommend  ->  run the model yourself  ->  judge quality  ->  feedback
```

Minima never runs the model. Feedback MUST carry realized `input_tokens` / `output_tokens` / `actual_cost_usd` / `latency_ms` so the cost basis can climb `estimate -> observed -> rescaled` — the single biggest accuracy lever. Do **not** echo Minima's own `est_cost_usd` back as the actual cost. Outcome thresholds: `success >= 0.8`, `partial >= 0.4`, else `failure`.

## Commands

`uv` is the package manager. Common targets (see `Makefile`):

```bash
make install     # uv sync --extra dev  (dev pulls server+harness+tui for the full suite)
make run         # local Minima on :8080 (uvicorn, --reload); interactive docs at /docs
make test        # unit + integration, hermetic/offline: pytest -m "not live and not eval"
make lint        # ruff check + mypy src/minima
make fmt         # ruff check --fix + ruff format
make live        # pytest -m live  — needs a running Mubit (make run-mubit in the Mubit repo)
make eval        # pytest -m eval  — slow offline RouterBench savings evaluation
make seed        # minima-seed (LIMIT=, LANE= overridable) — load cold-start memory
```

Direct invocations:

```bash
uv run pytest tests/unit/test_foo.py::test_bar   # single test
uv run pytest tests/harness                        # harness-only (hermetic)
uv run mypy src/minima src/minima_harness          # typecheck (Makefile lint only does src/minima)
uv run --extra harness --extra tui minima-harness  # launch the TUI (or: make harness ARGS=...)
```

Test markers (`pyproject.toml`): `live` = requires a running Mubit; `eval` = slow offline RouterBench. Default `make test`/`pytest` excludes both.

The **TypeScript harness** (`packages/tui/`) has its own Bun toolchain — none of the `uv`/`make` targets touch it:

```bash
cd packages/tui && bun install
bun test          # hermetic (mock fetch + faux provider + in-process mock service)
bun run check     # tsc --noEmit
bun run lint      # biome check src
bun run format    # biome format --write src
bun run build     # -> dist/minima native binary (bun build --compile)
```

The design docs referenced by the Ground-Truth Core plan live in `docs/` (`agent-core-architecture.md`, `agent-core-implementation-plan.md`, `goals-feature-plan.md`).

## Testing constraints (important)

- **Offline tests MUST stay hermetic.** `tests/conftest.py` has an autouse fixture that neutralizes `.env` — never rely on ambient credentials in a non-`live` test.
- For service tests: `tests/factories.py:FakeMemory` + `create_app(...)` + `TestClient` gives a full in-process app with no Mubit.
- For harness tests: `minima_harness.ai.providers.register_faux_provider` gives hermetic LLM calls; the full Minima round-trip is exercised in-process via `create_app` + `FakeMemory` + an ASGI transport (see `tests/harness/test_minima_e2e.py`).

## Conventions

- `from __future__ import annotations` at the top of every module.
- Pydantic v2 `BaseModel` for serializable schemas; `@dataclass(slots=True)` for internal types; `StrEnum` for enums; `Protocol` for seams (`Memory`, `Reasoner`, `Provider`, `QualityJudge`, `ContextExtractor`).
- Async-first. Bridge sync SDKs (Mubit) off the event loop via `anyio`/threadpools.
- Logging: `structlog` via `get_logger("minima.<sub>")`.
- ruff `line-length=100`, target `py311`, lint set `E,F,I,UP,B,C4`. **Never break the hot path**: bookkeeping/feedback failures are logged-and-swallowed (`except Exception: # noqa: BLE001`).
- **No comments unless asked.** Match existing style.

## Architecture — the service (`src/minima/`)

Request flow (`api/routers/recommend.py` → `recommender/engine.py`):

1. **classify** (`recommender/classify.py`) — derives task features/type from the prompt (regex + signal tables; this is `E501`-exempt and is the subject of the current branch's rewrite).
2. **recall** (`memory/adapter.py`) — the *only* Mubit touchpoint; pulls similar past `task → model → outcome` records using Mubit's server-side embeddings (no local embedding model).
3. **aggregate + score** (`recommender/aggregate.py`, `score.py`) — ranks candidates by *real* cost. The cost basis is one of three tiers chosen for the whole candidate set: `estimate` (catalog prices, cold start) → `observed` (median realized $/call) → `rescaled` (this request's input priced + observed output behavior; size-exact and reasoning-aware).
4. **escalation** (`recommender/escalation.py`) — when memory is thin/conflicting, optionally consult a cheap-LLM reasoner (`llm/`, off by default, `MINIMA_REASONER_PROVIDER`).
5. **feedback** (`api/routers/feedback.py`) — writes the outcome back to Mubit, reinforcing memory.

Other packages: `catalog/` (model cost + capability priors, refreshed from litellm/openrouter sources), `tenancy/` (multi-tenant runtime — many orgs, per-org Mubit, one deployment), `seeding/` (`minima-seed` CLI for cold-start history), `schemas/` (Pydantic request/response models).

Everything external is behind a Protocol (`Memory`, `Reasoner`, `Provider`) so it can be faked in tests. The server stack (fastapi/uvicorn/psycopg2/redis) lives in the `[server]` extra — the core recommender + client is dependency-light on purpose.

## Architecture — the harness (`src/minima_harness/`)

`MinimaAgent.prompt(task)` = **route** (`minima/router.py` → `POST /v1/recommend`, sets the agent's model via `minima/mapping.py`) → **run** (ported agent loop, streams the model, executes tools in parallel, may take several turns) → **judge** (`minima/judge.py`) → **feed back** (`POST /v1/feedback` with realized cost). Routing is bypassable: `minima=None` (library) or `allow_offline=True` runs on the current model with no feedback.

Layers:

- `ai/` — ported `pi-ai`: unified multi-provider LLM API. `types.py`, `registry.py`, `stream.py`, `tools.py`, `usage.py` (realized cost = tokens × price), `compat.py` (cross-provider normalization), `providers/` (base Protocol + `faux` for tests · `anthropic` · `google` · `openai_compat` over raw httpx).
- `agent/` — ported `pi-agent-core`: `agent_loop` async generator, events, tool execution loop, before/afterToolCall hooks, steering/follow-up, abort, `max_turns` guard.
- `minima/` — the Minima-native layer (original work): `config.py` (`HarnessConfig`), `router.py`, `mapping.py`, `judge.py`, `meter.py` (`CostMeter` — per-prompt est/actual/savings table), `signals.py` (`CodeHealthExtractor` — code-health signals from touched files feed `tags`/`difficulty`/`expected_input_tokens` into `recommend()`), `cache.py`, `runtime.py` (`MinimaAgent`).
- `tools/` — concrete agent tools (bash, edit, read, write, grep, find, ls).
- `tui/` — the Textual app + `minima-harness` CLI (`tui/cli.py`), plus per-user credential storage (`config_store.py`: OS keyring → `~/.minima-harness/config.env` at 0600 fallback, loaded at lowest precedence).
- `session/`, `tasks/` — session persistence and the task corpus + `grade_outcome` thresholds.

Full design + integration-point notes: `docs/harness.md`. Per-phase build history: `AGENTS.md`.

## Hard rules (harness)

- **Do NOT add the `openai` SDK** as a dependency — the OpenAI-compatible provider uses raw `httpx`. Reuse the existing optional extras (`anthropic`, `google-genai`) for those providers.
- **Routing must be bypassable** (`minima=None`) so the agent runtime works standalone.
- Keep PI's wire discriminator values (`type: "toolCall"`, `role`, `stopReason`) so shapes stay recognizable; snake_case the field names.

## Ground-Truth Core roadmap (`src/minima_harness/goals_and_scope.md`)

A **design/plan, largely not-yet-shipped** — the "Ground-Truth Core" (task #84, design v2, 2026-07-04): make one embedded SQLite ledger (`~/.minima-harness/minima.db`) the single source of truth for what an agent is doing (plans, tasks, quality gates, repo policy, file diffs), where **every ledger row is also a Mubit feedback feature**. Milestone ladder GT-0.5 → GT-8 with a dependency DAG.

**Where it lands:** the client-side work targets the **TypeScript harness `packages/tui/`** (the files it cites — `src/db/minima_db.ts`, `src/agent/agent.ts`, `src/tui/app.tsx`, `src/minima/budget.ts`, `src/tools/todowrite.ts` — all exist there); the Python `src/minima_harness` is cited only as the *reference port* (e.g. its per-prompt re-anchor pattern). The server-side work is additive changes to `src/minima`.

**Current state (as of this writing) — the GT ladder has NOT started:**
- `packages/tui/src/db/minima_db.ts` is at **migration v2** (v1 = core spine `projects/runs/events/routing_decisions/tool_calls`; v2 = `budgets/budget_events` + feedback-provenance ALTERs). GT-0 appends the **v3** batch (`plans/tasks/task_events/…`) — migrations are **append-only**, so v3 shapes need the §13.1 schema sign-off before they land; never edit shipped batch strings.
- `todowrite` (the ephemeral per-instance closure GT-1 replaces) is still registered in `src/tools/builtin.ts`; no `PlanLedger`, no plan/gate tools, no plan/ledger tests yet.
- The three agent hooks (`beforeToolCall`/`afterToolCall`/`shouldStopAfterTurn` in `src/agent/agent.ts`) are still **single slots**; GT-0 turns them into ordered stacks.
- `tool_execution_start` (`src/tui/app.tsx`) currently only flips busy state; the GT-0.5 "current action line" (render `toolName`/`args`) is still open.
- `src/minima/budget.ts` `BudgetLedger` is the structural template the doc says `PlanLedger` should mirror (upsert scope row + append-only `*_events` + `tx.immediate()` guarded writes + `logEventSafe` fail-open).

**Suggested first implementation:** GT-0.5 (visibility quick-wins, no schema) → GT-0 (v3 migration + `minima/plan_ledger.ts` modeled on `BudgetLedger` + hook-stack refactor + hardcoded DB-path self-protection deny) → GT-1 (plan tools + per-prompt re-anchor + reconciler, retiring `todowrite`).

The **server-side** parts in `src/minima` (milestone GT-7) are strictly additive and capability-gated (`GET /v1/capabilities` echoes `feedback_extras: true` — endpoint does not exist yet): optional `FeedbackRequest` fields (`attempts`, `tool_calls_total`, `tool_calls_failed`, `thinking_tokens`, `plan_changes`, `user_signal`, `gate_passed`, `gate_origin`, `gate_two_sided`, `task_type`, `task_id`) folded into `OutcomeRecord.extra` (note: `extra` is written into metadata but `from_metadata` does **not** repopulate it today, so it isn't recallable yet); actually parsing `req.notes` (currently dropped); and deciding the `iterations` consumer (cost/score path only, never success-mass). Wire mirroring: Python `src/minima/schemas/` is the source of truth and every field must also land in `packages/tui/src/minima/schemas.ts`.

Design principles and invariants that constrain any work in this direction (and are good context even for server-only changes):

- **State in the DB, projections in the context** — anything that must survive scroll/compaction/restart/a lying model lives in the ledger; the model sees only a compact re-injected projection.
- **Enforcement in the dispatcher, guidance in the prompt** — plan/permission/gate guarantees are enforced by harness code at tool-dispatch or turn boundaries, never by prompt text (which is bypassable). "for gods sake not md files."
- **Every work unit emits a routing observation** — a task+gate yields `(task_type, model, cost, tokens, attempts, tool failures, turns, gate outcome)`; gate verdicts are objective **outcome labels**, never a fabricated `quality_score`.
- **Feedback truth** — realized rung-total usage; no fabricated quality (gate verdict → outcome label only; judge abstention stays `null`); `verified_in_production` only from user/repo/ci-origin gates, never agent-authored ones.
- **Recommend-only server stands** — plan state is never server-authoritative; a future `POST /v1/plan` only *proposes* a draft the local ledger owns.
- **Append-only migrations** (per-milestone batches; shipped batch strings never edited) · **`rec_id` discipline** as the sole local↔server↔Mubit join key · **propensity integrity** (no client-side re-ranking; pins are pre-request candidate assembly with logged mixture propensities, never post-hoc overrides) · **wire mirroring** (Python `schemas/` is the source of truth; every field must land in both the Python schema and its TS mirror).

## Entry points (`pyproject.toml [project.scripts]`)

`minima-seed` (cold-start seeding) · `minima-calibration-report` · `minima-harness` (the TUI). Server app: `minima.main:app`.

## Docs

Deep docs live in `docs/` (concepts, api-reference, configuration, harness, multi-tenancy, operations, seeding). All service config is via environment variables — see `.env.example` and `docs/configuration.md`; the only required value (single-tenant mode) is `MUBIT_API_KEY`.
