.PHONY: install run test lint fmt live eval seed refresh-catalog verify-venv tui-install tui-test tui-check tui-build tui tui-dev tui-shot

install:
	uv sync --extra dev   # dev pulls server + reasoner extras for the full test suite

run:
	uv run --extra server uvicorn minima.main:app --reload --host $${MINIMA_HOST:-0.0.0.0} --port $${MINIMA_PORT:-8080}

test: verify-venv
	uv run pytest -m "not live and not eval" -q

verify-venv:
	uv run python scripts/verify_venv_integrity.py

lint:
	uv run ruff check src client_sdk tests
	uv run mypy src/minima

fmt:
	uv run ruff check --fix src client_sdk tests
	uv run ruff format src client_sdk tests

live:
	uv run pytest -m live -q

eval:
	uv run pytest -m eval -q

seed:
	uv run minima-seed --limit $${LIMIT:-2000} --lane $${LANE:-minima:default}

# --- TS TUI (packages/tui) — run from the repo root so .env.harness auto-loads --------

TUI := packages/tui
TUI_BIN := $(TUI)/dist/minima
# Default PTY-capture spec: idle interactive UI at 100x30, run from the repo root so .env loads.
# Emits a PNG to the gitignored playground/ so the rendered UI can be inspected as an image.
SPEC ?= {"cmd":["bun","run","$(TUI)/src/cli/main.ts","--offline"],"cwd":"$(CURDIR)","cols":100,"rows":30,"duration":6,"png":"$(CURDIR)/playground/tui-shot.png"}

tui-install:
	cd $(TUI) && bun install

tui-test:
	cd $(TUI) && bun test

tui-check:
	cd $(TUI) && bun run check && bun run lint

tui-build:
	cd $(TUI) && bun run build

# Run the compiled binary (build first with `make tui-build`). Passes ARGS through, so:
#   make tui ARGS='-p "hello"'          # one-shot
#   make tui ARGS='--offline --model gpt-4o-mini -p "hi"'
#   make tui                             # interactive TUI
tui:
	@test -x $(TUI_BIN) || { echo "Run 'make tui-build' first"; exit 1; }
	./$(TUI_BIN) $(ARGS)

# Run from source via Bun (no compile step) — fastest dev loop.
tui-dev:
	cd $(TUI) && bun run src/cli/main.ts $(ARGS)

# Capture a text "screenshot" of the TUI in a real PTY (pyte emulator). No committed venv — uv pulls
# pyte on demand. Override SPEC to size the terminal / send keystrokes; see the script's docstring:
#   make tui-shot
#   make tui-shot SPEC='{"cmd":["bun","run","packages/tui/src/cli/main.ts","--offline","--model","claude-haiku-4-5","--provider","anthropic"],"cwd":"'"$$PWD"'","cols":80,"rows":24,"duration":8,"steps":[{"after":2,"send":"hi<CR>"}]}'
tui-shot:
	@mkdir -p $(CURDIR)/playground
	uv run --with pyte --with pillow python $(TUI)/scripts/pty_capture.py '$(SPEC)'

# PTY invariants for the INLINE renderer (the only renderer): prompt-echo latency,
# zero scrollback wipes during streams, no alt-screen/mouse-capture sequences, clean
# Ctrl+D exit, render perf budgets (pty_capture.py + tui_assert.py + MINIMA_TUI_PERF).
tui-verify:
	bash $(TUI)/scripts/tui_verify.sh
