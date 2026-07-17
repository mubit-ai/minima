#!/bin/bash
# MP4 (MUB-147) spike evidence shots: the near-full live-region panel over a 500-msg
# resume — open / scrolled-to-end / closed. Self-contained (starts its own mock).
# Usage: bash docs/BigPlan/shots/mp4-spike/capture.sh
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
TUI=$ROOT/packages/tui
OUT=$ROOT/docs/BigPlan/shots/mp4-spike
PORT=${MP4_MOCK_PORT:-8454}
SCRATCH=$(mktemp -d /tmp/mp4-spike.XXXXXX)
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
  MINIMA_TUI_SPIKE_PANEL=1 \
    uv run --with pyte --with pillow python "$TUI/scripts/pty_capture.py" "$spec" | tail -1
}

shot open '{"cmd":'$RESUME',"cwd":"'$ROOT'","cols":120,"rows":36,"duration":6,
  "steps":[{"after":3.5,"send":"<CTRLT>"}],
  "png":"'$OUT'/mp4-open.png"}'

shot scrolled '{"cmd":'$RESUME',"cwd":"'$ROOT'","cols":120,"rows":36,"duration":10,
  "steps":[{"after":3.5,"send":"<CTRLT>"},
           {"after":4.0,"send":"jjjjjjjjjj","repeat":20,"gap":0.18},
           {"after":8.2,"send":"G"}],
  "png":"'$OUT'/mp4-scrolled.png"}'

shot closed '{"cmd":'$RESUME',"cwd":"'$ROOT'","cols":120,"rows":36,"duration":11.5,
  "steps":[{"after":3.5,"send":"<CTRLT>"},
           {"after":4.0,"send":"jjjjjjjjjj","repeat":20,"gap":0.18},
           {"after":9.5,"send":"<ESC>"}],
  "png":"'$OUT'/mp4-closed.png"}'

echo "== mp4-spike shots -> $OUT =="
