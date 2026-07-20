#!/bin/bash
# Anchor-ledger repro matrix: the bottom-anchor defect class reported 2026-07-20 (composer
# floats mid-screen with dead rows below; Ink overflow wipe leaves the UI top-stuck; giant
# flex gaps inside the live region). Scenarios are classified by:
#   ESC[3J count == 1  + bottom-anchor FAIL  -> float class (frame shrink, no wipe)
#   ESC[3J count  > 1                        -> wipe class (live frame reached rows)
#
#   overlay-teardown  two tall CODE replies saturate the static estimate, then the TODO
#                     turn's todowrite permission prompt is approved with 'y' — the overlay
#                     teardown is the shrink under test (120x36 and the reporter's 200x50).
#                     The 200x50 run ALSO pins the wide-terminal stream-commit float
#                     (window [10,13]): at 200 cols the committed reply wraps to FEWER rows
#                     than the stream-frame shrink it must compensate, so the MP20
#                     commit-order fix alone cannot re-anchor — low row 42/50 sustained.
#   panel-early       idle Ctrl+T open/close on a SHORT transcript (the panel scenarios in
#                     tui_verify.sh only cover the 500-msg fixture where minHeight is inert)
#   panel-stream      always-panel (PR #186): Ctrl+T opens the panel OVER the live stream,
#                     in-panel Ctrl+G swaps views, Esc closes after the stream ends under it
#   resize-shrink     shrink the PTY 40 -> 32 rows after a tall reply: the app repaints once
#                     and never re-anchors (permanent float, no wipe — the frame was small)
#   resize-panel-wipe shrink 40 -> 32 WITH the panel open (frame 38 rows >= 32): Ink
#                     re-renders the old tree against the new rows -> clearTerminal wipe,
#                     UI top-stuck after
#
# Usage: bash docs/BigPlan/shots/anchor-ledger/capture-specs.sh [before|after]
# Evidence lands in docs/BigPlan/shots/anchor-ledger/<label>-<scenario>.{png,txt,frames.jsonl,raw.bin}
# Assert failures are REPORTED, not fatal — the "before" run is expected to fail bottom-anchor.
set -e
LABEL=${1:-before}
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
TUI=$ROOT/packages/tui
OUT=$ROOT/docs/BigPlan/shots/anchor-ledger
PORT=${ANCHOR_MOCK_PORT:-8469}
SCRATCH=$(mktemp -d /tmp/anchor-ledger.XXXXXX)
MOCK_PID=""
trap '[ -n "$MOCK_PID" ] && { kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null || true; }; rm -rf "$SCRATCH"' EXIT

export ANTHROPIC_API_KEY="" ANTHROPIC_OAUTH_TOKEN="" OPENAI_API_KEY="" \
  OPENAI_COMPAT_API_KEY="" GEMINI_API_KEY="" GOOGLE_API_KEY="" GOOGLE_GENAI_API_KEY="" \
  OPENROUTER_API_KEY="" DEEPSEEK_API_KEY="" GROQ_API_KEY="" XAI_API_KEY=""

MOCK_PORT=$PORT bun "$TUI/scripts/mock_openai_sse.ts" > "$SCRATCH/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null || { echo "mock failed"; cat "$SCRATCH/mock.log"; exit 1; }

ARGV_BASE='"bun","run","'$TUI'/src/cli/main.ts","--offline","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:'$PORT'/v1"'

# Warm the uv env once so pyte/pillow resolution never competes with a live capture for
# CPU/network (a slow mock turn eats the later scripted keystrokes while busy).
uv run --with pyte --with pillow python -c "import pyte, PIL" >/dev/null 2>&1 || true

wipes() {
  python3 -c 'import sys; print(open(sys.argv[1],"rb").read().count(b"\x1b[3J"))' "$1"
}

