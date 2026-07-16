#!/bin/bash
# MP0 (MUB-143) — INLINE baseline captures. The PNGs/JSONLs in THIS directory are the
# committed visual reference every later MP diffs against (guide §5 MP0).
#
# Prereq: the committed mock provider must be listening on :8399 —
#   bun packages/tui/scripts/mock_openai_sse.ts &
#
# Usage: bash docs/BigPlan/shots/inline-baseline/capture-specs.sh <scenario|all>
# Scratch (DBs, prefs) goes to mktemp (override: MP0_SCRATCH=...); only evidence lands here.
set -e
cd "$(dirname "$0")/../../../.."
OUT=docs/BigPlan/shots/inline-baseline
SCRATCH=${MP0_SCRATCH:-$(mktemp -d /tmp/mp0-baseline.XXXXXX)}
INLINE='["bun","run","packages/tui/src/cli/main.ts","--offline","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:8399/v1"]'
RESUME='["bun","run","packages/tui/src/cli/main.ts","--offline","--model","mock-model","--provider","mock","--provider-url","http://127.0.0.1:8399/v1","--resume","fixture-500"]'

(exec 3<>/dev/tcp/127.0.0.1/8399) 2>/dev/null || {
  echo "mock provider not running — start it first: bun packages/tui/scripts/mock_openai_sse.ts &" >&2
  exit 1
}

# shot <name> <spec-json> [keep] — fresh per-scenario DB (unless keep), prefs dir
# (mode-ring persistence otherwise carries one scenario's END state into the next START)
# and HOME (tips rotation state writes to the real ~/.minima-harness regardless of
# MINIMA_HARNESS_DIR — isolating HOME keeps the tip row deterministic and the captures
# hermetic).
shot() {
  local name=$1 spec=$2 keep=${3:-}
  [ "$keep" = keep ] || rm -f "$SCRATCH/bl-$name.db" "$SCRATCH/bl-$name.db-shm" "$SCRATCH/bl-$name.db-wal"
  mkdir -p "$SCRATCH/home-$name"
  HOME=$SCRATCH/home-$name MINIMA_DB_PATH=$SCRATCH/bl-$name.db MINIMA_HARNESS_DIR=$SCRATCH/prefs-$name \
    uv run --with pyte --with pillow python packages/tui/scripts/pty_capture.py "$spec" | tail -2
}

# fixture <name> — seed the scenario DB with the 500-message fixture session
fixture() {
  local name=$1
  rm -f "$SCRATCH/bl-$name.db" "$SCRATCH/bl-$name.db-shm" "$SCRATCH/bl-$name.db-wal"
  bun run packages/tui/scripts/gen-fixture-session.ts --db "$SCRATCH/bl-$name.db" \
    --messages 500 --name fixture-500 > /dev/null
}

