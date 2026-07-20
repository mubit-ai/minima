#!/bin/bash
# MP14 (MUB-157) council progress streaming: the busy row's council line advancing
# role-by-role during a mock /plan turn (canned council replies; MINIMA_JUDGE_MODEL=
# mock-model points the meta calls at the mock, MOCK_COUNCIL_STAGE_MS makes each phase
# dwell long enough to shoot). PNGs = mid-round frames; the frames JSONL is the
# role-by-role advance proof (also gated in tui_verify.sh scenario plan-council).
# Usage: bash docs/BigPlan/shots/mp14-council-progress/capture.sh
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
TUI=$ROOT/packages/tui
OUT=$ROOT/docs/BigPlan/shots/mp14-council-progress
PORT=${MP14_MOCK_PORT:-8473}
SCRATCH=$(mktemp -d /tmp/mp14-council.XXXXXX)
MOCK_PID=""
trap '[ -n "$MOCK_PID" ] && { kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null || true; }; rm -rf "$SCRATCH"' EXIT

MOCK_PORT=$PORT MOCK_COUNCIL_STAGE_MS=1200 bun "$TUI/scripts/mock_openai_sse.ts" > "$SCRATCH/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null || { echo "mock failed"; cat "$SCRATCH/mock.log"; exit 1; }

ARGV_BASE='"bun","run","'$TUI'/src/cli/main.ts","--offline","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:'$PORT'/v1"'

# shot <name> <png-at-duration> — one /plan council run; the png is the FINAL grid, so vary
# the duration to freeze different phases mid-round (1.2s per meta call).
shot() {
  local name=$1 duration=$2
  rm -f "$SCRATCH/$name.db" "$SCRATCH/$name.db-wal" "$SCRATCH/$name.db-shm"
  mkdir -p "$SCRATCH/home-$name"
  local spec='{"cmd":['$ARGV_BASE'],"cwd":"'$ROOT'","cols":120,"rows":36,"duration":'$duration',
    "frames":"'$SCRATCH'/'$name'.frames.jsonl",
    "env":{"MINIMA_TUI_GROUND_TRUTH":"1","MINIMA_JUDGE_MODEL":"mock-model",
      "ANTHROPIC_API_KEY":"","ANTHROPIC_OAUTH_TOKEN":"","OPENAI_API_KEY":"","GEMINI_API_KEY":"",
      "GOOGLE_API_KEY":"","GOOGLE_GENAI_API_KEY":"","OPENROUTER_API_KEY":"","DEEPSEEK_API_KEY":"",
      "GROQ_API_KEY":"","XAI_API_KEY":""},
    "steps":[{"after":2.0,"send":"/plan start demo council progress"},{"after":2.6,"send":"<CR>"},
             {"after":3.4,"send":"please research the codebase and draft a plan for the demo"},{"after":4.2,"send":"<CR>"}],
    "png":"'$OUT'/'$name'.png"}'
  HOME=$SCRATCH/home-$name MINIMA_DB_PATH=$SCRATCH/$name.db MINIMA_HARNESS_DIR=$SCRATCH/prefs-$name \
    uv run --with pyte --with pillow python "$TUI/scripts/pty_capture.py" "$spec" > "$OUT/$name.txt"
  tail -1 "$OUT/$name.txt"
}

shot busy-research 6
shot busy-synth 10
cp "$SCRATCH/busy-synth.frames.jsonl" "$OUT/council-line.frames.jsonl"

echo "== mp14-council-progress shots -> $OUT =="
