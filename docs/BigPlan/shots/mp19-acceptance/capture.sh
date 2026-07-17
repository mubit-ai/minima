#!/bin/bash
# MP19 (MUB-162) final E2E acceptance demo — the whole Track W story in ONE scripted run,
# frozen at its beats: plan (council line) → draft (Ctrl+G) → exit gate (Shift+Tab) →
# execution red→fix→green (PLANDEMO) → ToC ⚠→✓ → overview + step card. Same choreography
# as the tui_verify `acceptance` scenario; each shot re-runs the prefix and freezes the
# final grid at that beat. Hermetic: mock on 127.0.0.1, empty provider keys, scratch cwd.
# Usage: bash docs/BigPlan/shots/mp19-acceptance/capture.sh
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
TUI=$ROOT/packages/tui
OUT=$ROOT/docs/BigPlan/shots/mp19-acceptance
PORT=${MP19_MOCK_PORT:-8491}
SCRATCH=$(mktemp -d /tmp/mp19-accept.XXXXXX)
MOCK_PID=""
trap '[ -n "$MOCK_PID" ] && { kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null || true; }; rm -rf "$SCRATCH"' EXIT

MOCK_PORT=$PORT bun "$TUI/scripts/mock_openai_sse.ts" > "$SCRATCH/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null || { echo "mock failed"; cat "$SCRATCH/mock.log"; exit 1; }

ARGV_BASE='"bun","run","'$TUI'/src/cli/main.ts","--offline","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:'$PORT'/v1"'
KEYS='"MINIMA_TUI_GROUND_TRUTH":"1","MINIMA_JUDGE_MODEL":"mock-model","ANTHROPIC_API_KEY":"","ANTHROPIC_OAUTH_TOKEN":"","OPENAI_API_KEY":"","GEMINI_API_KEY":"","GOOGLE_API_KEY":"","GOOGLE_GENAI_API_KEY":"","OPENROUTER_API_KEY":"","DEEPSEEK_API_KEY":"","GROQ_API_KEY":"","XAI_API_KEY":""'
PREFIX='{"after":3.0,"send":"/plan start build the demo widget"},{"after":3.6,"send":"<CR>"},{"after":4.4,"send":"please research and draft the demo widget plan"},{"after":5.2,"send":"<CR>"}'
THROUGH_GATE=$PREFIX',{"after":12.5,"send":"<CTRLG>"},{"after":14.0,"send":"<ESC>"},{"after":15.0,"send":"<SHIFTTAB>"}'
THROUGH_EXEC=$THROUGH_GATE',{"after":16.5,"send":"<CR>"},{"after":20.0,"send":"PLANDEMO build it now"},{"after":20.8,"send":"<CR>"},{"after":23.5,"send":"a"},{"after":27.0,"send":"a"}'

shot() {
  local name=$1 duration=$2 steps=$3
  rm -f "$SCRATCH/$name.db" "$SCRATCH/$name.db-wal" "$SCRATCH/$name.db-shm"
  mkdir -p "$SCRATCH/home-$name" "$SCRATCH/cwd-$name"
  local spec='{"cmd":['$ARGV_BASE'],"cwd":"'$SCRATCH'/cwd-'$name'","cols":120,"rows":40,"duration":'$duration',
    "env":{'$KEYS'},
    "steps":['$steps'],
    "png":"'$OUT'/'$name'.png"}'
  HOME=$SCRATCH/home-$name MINIMA_DB_PATH=$SCRATCH/$name.db MINIMA_HARNESS_DIR=$SCRATCH/prefs-$name \
    uv run --with pyte --with pillow python "$TUI/scripts/pty_capture.py" "$spec" > "$OUT/$name.txt"
  tail -1 "$OUT/$name.txt"
}

shot 1-council 8 "$PREFIX"
shot 2-draft 14 "$PREFIX"',{"after":12.5,"send":"<CTRLG>"}'
shot 3-exit-gate 17 "$THROUGH_GATE"
shot 4-red-block 26 "$THROUGH_GATE"',{"after":16.5,"send":"<CR>"},{"after":20.0,"send":"PLANDEMO build it now"},{"after":20.8,"send":"<CR>"},{"after":23.5,"send":"a"}'
shot 5-green-close 31 "$THROUGH_EXEC"
shot 6-toc-marker 34 "$THROUGH_EXEC"',{"after":31.0,"send":"<CTRLT>"}'
shot 7-step-card 38 "$THROUGH_EXEC"',{"after":31.0,"send":"<CTRLT>"},{"after":33.0,"send":"<ESC>"},{"after":34.0,"send":"<CTRLG>"},{"after":35.5,"send":"<CR>"}'

echo "== mp19-acceptance shots -> $OUT =="
