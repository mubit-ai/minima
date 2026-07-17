#!/bin/bash
# MP7 (MUB-150) D3b ToC panel evidence: open over a 500-msg resume / G to the last
# section / closed with the draft intact. Self-contained (starts its own mock).
# Usage: bash docs/BigPlan/shots/mp7-expand-panel/capture.sh
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
TUI=$ROOT/packages/tui
OUT=$ROOT/docs/BigPlan/shots/mp7-expand-panel
PORT=${MP7_MOCK_PORT:-8463}
SCRATCH=$(mktemp -d /tmp/mp7-toc.XXXXXX)
MOCK_PID=""
trap '[ -n "$MOCK_PID" ] && { kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null || true; }; rm -rf "$SCRATCH"' EXIT

MOCK_PORT=$PORT bun "$TUI/scripts/mock_openai_sse.ts" > "$SCRATCH/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null || { echo "mock failed"; cat "$SCRATCH/mock.log"; exit 1; }

RESUME='["bun","run","'$TUI'/src/cli/main.ts","--offline","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:'$PORT'/v1","--resume","fixture-500"]'

shot() {
  local name=$1 spec=$2
  rm -f "$SCRATCH/$name.db" "$SCRATCH/$name.db-wal" "$SCRATCH/$name.db-shm"
  bun run "$TUI/scripts/gen-fixture-session.ts" --db "$SCRATCH/$name.db" \
    --messages 500 --name fixture-500 > /dev/null
  mkdir -p "$SCRATCH/home-$name"
  HOME=$SCRATCH/home-$name MINIMA_DB_PATH=$SCRATCH/$name.db MINIMA_HARNESS_DIR=$SCRATCH/prefs-$name \
    uv run --with pyte --with pillow python "$TUI/scripts/pty_capture.py" "$spec" | tail -1
}

shot open '{"cmd":'$RESUME',"cwd":"'$ROOT'","cols":120,"rows":36,"duration":6,
  "steps":[{"after":3.5,"send":"<CTRLT>"}],
  "png":"'$OUT'/mp7-toc-open.png"}'

shot bottom '{"cmd":'$RESUME',"cwd":"'$ROOT'","cols":120,"rows":36,"duration":7,
  "steps":[{"after":3.5,"send":"<CTRLT>"},{"after":5.0,"send":"G"}],
  "png":"'$OUT'/mp7-toc-bottom.png"}'

shot draft '{"cmd":'$RESUME',"cwd":"'$ROOT'","cols":120,"rows":36,"duration":8.5,
  "steps":[{"after":3.5,"send":"draft123"},{"after":4.2,"send":"<CTRLT>"},
           {"after":5.5,"send":"G"},{"after":6.5,"send":"<ESC>"}],
  "png":"'$OUT'/mp7-closed-draft.png"}'

echo "== mp7-expand-panel shots -> $OUT =="
