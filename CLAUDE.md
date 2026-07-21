# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Python service + client SDK, and a separate TypeScript harness:

- **`src/minima/`** — Minima: a **recommend-only** LLM cost-optimization service (FastAPI, Python 3.11+). It never proxies, runs, or caches an LLM call. It answers "which model should I run for this task?" and learns from the outcome you report back. Memory is backed by [Mubit](https://docs.mubit.ai) and is the *only* external dependency of the core recommender. Hosted at `api.minima.sh`; deployed from GitHub releases (publishing a release triggers the prod deploy AND the CLI binary build).
- **`client_sdk/minima_client/`** — bundled sync + async Python client. Ships in the same wheel as `src/minima` (`minima-cli` on PyPI).
- **`packages/tui/`** — `minima-tui`: the **active harness** — a TypeScript/Ink agent runtime + TUI run on **Bun** (`bun:sqlite`, `>=1.2`). This is the `minima` CLI users install via Homebrew (`brew tap mubit-ai/minima`). Same `route → run → judge → feedback` loop against the `/v1/*` contract, with its own SQLite persistence spine (`src/db/minima_db.ts`, event-sourced, WAL, append-only migrations) and a `BudgetLedger`. Separate toolchain — not part of the Python wheel or `uv`. The version of record is `packages/tui/package.json` (kept in lockstep with `pyproject.toml` and `packages/sdk/package.json`).
- **`packages/sdk/`** — `@mubit-ai/minima-sdk`: the standalone **TypeScript SDK** — a pure-fetch typed `/v1/*` client (no runtime deps, no Bun APIs), mirroring `client_sdk/minima_client`. Own Bun toolchain for tests/typecheck; its `src/schemas.ts` is a second copy of the wire mirror, pinned by `tests/unit/test_ts_mirror.py`.

### The Minima loop (respect this everywhere)

```
recommend  ->  run the model yourself  ->  judge quality  ->  feedback
```

Minima never runs the model. Feedback MUST carry realized `input_tokens` / `output_tokens` / `actual_cost_usd` / `latency_ms` so the cost basis can climb `estimate -> observed -> rescaled` — the single biggest accuracy lever. Do **not** echo Minima's own `est_cost_usd` back as the actual cost. Outcome thresholds: `success >= 0.8`, `partial >= 0.4`, else `failure`.

## Commands

`uv` is the package manager for the Python side. Common targets (see `Makefile`):

```bash
make install     # uv sync --extra dev
make run         # local Minima on :8080 (uvicorn, --reload); interactive docs at /docs
make test        # unit + integration, hermetic/offline: pytest -m "not live and not eval"
make lint        # ruff check + mypy src/minima
make fmt         # ruff check --fix + ruff format
make live        # pytest -m live  — needs a running Mubit (make run-mubit in the Mubit repo)
make eval        # pytest -m eval  — slow offline RouterBench savings evaluation
make seed        # minima-seed (LIMIT=, LANE= overridable) — load cold-start memory
uv run pytest tests/unit/test_foo.py::test_bar   # single test
```

Test markers (`pyproject.toml`): `live` = requires a running Mubit; `eval` = slow offline RouterBench. Default `make test`/`pytest` excludes both.

The **TypeScript harness** (`packages/tui/`) has its own Bun toolchain (also exposed as `make tui-*` targets):

```bash
cd packages/tui && bun install
bun test          # hermetic (mock fetch + faux provider + in-process mock service)
bun run check     # tsc --noEmit
bun run lint      # biome check src
bun run format    # biome format --write src
bun run build     # -> dist/minima native binary (bun build --compile)
```

## Testing constraints (important)

- **Offline tests MUST stay hermetic.** `tests/conftest.py` has an autouse fixture that neutralizes `.env` — never rely on ambient credentials in a non-`live` test.
- For service tests: `tests/factories.py:FakeMemory` + `create_app(...)` + `TestClient` gives a full in-process app with no Mubit.
- For TUI tests: register a faux provider/model and mock `fetch` — see existing `packages/tui/tests/*.test.ts` for the pattern. No test may hit the network or spend money.
- **Never hand-patch site-packages.** `make test` (and CI) first runs `scripts/verify_venv_integrity.py`, which re-hashes every installed file against its wheel RECORD and fails on any mismatch — a patched venv once let the whole suite vouch for an SDK method no release has. To try an SDK change, use a local editable install or a pinned fork, then `uv sync --reinstall` to restore.

## Conventions

Python (`src/minima`):

- `from __future__ import annotations` at the top of every module.
- Pydantic v2 `BaseModel` for serializable schemas; `@dataclass(slots=True)` for internal types; `StrEnum` for enums; `Protocol` for seams (`Memory`, `QualityJudge`).
- Async-first. Bridge sync SDKs (Mubit) off the event loop via `anyio`/threadpools.
- Logging: `structlog` via `get_logger("minima.<sub>")`.
- ruff `line-length=100`, target `py311`, lint set `E,F,I,UP,B,C4`. **Never break the hot path**: bookkeeping/feedback failures are logged-and-swallowed.

TypeScript (`packages/tui`): biome for lint/format, strict tsc, Bun APIs (`bun:sqlite`, `Bun.write`) are fine. **Do NOT add the `openai` SDK** — the OpenAI-compatible provider speaks raw HTTP. Routing must stay bypassable (offline/no-Minima still works, with no feedback sent).

- **No comments unless asked.** Match existing style.

## Architecture — the service (`src/minima/`)

Request flow (`api/routers/recommend.py` → `recommender/engine.py`):

1. **classify** (`recommender/classify.py`) — derives task features/type from the prompt (regex + signal tables).
2. **recall** (`memory/adapter.py`) — the *only* Mubit touchpoint; pulls similar past `task → model → outcome` records using Mubit's server-side embeddings (no local embedding model).
3. **aggregate + score** (`recommender/aggregate.py`, `score.py`) — ranks candidates by *real* cost. The cost basis is one of three tiers chosen for the whole candidate set: `estimate` (catalog prices, cold start) → `observed` (median realized $/call) → `rescaled` (this request's input priced + observed output behavior).
4. **escalation** (`recommender/escalation.py`) — DIAGNOSTIC only: thin/conflicting/tied evidence is surfaced as `escalation_suggested:*` warnings + decision-log reasons. The harness owns the cascade (its recovery ladder re-decides after a VERIFIED failure); the old pre-decision LLM reasoner was deleted.
5. **feedback** (`api/routers/feedback.py`) — writes the outcome back to Mubit, reinforcing memory.

Other packages: `catalog/` (model cost + capability priors), `tenancy/` (multi-tenant runtime — many orgs, per-org Mubit, one deployment; auth is pass-through: the client's Mubit key IS the credential), `seeding/` (`minima-seed` CLI for cold-start history), `schemas/` (Pydantic request/response models — the wire source of truth; every field must also land in BOTH TS mirrors: `packages/tui/src/minima/schemas.ts` and `packages/sdk/src/schemas.ts`).

Everything external is behind a Protocol so it can be faked in tests. The server stack (fastapi/uvicorn/psycopg2/redis) lives in the `[server]` extra — the core recommender + client is dependency-light on purpose.

## Architecture — the harness (`packages/tui/`)

`MinimaAgent.promptRouted(task)` = **route** (`src/minima/router.ts` → `POST /v1/recommend`) → **run** (agent loop in `src/agent/`, streams the model, executes tools, before/afterToolCall hook stacks, abort via AbortSignal) → **judge** (`src/minima/judge.ts`, abstains unless `MINIMA_LLM_JUDGE=1`) → **feed back** (`POST /v1/feedback` with realized cost). Layers: `src/ai/` (multi-provider LLM API + `faux` test provider) · `src/agent/` (loop, tools, hooks) · `src/minima/` (router, runtime, meter, budget, spawn/sub-agents, ground truth) · `src/tools/` (bash/edit/read/write/grep/todowrite/websearch…) · `src/tui/` (Ink app) · `src/db/` (SQLite spine).

**Ground-Truth verification spine** (shipped 2026-07, `docs/ground-truth-build-guide.md`): **ON by default** since Phase 0b (opt out with `MINIMA_TUI_GROUND_TRUTH=0`). Plan steps carry `verify` shell commands, the harness runs them (baseline → done-gate red→green), verdicts land in the `gates` ledger (migrations v3–v5), a confidence tier drives the UI (🟢 glide / 🟡 flag / 🔴 stop), and grounded outcomes stamp `routing_decisions` for deterministic-over-judge feedback. Green-tier gate verdicts are the harness's honest label source (`evidence_source="gate"` — the only origin that may claim verified-in-production); a sampled LLM judge (`MINIMA_JUDGE_SAMPLE`, default 15% of ungated turns; `MINIMA_JUDGE_SAMPLE=0` disables, `MINIMA_LLM_JUDGE=1` forces every turn) labels the rest; everything else is cost/latency telemetry. `/plan` (planner persona + design council + `GROUND_TRUTH.md` output) is part of this spine. Anything gated on ground truth belongs behind `config.groundTruth`, never behind prompt text.

**Memory ledger** (Track B of the memory spine, default ON; opt out with `MINIMA_TUI_MEMORY=0`): curated cross-session memory in SQLite (`memories`/`memory_events`/`memory_jobs`, migration v12). Active + pinned rows project into each turn's system prompt for the lead agent only (hard char cap, ranked pinned > gate-cited > recency; every distinct injected set is audited as an `inject` memory_event so "what the model saw" is replayable). Managed via `/memory` (list · add · pin/confirm/reject · delete = bi-temporal invalidate, never DELETE). Only the harness/user writes memories — the model has **no memory-write tool** (Letta split); keep it that way. The **scribe** (`src/minima/memory_scribe.ts`) is the sole automated writer: a background curator fed by SQL over the ledger (gate flips, verified failures, user corrections, judge/gate disagreements — never the transcript), recurrence-gated (a pattern must recur before it earns the one LLM extraction call, which routes through Minima with `tags=["memory:extract"]` and books its spend like judge spend), reconciled mem0-style (ADD/UPDATE/NOOP; rejected rows never resurrected), and provenance-gated (only gate-cited candidates auto-activate; the rest await `/memory confirm`). Triggers (session end, 90s quiet timer, startup leftovers) only enqueue `memory_jobs` rows; a crash-safe drain runs them.

**Verification extras** (E1): the **Planning Critic** (`src/minima/plan_critic.ts`, `MINIMA_TUI_PLAN_CRITIC=0` opts out) runs one cheap completion at `/plan` finalize over the approved steps + verifies — non-discriminative checks and hidden dependencies come back as advisory flags in the finalize note, never blockers. The **zero-context diff reviewer** (`src/minima/diff_review.ts`, `MINIMA_TUI_DIFF_REVIEW=0` opts out) fires when a plan closes fully completed: fresh-eyes review of the run's whole diff, no session context; an objection writes a yellow judge milestone gate (worst-tier resolution can yellow the plan, never green it; approval/skip writes nothing). Distinct from `/verify`'s refutation pass, which is ledger-briefed and re-runs checks.

Design principles that constrain any work in this direction:

- **State in the DB, projections in the context** — anything that must survive scroll/compaction/restart/a lying model lives in the ledger; the model sees only a compact re-injected projection.
- **Enforcement in the dispatcher, guidance in the prompt** — plan/permission/gate guarantees are enforced by harness code at tool-dispatch or turn boundaries, never by prompt text (which is bypassable).
- **Feedback truth** — realized usage only; no fabricated quality (gate verdict → outcome label only; judge abstention stays `null`); `verified_in_production` only from user/repo/ci-origin gates, never agent-authored ones.
- **Recommend-only server stands** — plan state is never server-authoritative.
- **Append-only migrations** (shipped batch strings never edited) · **`rec_id` discipline** as the sole local↔server↔Mubit join key · **propensity integrity** (no client-side re-ranking; pins are pre-request candidate assembly, never post-hoc overrides).

## Entry points

Python (`pyproject.toml [project.scripts]`): `minima-seed` · `minima-calibration-report`. Server app: `minima.main:app`. The `minima` CLI/TUI is NOT a Python entry point — it is the compiled Bun binary from `packages/tui`, distributed via Homebrew.

## Docs

Deep docs live in `docs/` (concepts, api-reference, configuration, multi-tenancy, operations, seeding, ground-truth-build-guide). All service config is via environment variables — see `.env.example` and `docs/configuration.md`; the only required value (single-tenant mode) is `MUBIT_API_KEY`. Never commit `.env`/`.env.harness`; never print secret values.
