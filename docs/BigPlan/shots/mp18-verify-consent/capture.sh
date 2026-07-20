#!/bin/bash
# MP18 (MUB-161) verify-command consent: the mock's TODOV/TODOVSWAP markers drive the
# consent lifecycle — first run prompts with the command verbatim, allow-always + the same
# verify stays silent, a MUTATED verify re-prompts. Stop-strikes are disabled (an armed
# in_progress step otherwise spirals the plan-not-done nag through the scripted sends).
# Usage: bash docs/BigPlan/shots/mp18-verify-consent/capture.sh
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
TUI=$ROOT/packages/tui
OUT=$ROOT/docs/BigPlan/shots/mp18-verify-consent
PORT=${MP18_MOCK_PORT:-8488}
SCRATCH=$(mktemp -d /tmp/mp18-consent.XXXXXX)
MOCK_PID=""
trap '[ -n "$MOCK_PID" ] && { kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null || true; }; rm -rf "$SCRATCH"' EXIT

MOCK_PORT=$PORT bun "$TUI/scripts/mock_openai_sse.ts" > "$SCRATCH/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null || { echo "mock failed"; cat "$SCRATCH/mock.log"; exit 1; }

ARGV_BASE='"bun","run","'$TUI'/src/cli/main.ts","--offline","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:'$PORT'/v1"'
ENVV='"MINIMA_TUI_GROUND_TRUTH":"1","MINIMA_TUI_STOP_STRIKES":"0"'

shot() {
  local name=$1 duration=$2 steps=$3
  rm -f "$SCRATCH/$name.db" "$SCRATCH/$name.db-wal" "$SCRATCH/$name.db-shm"
  mkdir -p "$SCRATCH/home-$name"
  local spec='{"cmd":['$ARGV_BASE'],"cwd":"'$SCRATCH'","cols":120,"rows":36,"duration":'$duration',
    "env":{'$ENVV'},
    "steps":'$steps',
    "png":"'$OUT'/'$name'.png"}'
  HOME=$SCRATCH/home-$name MINIMA_DB_PATH=$SCRATCH/$name.db MINIMA_HARNESS_DIR=$SCRATCH/prefs-$name \
    uv run --with pyte --with pillow python "$TUI/scripts/pty_capture.py" "$spec" > "$OUT/$name.txt"
  tail -1 "$OUT/$name.txt"
}

shot first-prompt 7 '[{"after":2.0,"send":"TODOV record the demo step"},{"after":2.8,"send":"<CR>"}]'
shot silent-repeat 13 '[{"after":2.0,"send":"TODOV record the demo step"},{"after":2.8,"send":"<CR>"},{"after":6.0,"send":"a"},{"after":8.5,"send":"TODOV record the demo step once more"},{"after":9.3,"send":"<CR>"}]'
shot mutated-reprompt 17 '[{"after":2.0,"send":"TODOV record the demo step"},{"after":2.8,"send":"<CR>"},{"after":6.0,"send":"a"},{"after":8.5,"send":"TODOVSWAP mutate the verify now"},{"after":9.3,"send":"<CR>"}]'

echo "== mp18-verify-consent shots -> $OUT =="
