#!/bin/bash
# MP20 (MUB-165) stream-commit bottom-mount reseat: re-run of the MP10 stream-code capture
# that DISCOVERED the strand (composer at row ~10/36 after a tall streamed reply commits).
# After the fix the settled frames must show the prompt within 1 row of the grid bottom —
# asserted here with tui_assert's bottom-anchor check, the same check now gating
# stream-wipe-perf and stream-code-80/60 in tui_verify.sh.
# Before-evidence: docs/BigPlan/shots/mp10-render-audit/stream-code.{png,txt,frames.jsonl}.
# Usage: bash docs/BigPlan/shots/mp20-stream-reseat/capture.sh
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
TUI=$ROOT/packages/tui
OUT=$ROOT/docs/BigPlan/shots/mp20-stream-reseat
PORT=${MP20_MOCK_PORT:-8468}
SCRATCH=$(mktemp -d /tmp/mp20-reseat.XXXXXX)
MOCK_PID=""
trap '[ -n "$MOCK_PID" ] && { kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null || true; }; rm -rf "$SCRATCH"' EXIT

MOCK_PORT=$PORT bun "$TUI/scripts/mock_openai_sse.ts" > "$SCRATCH/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null || { echo "mock failed"; cat "$SCRATCH/mock.log"; exit 1; }

ARGV_BASE='"bun","run","'$TUI'/src/cli/main.ts","--offline","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:'$PORT'/v1"'

rm -f "$SCRATCH/stream.db" "$SCRATCH/stream.db-wal" "$SCRATCH/stream.db-shm"
mkdir -p "$SCRATCH/home-stream"
STREAM_SPEC='{"cmd":['$ARGV_BASE'],"cwd":"'$ROOT'","cols":120,"rows":36,"duration":10,
  "frames":"'$SCRATCH'/stream-code.frames.jsonl",
  "steps":[{"after":2.0,"send":"CODE audit stream"},{"after":2.6,"send":"<CR>"}],
  "png":"'$OUT'/stream-code.png"}'
HOME=$SCRATCH/home-stream MINIMA_DB_PATH=$SCRATCH/stream.db MINIMA_HARNESS_DIR=$SCRATCH/prefs-stream \
  uv run --with pyte --with pillow python "$TUI/scripts/pty_capture.py" "$STREAM_SPEC" > "$OUT/stream-code.txt"
tail -1 "$OUT/stream-code.txt"
cp "$SCRATCH/stream-code.frames.jsonl" "$OUT/stream-code.frames.jsonl"

python3 "$TUI/scripts/tui_assert.py" "$OUT/stream-code.frames.jsonl" --after 2.0 \
  --check bottom-anchor --bottom-slack 3

echo "== mp20-stream-reseat shots -> $OUT =="
