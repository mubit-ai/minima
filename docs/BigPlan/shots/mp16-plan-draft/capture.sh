#!/bin/bash
# MP16 (MUB-159) plan-draft visibility: the D3b `plan (draft)` view converging
# round-over-round (/plan-seed canned council rounds — zero model calls), then
# /plan finalize --force flipping the SAME Ctrl+G chord to the ledger-backed GT overview.
# Three PNGs = the spec's three-stage convergence proof. Provider keys pinned empty +
# isolated HOME/cwd: hermetic (finalize writes GROUND_TRUTH.md into the scratch cwd).
# Usage: bash docs/BigPlan/shots/mp16-plan-draft/capture.sh
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
TUI=$ROOT/packages/tui
OUT=$ROOT/docs/BigPlan/shots/mp16-plan-draft
PORT=${MP16_MOCK_PORT:-8476}
SCRATCH=$(mktemp -d /tmp/mp16-draft.XXXXXX)
MOCK_PID=""
trap '[ -n "$MOCK_PID" ] && { kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null || true; }; rm -rf "$SCRATCH"' EXIT

MOCK_PORT=$PORT bun "$TUI/scripts/mock_openai_sse.ts" > "$SCRATCH/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null || { echo "mock failed"; cat "$SCRATCH/mock.log"; exit 1; }

ARGV_BASE='"bun","run","'$TUI'/src/cli/main.ts","--offline","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:'$PORT'/v1"'
KEYS='"MINIMA_TUI_GROUND_TRUTH":"1","MINIMA_JUDGE_MODEL":"mock-model","ANTHROPIC_API_KEY":"","ANTHROPIC_OAUTH_TOKEN":"","OPENAI_API_KEY":"","GEMINI_API_KEY":"","GOOGLE_API_KEY":"","GOOGLE_GENAI_API_KEY":"","OPENROUTER_API_KEY":"","DEEPSEEK_API_KEY":"","GROQ_API_KEY":"","XAI_API_KEY":""'

# shot <name> <duration> <extra-steps-json> — one session; the png freezes the final grid.
shot() {
  local name=$1 duration=$2 steps=$3
  rm -f "$SCRATCH/$name.db" "$SCRATCH/$name.db-wal" "$SCRATCH/$name.db-shm"
  mkdir -p "$SCRATCH/home-$name"
  local spec='{"cmd":['$ARGV_BASE'],"cwd":"'$SCRATCH'","cols":120,"rows":36,"duration":'$duration',
    "env":{'$KEYS'},
    "steps":'$steps',
    "png":"'$OUT'/'$name'.png"}'
  HOME=$SCRATCH/home-$name MINIMA_DB_PATH=$SCRATCH/$name.db MINIMA_HARNESS_DIR=$SCRATCH/prefs-$name \
    uv run --with pyte --with pillow python "$TUI/scripts/pty_capture.py" "$spec" > "$OUT/$name.txt"
  tail -1 "$OUT/$name.txt"
}

shot draft-round1 7 '[{"after":2.0,"send":"/plan-seed"},{"after":2.5,"send":"<CR>"},{"after":3.4,"send":"<CTRLG>"}]'
shot draft-round2 10 '[{"after":2.0,"send":"/plan-seed"},{"after":2.5,"send":"<CR>"},{"after":3.4,"send":"/plan-seed"},{"after":3.9,"send":"<CR>"},{"after":4.8,"send":"<CTRLG>"}]'
shot final-overview 16 '[{"after":2.0,"send":"/plan-seed"},{"after":2.5,"send":"<CR>"},{"after":3.4,"send":"/plan finalize --force"},{"after":4.0,"send":"<CR>"},{"after":9.0,"send":"<CTRLG>"}]'

echo "== mp16-plan-draft shots -> $OUT =="
