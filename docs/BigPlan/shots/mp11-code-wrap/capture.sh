#!/bin/bash
# MP11 (MUB-154) after-shots: the MP10 code-profile fixture re-shot with fence-aware
# rendering, at the three acceptance widths + the full-view tall grid. Diff the .txt dumps
# against docs/BigPlan/shots/mp10-render-audit/code-*.txt for the exact before/after.
# Usage: bash docs/BigPlan/shots/mp11-code-wrap/capture.sh
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
TUI=$ROOT/packages/tui
OUT=$ROOT/docs/BigPlan/shots/mp11-code-wrap
PORT=${MP11_MOCK_PORT:-8468}
SCRATCH=$(mktemp -d /tmp/mp11-code.XXXXXX)
MOCK_PID=""
trap '[ -n "$MOCK_PID" ] && { kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null || true; }; rm -rf "$SCRATCH"' EXIT

MOCK_PORT=$PORT bun "$TUI/scripts/mock_openai_sse.ts" > "$SCRATCH/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null || { echo "mock failed"; cat "$SCRATCH/mock.log"; exit 1; }

ARGV_BASE='"bun","run","'$TUI'/src/cli/main.ts","--offline","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:'$PORT'/v1"'

shot() {
  local name=$1 cols=$2 rows=$3
  rm -f "$SCRATCH/$name.db" "$SCRATCH/$name.db-wal" "$SCRATCH/$name.db-shm"
  bun run "$TUI/scripts/gen-fixture-session.ts" --db "$SCRATCH/$name.db" \
    --profile code --name fixture-code > /dev/null
  mkdir -p "$SCRATCH/home-$name"
  local spec='{"cmd":['$ARGV_BASE',"--resume","fixture-code"],"cwd":"'$ROOT'","cols":'$cols',"rows":'$rows',"duration":6,
    "png":"'$OUT'/'$name'.png"}'
  HOME=$SCRATCH/home-$name MINIMA_DB_PATH=$SCRATCH/$name.db MINIMA_HARNESS_DIR=$SCRATCH/prefs-$name \
    uv run --with pyte --with pillow python "$TUI/scripts/pty_capture.py" "$spec" > "$OUT/$name.txt"
  tail -1 "$OUT/$name.txt"
}

shot code-120  120 36
shot code-80   80  36
shot code-60   60  24
shot code-tall 120 60

echo "== mp11-code-wrap shots -> $OUT =="