run_scenario() {
  local name=$1 spec=$2
  mkdir -p "$SCRATCH/home-$name"
  HOME=$SCRATCH/home-$name \
    uv run --with pyte --with pillow python "$TUI/scripts/pty_capture.py" "$spec" \
    > "$OUT/$LABEL-$name.txt"
  tail -1 "$OUT/$LABEL-$name.txt"
  echo "-- $name: ESC[3J wipes = $(wipes "$OUT/$LABEL-$name.raw.bin") (1 = startup clear only)"
}

anchor() {
  local name=$1; shift
  if python3 "$TUI/scripts/tui_assert.py" "$OUT/$LABEL-$name.frames.jsonl" \
    --check bottom-anchor "$@"; then
    echo "-- $name: bottom-anchor PASS"
  else
    echo "-- $name: bottom-anchor FAIL (float/top-stuck reproduced)"
  fi
}

echo "== [$LABEL] overlay-teardown (120x36): saturate estimate, approve perm with y =="
run_scenario overlay-teardown '{"cmd":['$ARGV_BASE'],"cwd":"'$ROOT'","cols":120,"rows":36,"duration":25,
  "env":{"MINIMA_DB_PATH":"'$SCRATCH'/ot.db","MINIMA_HARNESS_DIR":"'$SCRATCH'/prefs-ot",
         "MINIMA_TUI_GROUND_TRUTH":"0"},
  "frames":"'$OUT'/'$LABEL'-overlay-teardown.frames.jsonl",
  "raw":"'$OUT'/'$LABEL'-overlay-teardown.raw.bin",
  "png":"'$OUT'/'$LABEL'-overlay-teardown.png",
  "steps":[
    {"after":3.0,"send":"CODE saturate one"},{"after":3.6,"send":"<CR>"},
    {"after":8.5,"send":"CODE saturate two"},{"after":9.0,"send":"<CR>"},
    {"after":13.5,"send":"TODO plan this work"},{"after":14.0,"send":"<CR>"},
    {"after":20.5,"send":"y"},{"after":23.0,"send":"y"}
  ]}'
anchor overlay-teardown --after 20.6 --bottom-slack 2

echo "== [$LABEL] overlay-teardown-200x50 (reporter geometry) =="
run_scenario overlay-teardown-200x50 '{"cmd":['$ARGV_BASE'],"cwd":"'$ROOT'","cols":200,"rows":50,"duration":25,
  "env":{"MINIMA_DB_PATH":"'$SCRATCH'/ot50.db","MINIMA_HARNESS_DIR":"'$SCRATCH'/prefs-ot50",
         "MINIMA_TUI_GROUND_TRUTH":"0"},
  "frames":"'$OUT'/'$LABEL'-overlay-teardown-200x50.frames.jsonl",
  "raw":"'$OUT'/'$LABEL'-overlay-teardown-200x50.raw.bin",
  "png":"'$OUT'/'$LABEL'-overlay-teardown-200x50.png",
  "steps":[
    {"after":3.0,"send":"CODE saturate one"},{"after":3.6,"send":"<CR>"},
    {"after":8.5,"send":"CODE saturate two"},{"after":9.0,"send":"<CR>"},
    {"after":13.5,"send":"TODO plan this work"},{"after":14.0,"send":"<CR>"},
    {"after":20.5,"send":"y"},{"after":23.0,"send":"y"}
  ]}'
echo "-- whole-run window (covers the wide-terminal stream commits AND the perm teardown;"
echo "   mock commit timing varies run-to-run, so no fixed sub-window):"
anchor overlay-teardown-200x50 --after 4.0 --bottom-slack 2

echo "== [$LABEL] panel-early (120x36): idle Ctrl+T open/close on a short transcript =="
run_scenario panel-early '{"cmd":['$ARGV_BASE'],"cwd":"'$ROOT'","cols":120,"rows":36,"duration":14,
  "env":{"MINIMA_DB_PATH":"'$SCRATCH'/pe.db","MINIMA_HARNESS_DIR":"'$SCRATCH'/prefs-pe"},
  "frames":"'$OUT'/'$LABEL'-panel-early.frames.jsonl",
  "raw":"'$OUT'/'$LABEL'-panel-early.raw.bin",
  "png":"'$OUT'/'$LABEL'-panel-early.png",
  "steps":[
    {"after":3.0,"send":"CODE hello"},{"after":3.6,"send":"<CR>"},
    {"after":8.5,"send":"<CTRLT>"},
    {"after":9.5,"send":"j"},
    {"after":10.5,"send":"<ESC>"}
  ]}'
