#!/bin/bash
# MP10 (MUB-153) transcript rendering audit: profile fixtures shot at the §3 matrix sizes.
# PNG = final visible grid (color evidence, transcript tail); .txt = full scrollback dump
# (plain text, byte-diffable — MP11/MP12 after-shots diff against these).
# Usage: bash docs/BigPlan/shots/mp10-render-audit/capture.sh
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
TUI=$ROOT/packages/tui
OUT=$ROOT/docs/BigPlan/shots/mp10-render-audit
PORT=${MP10_MOCK_PORT:-8465}
SCRATCH=$(mktemp -d /tmp/mp10-audit.XXXXXX)
MOCK_PID=""
trap '[ -n "$MOCK_PID" ] && { kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null || true; }; rm -rf "$SCRATCH"' EXIT

MOCK_PORT=$PORT bun "$TUI/scripts/mock_openai_sse.ts" > "$SCRATCH/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null || { echo "mock failed"; cat "$SCRATCH/mock.log"; exit 1; }

ARGV_BASE='"bun","run","'$TUI'/src/cli/main.ts","--offline","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:'$PORT'/v1"'

# shot <name> <profile> <cols> <rows> — resume the profile fixture, dump txt + png.
shot() {
  local name=$1 profile=$2 cols=$3 rows=$4
  rm -f "$SCRATCH/$name.db" "$SCRATCH/$name.db-wal" "$SCRATCH/$name.db-shm"
  bun run "$TUI/scripts/gen-fixture-session.ts" --db "$SCRATCH/$name.db" \
    --profile "$profile" --name "fixture-$profile" > /dev/null
  mkdir -p "$SCRATCH/home-$name"
  local spec='{"cmd":['$ARGV_BASE',"--resume","fixture-'$profile'"],"cwd":"'$ROOT'","cols":'$cols',"rows":'$rows',"duration":6,
    "png":"'$OUT'/'$name'.png"}'
  HOME=$SCRATCH/home-$name MINIMA_DB_PATH=$SCRATCH/$name.db MINIMA_HARNESS_DIR=$SCRATCH/prefs-$name \
    uv run --with pyte --with pillow python "$TUI/scripts/pty_capture.py" "$spec" > "$OUT/$name.txt"
  tail -1 "$OUT/$name.txt"
}

shot md-120    md    120 36
shot md-60     md    60  24
shot code-120  code  120 36
shot code-80   code  80  36
shot code-60   code  60  24
shot code-tall code  120 60
shot tool-120  tool  120 36
shot tool-60   tool  60  24
shot mixed-120 mixed 120 36
shot mixed-60  mixed 60  24

# Live-stream shot: mock CODE marker streams a fenced reply through the real streaming path.
rm -f "$SCRATCH/stream.db" "$SCRATCH/stream.db-wal" "$SCRATCH/stream.db-shm"
mkdir -p "$SCRATCH/home-stream"
STREAM_SPEC='{"cmd":['$ARGV_BASE'],"cwd":"'$ROOT'","cols":120,"rows":36,"duration":10,
  "frames":"'$SCRATCH'/stream-code.frames.jsonl",
  "steps":[{"after":2.0,"send":"CODE audit stream"},{"after":2.6,"send":"<CR>"}],
  "png":"'$OUT'/stream-code.png"}'
HOME=$SCRATCH/home-stream MINIMA_DB_PATH=$SCRATCH/stream.db MINIMA_HARNESS_DIR=$SCRATCH/prefs-stream \
  uv run --with pyte --with pillow python "$TUI/scripts/pty_capture.py" "$STREAM_SPEC" > "$OUT/stream-code.txt"
tail -1 "$OUT/stream-code.txt"
cp "$SCRATCH/stream-code.frames.jsonl" "$OUT/stream-code.frames.jsonl" 2>/dev/null || true

echo "== mp10-render-audit shots -> $OUT =="
