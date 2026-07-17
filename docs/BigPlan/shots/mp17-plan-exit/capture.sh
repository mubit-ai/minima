#!/bin/bash
# MP17 (MUB-160) universal plan-exit gate, GT OFF: the mock's EXITPLAN marker drives a real
# exit_plan(plan) tool call — the plan markdown lands in the transcript, the 3-option
# overlay approves into build; the second half shows the Shift+Tab gate (Esc stays, Cancel
# discards). Hermetic: mock provider on 127.0.0.1, isolated HOME/db/prefs, scratch cwd.
# Usage: bash docs/BigPlan/shots/mp17-plan-exit/capture.sh
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
TUI=$ROOT/packages/tui
OUT=$ROOT/docs/BigPlan/shots/mp17-plan-exit
PORT=${MP17_MOCK_PORT:-8478}
SCRATCH=$(mktemp -d /tmp/mp17-exit.XXXXXX)
MOCK_PID=""
trap '[ -n "$MOCK_PID" ] && { kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null || true; }; rm -rf "$SCRATCH"' EXIT

MOCK_PORT=$PORT bun "$TUI/scripts/mock_openai_sse.ts" > "$SCRATCH/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null || { echo "mock failed"; cat "$SCRATCH/mock.log"; exit 1; }

ARGV_BASE='"bun","run","'$TUI'/src/cli/main.ts","--offline","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:'$PORT'/v1"'

shot() {
  local name=$1 duration=$2 steps=$3
  rm -f "$SCRATCH/$name.db" "$SCRATCH/$name.db-wal" "$SCRATCH/$name.db-shm"
  mkdir -p "$SCRATCH/home-$name"
  local spec='{"cmd":['$ARGV_BASE'],"cwd":"'$SCRATCH'","cols":120,"rows":36,"duration":'$duration',
    "steps":'$steps',
    "png":"'$OUT'/'$name'.png"}'
  HOME=$SCRATCH/home-$name MINIMA_DB_PATH=$SCRATCH/$name.db MINIMA_HARNESS_DIR=$SCRATCH/prefs-$name \
    uv run --with pyte --with pillow python "$TUI/scripts/pty_capture.py" "$spec" > "$OUT/$name.txt"
  tail -1 "$OUT/$name.txt"
}

shot gate-overlay 8 '[{"after":2.0,"send":"<SHIFTTAB>"},{"after":2.4,"send":"<SHIFTTAB>"},{"after":3.0,"send":"EXITPLAN draft the sandbox cleanup plan"},{"after":3.8,"send":"<CR>"}]'
shot approved 11 '[{"after":2.0,"send":"<SHIFTTAB>"},{"after":2.4,"send":"<SHIFTTAB>"},{"after":3.0,"send":"EXITPLAN draft the sandbox cleanup plan"},{"after":3.8,"send":"<CR>"},{"after":7.0,"send":"<CR>"}]'
shot shifttab-gate 16 '[{"after":2.0,"send":"<SHIFTTAB>"},{"after":2.4,"send":"<SHIFTTAB>"},{"after":3.0,"send":"EXITPLAN draft it"},{"after":3.8,"send":"<CR>"},{"after":7.0,"send":"<CR>"},{"after":9.0,"send":"<SHIFTTAB>"},{"after":9.4,"send":"<SHIFTTAB>"},{"after":10.0,"send":"EXITPLAN once more"},{"after":10.8,"send":"<CR>"},{"after":14.5,"send":"<SHIFTTAB>"}]'

echo "== mp17-plan-exit shots -> $OUT =="
