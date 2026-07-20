#!/bin/bash
# A/B inline capture for the MP2/MP3 byte-identical gates: frames JSONL only, scratch output.
# Usage: ab_capture.sh <outdir> [port]
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
TUI=$ROOT/packages/tui
OUT=$1
PORT=${2:-8452}
mkdir -p "$OUT"
SCRATCH=$(mktemp -d /tmp/ab-cap.XXXXXX)
MOCK_PID=""
trap '[ -n "$MOCK_PID" ] && { kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null || true; }; rm -rf "$SCRATCH"' EXIT

MOCK_PORT=$PORT bun "$TUI/scripts/mock_openai_sse.ts" > "$SCRATCH/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null || { echo "mock failed"; cat "$SCRATCH/mock.log"; exit 1; }

INLINE='["bun","run","'$TUI'/src/cli/main.ts","--offline","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:'$PORT'/v1"]'
RESUME='["bun","run","'$TUI'/src/cli/main.ts","--offline","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:'$PORT'/v1","--resume","fixture-500"]'

shot() {
  local name=$1 spec=$2
  mkdir -p "$SCRATCH/home-$name"
  HOME=$SCRATCH/home-$name MINIMA_DB_PATH=$SCRATCH/$name.db MINIMA_HARNESS_DIR=$SCRATCH/prefs-$name \
    uv run --with pyte python "$TUI/scripts/pty_capture.py" "$spec" | tail -1
}

fixture() {
  bun run "$TUI/scripts/gen-fixture-session.ts" --db "$SCRATCH/$1.db" \
    --messages 500 --name fixture-500 > /dev/null
}

echo "== plain =="
shot plain '{"cmd":'"$INLINE"',"cwd":"'"$ROOT"'","cols":120,"rows":36,"duration":12,
  "steps":[{"after":3,"send":"Say hello briefly"},{"after":4.5,"send":"<CR>"}],
  "frames":"'"$OUT"'/plain.frames.jsonl"}'

echo "== toc =="
fixture toc
shot toc '{"cmd":'"$RESUME"',"cwd":"'"$ROOT"'","cols":120,"rows":36,"duration":9,
  "steps":[{"after":4,"send":"<CTRLT>"}],
  "frames":"'"$OUT"'/toc.frames.jsonl"}'

echo "== gt =="
MINIMA_TUI_GROUND_TRUTH=1 shot gt '{"cmd":'"$INLINE"',"cwd":"'"$ROOT"'","cols":120,"rows":36,"duration":14,
  "steps":[{"after":3,"send":"/gt-seed"},{"after":4.5,"send":"<CR>"},
           {"after":8,"send":"a"},{"after":10.5,"send":"<CTRLG>"}],
  "frames":"'"$OUT"'/gt.frames.jsonl"}'

echo "== b60 =="
fixture b60
shot b60 '{"cmd":'"$RESUME"',"cwd":"'"$ROOT"'","cols":60,"rows":24,"duration":9,
  "steps":[{"after":4,"send":"<CTRLT>"}],
  "frames":"'"$OUT"'/b60.frames.jsonl"}'

echo "== n55 =="
shot n55 '{"cmd":'"$INLINE"',"cwd":"'"$ROOT"'","cols":55,"rows":20,"duration":7,
  "steps":[{"after":3.5,"send":"<CTRLT>"}],
  "frames":"'"$OUT"'/n55.frames.jsonl"}'

echo "== ab_capture done -> $OUT =="
