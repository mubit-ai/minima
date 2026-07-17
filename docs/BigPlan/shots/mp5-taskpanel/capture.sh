#!/bin/bash
# MP5 (MUB-148) D3a task-panel evidence: visible (mid-run todos) / hidden (Ctrl+B) /
# restart-hidden (persisted override, same prefs dir). Self-contained (starts its own mock).
# Usage: bash docs/BigPlan/shots/mp5-taskpanel/capture.sh
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
TUI=$ROOT/packages/tui
OUT=$ROOT/docs/BigPlan/shots/mp5-taskpanel
PORT=${MP5_MOCK_PORT:-8457}
SCRATCH=$(mktemp -d /tmp/mp5-tasks.XXXXXX)
MOCK_PID=""
trap '[ -n "$MOCK_PID" ] && { kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null || true; }; rm -rf "$SCRATCH"' EXIT

MOCK_PORT=$PORT bun "$TUI/scripts/mock_openai_sse.ts" > "$SCRATCH/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null || { echo "mock failed"; cat "$SCRATCH/mock.log"; exit 1; }

INLINE='["bun","run","'$TUI'/src/cli/main.ts","--offline","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:'$PORT'/v1"]'

shot() {
  local name=$1 prefs=$2 spec=$3
  mkdir -p "$SCRATCH/home-$name"
  HOME=$SCRATCH/home-$name MINIMA_DB_PATH=$SCRATCH/$name.db MINIMA_HARNESS_DIR=$SCRATCH/$prefs \
    uv run --with pyte --with pillow python "$TUI/scripts/pty_capture.py" "$spec" | tail -1
}

shot visible prefs-visible '{"cmd":'$INLINE',"cwd":"'$ROOT'","cols":120,"rows":36,"duration":11,
  "steps":[{"after":3.0,"send":"TODO plan this work"},{"after":4.5,"send":"<CR>"},
           {"after":8.0,"send":"a"}],
  "png":"'$OUT'/mp5-visible.png"}'

shot hidden prefs-persist '{"cmd":'$INLINE',"cwd":"'$ROOT'","cols":120,"rows":36,"duration":12.5,
  "steps":[{"after":3.0,"send":"TODO plan this work"},{"after":4.5,"send":"<CR>"},
           {"after":8.0,"send":"a"},{"after":11.2,"send":"<CTRLB>"}],
  "png":"'$OUT'/mp5-hidden.png"}'

shot restart prefs-persist '{"cmd":'$INLINE',"cwd":"'$ROOT'","cols":120,"rows":36,"duration":11,
  "steps":[{"after":3.0,"send":"TODO plan this work"},{"after":4.5,"send":"<CR>"},
           {"after":8.0,"send":"a"}],
  "png":"'$OUT'/mp5-restart-hidden.png"}'

echo "== mp5-taskpanel shots -> $OUT =="
