# minima-tui

The TypeScript/Ink harness + TUI for **Minima** — a cost-aware model-routing coding
agent. This package is the runtime that lives in your terminal; it talks to the Python
FastAPI recommender service (`src/minima/`) over the `/v1/*` HTTP contract and never
proxies LLM calls itself.

```
recommend  ->  run the model yourself  ->  judge quality  ->  feedback
```

## What's here

A faithful port of `src/minima_harness/` (Python) → TypeScript:

- **`src/minima/`** — typed async client for the recommender service (every `/v1/*`
  endpoint) + the integration layer (`config`, `mapping`, `meter`, `judge`, `router`,
  `MinimaAgent` route→run→judge→feedback loop).
- **`src/ai/`** — the LLM layer: types, streaming, provider registry, and three real
  providers — `openai-compat` (raw `fetch` SSE), `anthropic` (`@anthropic-ai/sdk`),
  `google` (`@google/genai`) — plus a hermetic `faux` provider for tests.
- **`src/agent/`** — the agent core: PI event taxonomy, `agentLoop` (parallel tool
  execution, before/afterToolCall hooks, max_turns, steering), and the `Agent` class.
- **`src/tools/`** — `read`/`write`/`edit`/`bash`/`ls` + an `objectSchema` helper.
- **`src/tui/`** — the Ink app (conversation + status bar + model picker) and the
  credential store (OS keychain via `keytar`, else a 0600 file).
- **`src/session/`** — append-only JSONL session tree + `SessionManager`.
- **`src/cli/main.ts`** — the `minima` entry point (`--print`, `--mode json`, interactive
  TUI, `minima config`).

## Develop

```bash
cd packages/tui
bun install
bun test          # 75 hermetic tests
bun run check     # tsc --noEmit
bun run lint      # biome
bun run build     # -> dist/minima (a self-contained native binary)
./dist/minima --help
```

Tests are fully hermetic: the client injects a mock `fetch`, the faux provider scripts
LLM replies, and the Minima integration runs the full loop against an in-process mock
service — no network, no keys.

## Use

```bash
# set credentials (keychain, else ~/.minima-harness/config.env at 0600)
minima config set MUBIT_API_KEY ...
minima config set OPENAI_API_KEY ...

# one-shot
minima -p "explain this repo"

# event stream for scripts
minima --mode json "refactor foo" | jq .

# interactive TUI
minima
```

Routing auth (`MUBIT_API_KEY`) + one provider key is enough to start. `--offline`
bypasses the recommender; `--model`/`--provider` pin a model and skip routing.

## Status

Phases 0–7 complete: scaffold → client → AI layer (3 providers) → agent core → tools →
Minima integration → Ink TUI + CLI → compiled native binary (`bun build --compile`).
Remaining for full parity with the Python TUI: the rest of the overlays (session picker,
diff-approval gating, themes, goals), mouse capture, and `keytar`-bundled keychain in the
compiled binary (it falls back to the file store today).