run() {
case "$1" in
  plain-chat)
    shot plain '{"cmd":'"$INLINE"',"cwd":"'"$PWD"'","cols":120,"rows":36,"duration":12,
      "steps":[{"after":3,"send":"Say hello briefly"},{"after":4.5,"send":"<CR>"}],
      "frames":"'"$OUT"'/plain-chat.frames.jsonl","png":"'"$OUT"'/plain-chat.png"}'
    ;;
  echo-gap)
    shot echo '{"cmd":'"$INLINE"',"cwd":"'"$PWD"'","cols":120,"rows":36,"duration":13,
      "steps":[{"after":3,"send":"SLOW proof: respond only after a delay"},{"after":5,"send":"<CR>"}],
      "frames":"'"$OUT"'/echo-gap.frames.jsonl","png":"'"$OUT"'/echo-gap.png"}'
    ;;
  code-heavy-120)
    shot code120 '{"cmd":'"$INLINE"',"cwd":"'"$PWD"'","cols":120,"rows":36,"duration":14,
      "steps":[{"after":3,"send":"CODE render some snippets"},{"after":4.5,"send":"<CR>"}],
      "png":"'"$OUT"'/code-heavy-120.png"}'
    ;;
  code-heavy-60)
    shot code60 '{"cmd":'"$INLINE"',"cwd":"'"$PWD"'","cols":60,"rows":24,"duration":14,
      "steps":[{"after":3,"send":"CODE render some snippets"},{"after":4.5,"send":"<CR>"}],
      "png":"'"$OUT"'/code-heavy-60.png"}'
    ;;
  fixture-resume)
    fixture fixres
    shot fixres '{"cmd":'"$RESUME"',"cwd":"'"$PWD"'","cols":120,"rows":36,"duration":8,
      "png":"'"$OUT"'/fixture-resume.png"}' keep
    ;;
  gt-banner)
    MINIMA_TUI_GROUND_TRUTH=1 shot gtbanner '{"cmd":'"$INLINE"',"cwd":"'"$PWD"'","cols":120,"rows":36,"duration":13,
      "steps":[{"after":3,"send":"/gt-seed"},{"after":4.5,"send":"<CR>"},
               {"after":9,"send":"working on step one"}],
      "png":"'"$OUT"'/gt-banner.png"}'
    ;;
  gt-block)
    # /gt-seed arms a 🔴 gate; an unanswered gate WINS the Ctrl+G chord, so accept it
    # ("a") first — otherwise the shot captures the gate prompt, not the overview block.
    MINIMA_TUI_GROUND_TRUTH=1 shot gtblock '{"cmd":'"$INLINE"',"cwd":"'"$PWD"'","cols":120,"rows":36,"duration":14,
      "steps":[{"after":3,"send":"/gt-seed"},{"after":4.5,"send":"<CR>"},
               {"after":8,"send":"a"},{"after":10.5,"send":"<CTRLG>"}],
      "png":"'"$OUT"'/gt-block.png"}'
    ;;
  gt-off-notice)
    shot gtoff '{"cmd":'"$INLINE"',"cwd":"'"$PWD"'","cols":120,"rows":36,"duration":7,
      "steps":[{"after":3.5,"send":"<CTRLG>"}],
      "png":"'"$OUT"'/gt-off-notice.png"}'
    ;;
  toc-block)
    fixture toc
    shot toc '{"cmd":'"$RESUME"',"cwd":"'"$PWD"'","cols":120,"rows":36,"duration":9,
      "steps":[{"after":4,"send":"<CTRLT>"}],
      "png":"'"$OUT"'/toc-block.png"}' keep
    ;;
  boundary-60)
    fixture b60
    shot b60 '{"cmd":'"$RESUME"',"cwd":"'"$PWD"'","cols":60,"rows":24,"duration":9,
      "steps":[{"after":4,"send":"<CTRLT>"}],
      "png":"'"$OUT"'/boundary-60.png"}' keep
    ;;
  narrow-55)
    shot n55 '{"cmd":'"$INLINE"',"cwd":"'"$PWD"'","cols":55,"rows":20,"duration":7,
      "steps":[{"after":3.5,"send":"<CTRLT>"}],
      "png":"'"$OUT"'/narrow-55.png"}'
    ;;
  perf)
    fixture perf
    MINIMA_TUI_PERF=$OUT/perf.jsonl shot perf '{"cmd":'"$RESUME"',"cwd":"'"$PWD"'","cols":120,"rows":36,"duration":12,
      "steps":[{"after":3,"send":"Say hello briefly"},{"after":4.5,"send":"<CR>"}]}' keep
    ;;
  *) echo "usage: capture-specs.sh <plain-chat|echo-gap|code-heavy-120|code-heavy-60|fixture-resume|gt-banner|gt-block|gt-off-notice|toc-block|boundary-60|narrow-55|perf|all>"; exit 1;;
esac
}

if [ "$1" = all ]; then
  rm -f "$OUT/perf.jsonl"
  for s in plain-chat echo-gap code-heavy-120 code-heavy-60 fixture-resume gt-banner gt-block gt-off-notice toc-block boundary-60 narrow-55 perf; do
    echo "== $s =="; run "$s"
  done
else
  run "$1"
fi
