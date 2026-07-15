#!/bin/bash
# BASELINE PTY shots of the CURRENT sidebar/echo state @ feat/BP-UX 1bd27b3.
# Plan-mode safe: every artifact (PNG, DB, prefs) lands in the scratchpad, never the repo.
set -e
cd /Users/eldaru/Mubit/Minima/minima-j1
SCRATCH=/private/tmp/claude-501/-Users-eldaru-Mubit-Minima-minima/b428a3c4-6ebc-4227-9dbd-b47747997f2f/scratchpad
OUT=$SCRATCH/baseline
mkdir -p "$OUT"
FS='["bun","run","packages/tui/src/cli/main.ts","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:8399/v1","--fullscreen"]'
INLINE='["bun","run","packages/tui/src/cli/main.ts","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:8399/v1"]'
export MINIMA_HARNESS_DIR=$SCRATCH/harness-prefs

shot() {
  local name=$1 spec=$2
  rm -f "$SCRATCH/bl-$name.db" "$SCRATCH/bl-$name.db-shm" "$SCRATCH/bl-$name.db-wal"
  MINIMA_DB_PATH=$SCRATCH/bl-$name.db \
    uv run --with pyte --with pillow python packages/tui/scripts/pty_capture.py "$spec" | tail -2
}

case "$1" in
  toc-wide)
    shot toc '{"cmd":'"$FS"',"cwd":"'"$PWD"'","cols":120,"rows":36,"duration":14,
      "steps":[{"after":4,"send":"summarize the auth flow"},{"after":6,"send":"<CR>"},
               {"after":11,"send":"<CTRLT>"}],
      "png":"'"$OUT"'/base-toc-wide.png"}'
    ;;
  gt-wide)
    MINIMA_TUI_GROUND_TRUTH=1 shot gt '{"cmd":'"$FS"',"cwd":"'"$PWD"'","cols":120,"rows":36,"duration":16,
      "steps":[{"after":4,"send":"/gt-seed"},{"after":5.5,"send":"<CR>"},
               {"after":9,"send":"a"},{"after":12,"send":"<CTRLG>"}],
      "png":"'"$OUT"'/base-gt-wide.png"}'
    ;;
  narrow)
    shot narrow '{"cmd":'"$FS"',"cwd":"'"$PWD"'","cols":55,"rows":30,"duration":8,
      "steps":[{"after":4,"send":"<CTRLT>"}],
      "png":"'"$OUT"'/base-narrow.png"}'
    ;;
  echo-gap)
    MINIMA_TUI_GROUND_TRUTH=1 MINIMA_JUDGE_MODEL=mock-model shot echo '{"cmd":'"$FS"',"cwd":"'"$PWD"'","cols":120,"rows":36,"duration":11,
      "steps":[{"after":4,"send":"<SHIFTTAB>"},{"after":4.7,"send":"<SHIFTTAB>"},
               {"after":6,"send":"sketch the plan"},{"after":8,"send":"<CR>"}],
      "png":"'"$OUT"'/base-echo-gap.png"}'
    ;;
  inline-default)
    shot inline '{"cmd":'"$INLINE"',"cwd":"'"$PWD"'","cols":120,"rows":36,"duration":12,
      "steps":[{"after":4,"send":"hello there"},{"after":6,"send":"<CR>"},
               {"after":10,"send":"<CTRLT>"}],
      "png":"'"$OUT"'/base-inline-default.png"}'
    ;;
  *) echo "usage: run_baseline.sh <toc-wide|gt-wide|narrow|echo-gap|inline-default>"; exit 1;;
esac
