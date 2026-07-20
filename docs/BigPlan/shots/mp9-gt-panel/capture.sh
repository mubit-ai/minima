#!/bin/bash
# MP9 (MUB-152) D3b GT-view evidence: gate-wins-the-chord / overview / step card.
# Usage: bash docs/BigPlan/shots/mp9-gt-panel/capture.sh
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
TUI=$ROOT/packages/tui
OUT=$ROOT/docs/BigPlan/shots/mp9-gt-panel
PORT=${MP9_MOCK_PORT:-8468}
SCRATCH=$(mktemp -d /tmp/mp9-gt.XXXXXX)
MOCK_PID=""
trap '[ -n "$MOCK_PID" ] && { kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null || true; }; rm -rf "$SCRATCH"' EXIT

MOCK_PORT=$PORT bun "$TUI/scripts/mock_openai_sse.ts" > "$SCRATCH/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null || { echo "mock failed"; cat "$SCRATCH/mock.log"; exit 1; }

INLINE='["bun","run","'$TUI'/src/cli/main.ts","--offline","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:'$PORT'/v1"]'

shot() {
  local name=$1 spec=$2
  mkdir -p "$SCRATCH/home-$name"
  HOME=$SCRATCH/home-$name MINIMA_DB_PATH=$SCRATCH/$name.db MINIMA_HARNESS_DIR=$SCRATCH/prefs-$name \
  MINIMA_TUI_GROUND_TRUTH=1 \
    uv run --with pyte --with pillow python "$TUI/scripts/pty_capture.py" "$spec" | tail -1
}

shot gatewins '{"cmd":'$INLINE',"cwd":"'$ROOT'","cols":120,"rows":36,"duration":8,
  "steps":[{"after":3.0,"send":"/gt-seed"},{"after":4.5,"send":"<CR>"},
           {"after":6.0,"send":"<CTRLG>"}],
  "png":"'$OUT'/mp9-gate-wins.png"}'

shot overview '{"cmd":'$INLINE',"cwd":"'$ROOT'","cols":120,"rows":36,"duration":10,
  "steps":[{"after":3.0,"send":"/gt-seed"},{"after":4.5,"send":"<CR>"},
           {"after":6.0,"send":"a"},{"after":7.5,"send":"<CTRLG>"}],
  "png":"'$OUT'/mp9-overview.png"}'

shot card '{"cmd":'$INLINE',"cwd":"'$ROOT'","cols":120,"rows":36,"duration":11,
  "steps":[{"after":3.0,"send":"/gt-seed"},{"after":4.5,"send":"<CR>"},
           {"after":6.0,"send":"a"},{"after":7.5,"send":"<CTRLG>"},
           {"after":9.0,"send":"<CR>"}],
  "png":"'$OUT'/mp9-step-card.png"}'

echo "== mp9-gt-panel shots -> $OUT =="
