#!/bin/bash
# MP12 (MUB-155) after-shots: the MP10 tool-profile fixture with the CC-style truncation
# marker (… N more lines — shared toolHiddenMarker producer). Diff the .txt dumps against
# docs/BigPlan/shots/mp10-render-audit/tool-*.txt.
# Usage: bash docs/BigPlan/shots/mp12-tool-truncate/capture.sh
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
TUI=$ROOT/packages/tui
OUT=$ROOT/docs/BigPlan/shots/mp12-tool-truncate
PORT=${MP12_MOCK_PORT:-8469}
SCRATCH=$(mktemp -d /tmp/mp12-tool.XXXXXX)
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
    --profile tool --name fixture-tool > /dev/null
  mkdir -p "$SCRATCH/home-$name"
  local spec='{"cmd":['$ARGV_BASE',"--resume","fixture-tool"],"cwd":"'$ROOT'","cols":'$cols',"rows":'$rows',"duration":6,
    "png":"'$OUT'/'$name'.png"}'
  HOME=$SCRATCH/home-$name MINIMA_DB_PATH=$SCRATCH/$name.db MINIMA_HARNESS_DIR=$SCRATCH/prefs-$name \
    uv run --with pyte --with pillow python "$TUI/scripts/pty_capture.py" "$spec" > "$OUT/$name.txt"
  tail -1 "$OUT/$name.txt"
}

shot tool-120 120 36
shot tool-60  60  24

grep -q "… [0-9]* more lines" "$OUT/tool-120.txt" || { echo "FAIL: CC marker missing in tool-120"; exit 1; }
grep -q "… +" "$OUT/tool-120.txt" && { echo "FAIL: legacy +N marker still present"; exit 1; }

echo "== mp12-tool-truncate shots -> $OUT =="