anchor panel-early --after 10.4 --bottom-slack 1

echo "== [$LABEL] panel-stream (120x36): panel over the live stream, Esc after stream end =="
run_scenario panel-stream '{"cmd":['$ARGV_BASE'],"cwd":"'$ROOT'","cols":120,"rows":36,"duration":12,
  "env":{"MINIMA_DB_PATH":"'$SCRATCH'/ps.db","MINIMA_HARNESS_DIR":"'$SCRATCH'/prefs-ps"},
  "frames":"'$OUT'/'$LABEL'-panel-stream.frames.jsonl",
  "raw":"'$OUT'/'$LABEL'-panel-stream.raw.bin",
  "png":"'$OUT'/'$LABEL'-panel-stream.png",
  "steps":[
    {"after":3.0,"send":"CODE tall reply"},{"after":3.6,"send":"<CR>"},
    {"after":4.6,"send":"<CTRLT>"},
    {"after":5.4,"send":"<CTRLG>"},
    {"after":8.0,"send":"<ESC>"}
  ]}'
anchor panel-stream --after 7.9 --bottom-slack 1

echo "== [$LABEL] resize-shrink (120x40 -> 120x32): float after resize, exact after a commit =="
run_scenario resize-shrink '{"cmd":['$ARGV_BASE'],"cwd":"'$ROOT'","cols":120,"rows":40,"duration":17,
  "env":{"MINIMA_DB_PATH":"'$SCRATCH'/rs.db","MINIMA_HARNESS_DIR":"'$SCRATCH'/prefs-rs"},
  "frames":"'$OUT'/'$LABEL'-resize-shrink.frames.jsonl",
  "raw":"'$OUT'/'$LABEL'-resize-shrink.raw.bin",
  "png":"'$OUT'/'$LABEL'-resize-shrink.png",
  "steps":[
    {"after":3.0,"send":"CODE hello"},{"after":3.6,"send":"<CR>"},
    {"after":8.5,"resize":[120,32]},
    {"after":10.5,"send":"SLOW again"},{"after":11.0,"send":"<CR>"}
  ]}'
echo "-- post-resize window (ledger residual bounded by SCROLLBACK_SAFETY_ROWS):"
anchor resize-shrink --after 8.6 --before 10.4 --bottom-slack 2
echo "-- post-commit window (exact re-anchor):"
anchor resize-shrink --after 12.0 --bottom-slack 1

echo "== [$LABEL] resize-panel-wipe (panel open, 40 -> 32 rows): Ink wipe, top-stuck =="
run_scenario resize-panel-wipe '{"cmd":['$ARGV_BASE'],"cwd":"'$ROOT'","cols":120,"rows":40,"duration":13,
  "env":{"MINIMA_DB_PATH":"'$SCRATCH'/rpw.db","MINIMA_HARNESS_DIR":"'$SCRATCH'/prefs-rpw"},
  "frames":"'$OUT'/'$LABEL'-resize-panel-wipe.frames.jsonl",
  "raw":"'$OUT'/'$LABEL'-resize-panel-wipe.raw.bin",
  "png":"'$OUT'/'$LABEL'-resize-panel-wipe.png",
  "steps":[
    {"after":3.0,"send":"CODE hello"},{"after":3.6,"send":"<CR>"},
    {"after":8.0,"send":"<CTRLT>"},
    {"after":9.0,"resize":[120,32]},
    {"after":10.5,"send":"<ESC>"}
  ]}'
anchor resize-panel-wipe --after 9.2 --bottom-slack 2

echo "== [$LABEL] anchor-ledger evidence -> $OUT =="
