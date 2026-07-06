# minima-tui

The TypeScript/Ink harness + TUI for **Minima** — a cost-aware model-routing coding
agent. This package is the runtime that lives in your terminal; it talks to the Python
FastAPI recommender service (`src/minima/`) over the `/v1/*` HTTP contract and never
proxies LLM calls itself.

```
recommend  ->  run the model yourself  ->  judge quality  ->  feedback
```

## What's here

A faithful TypeScript port of the original Python harness (removed from the repo in v0.7.0):

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

### Screenshot the TUI

To inspect the layout as a "screenshot", drive the TUI in a real PTY with `scripts/pty_capture.py`
(pyte emulator; no committed venv — `uv` pulls pyte/pillow on demand):

```bash
# from the repo root (so .env / .env.harness load):
make tui-shot                                  # idle UI at 100x30 -> playground/tui-shot.png
make tui-shot SPEC='{"cmd":["bun","run","packages/tui/src/cli/main.ts","--offline","--model","claude-haiku-4-5","--provider","anthropic"],"cwd":"'"$PWD"'","cols":80,"rows":24,"duration":8,"png":"'"$PWD"'/playground/shot.png","steps":[{"after":4,"send":"hi"},{"after":6,"send":"<CR>"}]}'
```

It prints the visible grid plus the **scrollback** (lines that scrolled off the top), and — when the
spec has a `"png"` key — rasterizes the visible grid (colors/bold, Menlo font) to a **PNG image** you
can open. Verifies "prompt at the bottom / clean render / scroll"; true wheel/trackpad scrolling is a
real-terminal, human check. Tips: give Ink ~4s to warm up and send the prompt text and `<CR>` as
separate `steps`. See the script's docstring for the full JSON spec and send-tokens
(`<CR> <UP> <PGUP> <CTRLC> …`).

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
