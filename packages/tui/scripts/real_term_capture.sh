#!/usr/bin/env bash
# Real-terminal capture harness (macOS, local diagnostic — NOT CI).
#
# The pyte-based PTY suite proved blind to an emulator-specific failure: the composer
# seats at the TOP of real iTerm2/Terminal.app windows while every pyte scenario
# bottom-anchors. This script drives the REAL emulator: open a window at a given grid,
# run the dev TUI (--offline, no keys needed) with MINIMA_TUI_DEBUG_ANCHOR, then save
#   <outdir>/probe.jsonl   reserve line + write-tap + DSR cursor row + ledger lines
#   <outdir>/screen.txt    the visible text grid (AppleScript buffer read)
#   <outdir>/window.png    pixel evidence (best effort; needs Screen Recording perm)
# and print a bottom-anchor summary. The bun process is killed by pid file (never
# pgrep — parallel dev sessions must survive), then the window is closed.
#
#   scripts/real_term_capture.sh <terminal|iterm2> <cols> <rows> <outdir>
#   RT_BOOT_WAIT=<secs> to override the idle wait (default 7).
set -euo pipefail

APP="${1:?usage: real_term_capture.sh <terminal|iterm2> <cols> <rows> <outdir>}"
COLS="${2:?cols}"
ROWS="${3:?rows}"
OUT="${4:?outdir}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
rm -f "$OUT/probe.jsonl" "$OUT/screen.txt" "$OUT/window.png" "$OUT/shell.pid"

# RT_ONLINE=1 replicates the user's minima-loc launch: repo-root cwd, .env.harness
# sourced (real routing config), NO --offline. Boot is idle — no turn is run, so no
# provider spend; but the online startup path (db, router init, update checks…) is live.
REPO="$(cd "$ROOT/../.." && pwd)"
PROBE_ENV="MINIMA_TUI_DEBUG_ANCHOR=$OUT/probe.jsonl "
if [ "${RT_NO_PROBE:-0}" = "1" ]; then PROBE_ENV=""; fi
if [ "${RT_ONLINE:-0}" = "1" ]; then
  CMD="cd $REPO && echo \$\$ > $OUT/shell.pid && set -a && . $REPO/.env.harness && set +a && ${PROBE_ENV}exec $BUN run $ROOT/src/cli/main.ts"
else
  CMD="cd $ROOT && echo \$\$ > $OUT/shell.pid && ${PROBE_ENV}exec $BUN run src/cli/main.ts --offline"
fi
# RT_POLLUTE=1 recreates the root-caused failure: a stale DECSTBM scroll region (a
# prior CLI that pinned its composer and died without CSI r). The fixed boot sequence
# must seat at the bottom anyway. The escape lives in a helper file so no backslash
# ever crosses the AppleScript string boundary.
if [ "${RT_POLLUTE:-0}" = "1" ]; then
  printf '\033[5;24r' >"$OUT/pollute.bin"
  CMD="cat $OUT/pollute.bin && $CMD"
fi

case "$APP" in
  terminal)
    WID=$(osascript <<OSA
tell application "Terminal"
  set t to (do script "")
  delay 0.3
  set win to front window
  set number of rows of win to $ROWS
  set number of columns of win to $COLS
  delay 0.3
  do script "$CMD" in t
  return id of win
end tell
OSA
    )
    ;;
  iterm2)
    # RT_FILL=1: fill scrollback + park the shell prompt at the bottom row first — a
    # fresh empty window is NOT how users launch; the failing report came from a
    # well-used session.
    FILL_CMD=""
    if [ "${RT_FILL:-0}" = "1" ]; then
      FILL_CMD="seq -f 'scrollback filler %g' 300"
    fi
    WID=$(osascript <<OSA
tell application "iTerm2"
  set w to (create window with default profile)
  tell current session of w
    set columns to $COLS
    set rows to $ROWS
  end tell
  delay 0.3
  if "$FILL_CMD" is not "" then
    tell current session of w to write text "$FILL_CMD"
    delay 0.7
  end if
  tell current session of w to write text "$CMD"
  return id of w
end tell
OSA
    )
    ;;
  *)
    echo "unknown app: $APP (terminal|iterm2)" >&2
    exit 2
    ;;
esac

sleep "${RT_BOOT_WAIT:-7}"

# RT_TYPE="…" sends a prompt into the RUNNING TUI after boot (iTerm2 only: write text
# writes straight to the session tty). Exercises the commit/decay path — offline without
# keys the turn errors fast, which still commits rows (the physics under test).
if [ -n "${RT_TYPE:-}" ] && [ "$APP" = "iterm2" ]; then
  # newline NO + a separate bare return: iTerm2 sends `write text` WITH its default
  # trailing newline as a bracketed paste (the TUI enables ?2004h), which parks the text
  # in the composer without submitting.
  osascript -e "tell application \"iTerm2\" to tell current session of window id $WID to write text \"$RT_TYPE\" newline NO"
  sleep 0.5
  osascript -e "tell application \"iTerm2\" to tell current session of window id $WID to write text \"\""
  sleep "${RT_TURN_WAIT:-8}"
fi

if [ "$APP" = "terminal" ]; then
  osascript -e "tell application \"Terminal\" to get contents of selected tab of window id $WID" >"$OUT/screen.txt"
  GRID=$(osascript -e "tell application \"Terminal\" to get {number of columns, number of rows} of window id $WID")
else
  osascript -e "tell application \"iTerm2\" to get contents of current session of window id $WID" >"$OUT/screen.txt"
  GRID=$(osascript -e "tell application \"iTerm2\" to tell current session of window id $WID to get {columns, rows}")
fi
screencapture -o -x -l "$WID" "$OUT/window.png" 2>/dev/null || echo "(png capture unavailable — Screen Recording permission)"

if [ -f "$OUT/shell.pid" ]; then
  kill "$(cat "$OUT/shell.pid")" 2>/dev/null || true
fi
sleep 0.5
if [ "$APP" = "terminal" ]; then
  osascript -e "tell application \"Terminal\" to close (window id $WID) saving no" 2>/dev/null || true
else
  osascript -e "tell application \"iTerm2\" to close window id $WID" 2>/dev/null || true
fi

echo "app=$APP requested=${COLS}x${ROWS} actual={$GRID} out=$OUT"
python3 - "$ROWS" "$OUT/screen.txt" "$OUT/probe.jsonl" <<'PY'
import json, sys

rows = int(sys.argv[1])
screen = open(sys.argv[2]).read().split("\n")
while screen and screen[-1].strip() == "":
    screen.pop()
if len(screen) > rows:  # iTerm2 `contents` includes scrollback: keep the visible screen
    screen = screen[-rows:]
    while screen and screen[-1].strip() == "":
        screen.pop()
first = next((i + 1 for i, l in enumerate(screen) if l.strip()), None)
gap = rows - len(screen)
print(f"text rows used: {len(screen)}/{rows}  first nonblank row: {first}  bottom gap: {gap}")
try:
    for ln in open(sys.argv[3]):
        d = json.loads(ln)
        if d.get("phase") in ("reserve", "dsr") or d.get("reset"):
            print("  probe:", ln.strip())
except FileNotFoundError:
    print("  probe: MISSING (app never started?)")
PY
