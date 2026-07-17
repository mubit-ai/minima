#!/usr/bin/env bash
# PTY verification for the INLINE renderer — the only renderer (ADR:
# docs/BigPlan/decision-inline-renderer.md). Scenarios assert the §3 budgets of
# docs/BigPlan/inline-ux-guide.md against real PTY sessions driven through the committed
# mock provider (scripts/mock_openai_sse.ts):
#
#   echo-budget       submitted prompt echoes into the transcript <=0.35s after Enter and
#                     BEFORE any model output (regression guard for the shipped echo fix)
#   stream-wipe-perf  code-heavy streamed reply: exactly ONE ESC[3J in the whole byte
#                     stream (the startup clear, main.ts) — an Ink overflow wipe would add
#                     one — plus render-sample perf budgets
#   resume-scrollback 500-msg resume: no alt-screen (?1049) ever, Ctrl+D exits cleanly,
#                     the transcript persists in the main buffer after exit
#   no-mouse-capture  inline never emits a mouse-capture enable (?1000h/?1002h/?1003h/?1006h)
#                     — swept across every raw stream captured by the suite
#   narrow-55         below the 60-col floor (TOC_MIN_COLS) the one-shot ToC text block
#                     still renders and the app stays alive
#   spike-panel       MP4 gate (guide §7): a near-full live-region panel
#                     (rows - input - status, MINIMA_TUI_SPIKE_PANEL=1) opens over a
#                     500-msg resume, scrolls 200+ steps, and closes — zero extra ESC[3J,
#                     the last grid row never painted, scrollback intact after close
#   bottom-anchor     THE RULE (2026-07-16): the prompt section is mounted at the terminal
#                     bottom — from frame 1 (startup newline reserve + minHeight/flex-end
#                     root, app.tsx) and after content commits (asserted on the echo and
#                     modes scenarios' settled frames)
#
# plus renderer-agnostic coverage ported from the fullscreen-era suite: clipboard
# (bracketed paste + Ctrl+Y OSC 52), modes (Shift+Tab badge ring), shortcuts
# (Home/End/Alt word-jump + Ctrl+Z suspend/resume — inline signature: ?2004l+?25h down,
# ?25l+?2004h back up, never ?1049).
#
# Budgets baselined in docs/BigPlan/shots/inline-baseline/README.md (MP0): steady-state
# renders are ~1-2ms; the one-time 500-msg resume mount was 381ms (own allowance); the
# `window` perf probe is dead code on the inline path so budgets gate on render.ms.
# Wired to `make tui-verify`.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
TUI=$ROOT/packages/tui
TMP=$(mktemp -d)
MOCK_PORT=${MOCK_PORT:-8451}
MOCK_PID=""
trap '[ -n "$MOCK_PID" ] && { kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null || true; }; rm -rf "$TMP"' EXIT

echo "== tui-verify: starting mock provider on :$MOCK_PORT =="
MOCK_PORT=$MOCK_PORT bun "$TUI/scripts/mock_openai_sse.ts" > "$TMP/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$MOCK_PORT/v1/health" > /dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "http://127.0.0.1:$MOCK_PORT/v1/health" > /dev/null || {
  echo "FAIL: mock provider did not come up on :$MOCK_PORT"; cat "$TMP/mock.log"; exit 1; }

INLINE_ARGV='"bun", "run", "'$TUI'/src/cli/main.ts", "--offline", "--model", "mock-model", "--provider", "mock", "--provider-url", "http://127.0.0.1:'$MOCK_PORT'/v1"'

echo "== tui-verify: generating 500-message fixture =="
(cd "$ROOT" && bun run "$TUI/scripts/gen-fixture-session.ts" \
  --db "$TMP/fixture.db" --messages 500 --name fixture-500 > /dev/null)

capture() {
  local name=$1 spec=$2
  uv run --with pyte python "$TUI/scripts/pty_capture.py" "$spec" > "$TMP/$name.txt"
  tail -2 "$TMP/$name.txt"
}

# perf_check <perf.jsonl> <label> <steady-after-ms> — inline render-sample budgets.
# Machine-independent and generous: catch order-of-magnitude regressions, not noise.
# Median/p95 exclude the top-2 samples (resume mount + first <Static> commit are one-time
# costs with their own 1500ms allowance); the spawn-flat window is capped at half the
# recorded span so slow-boot runs still have samples inside it.
perf_check() {
python3 - "$1" "$2" "$3" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
label, steady_ms = sys.argv[2], float(sys.argv[3])
assert rows, f"{label}: no perf samples - MINIMA_TUI_PERF probe not wired?"
rnd = [r for r in rows if r.get("kind") == "render"]
win = [r for r in rows if r.get("kind") == "window"]
assert rnd, f"{label}: no render samples - render probe not wired?"
# The window probe is fullscreen/viewport-only; a sample here means the inline path
# started paying the windowing cost again.
assert not win, f"{label}: {len(win)} window samples on the INLINE path"
rms = sorted(r["ms"] for r in rnd)
steady = rms[: max(1, len(rms) - 2)]
median = steady[len(steady) // 2]
p95 = steady[min(len(steady) - 1, int(len(steady) * 0.95))]
renders = max(r["renders"] for r in rnd)
listeners = {r["stdinListeners"] for r in rnd}
print(f"{label}: samples={len(rnd)} median={median:.2f}ms p95={p95:.1f}ms "
      f"max={rms[-1]:.1f}ms renders={renders} listeners={sorted(listeners)}")
assert median < 30, f"{label}: median render {median:.2f}ms exceeds 30ms"
assert p95 < 100, f"{label}: render p95 {p95:.1f}ms exceeds 100ms (excl. mount)"
assert rms[-1] < 1500, f"{label}: max render {rms[-1]:.1f}ms exceeds the 1500ms mount allowance"
assert renders < 500, f"{label}: {renders} renders - coalescing broken?"
assert max(listeners) <= 3, f"{label}: stdin listener growth: {sorted(listeners)}"
spawn_counts = [r["spawns"] for r in rnd]
assert all(s is not None for s in spawn_counts), f"{label}: Bun.spawnSync counter inactive"
t0, t_last = rows[0]["t"], rnd[-1]["t"]
window = min(steady_ms, (t_last - t0) / 2)
steady_rnd = [r["spawns"] for r in rnd if r["t"] - t0 >= window]
assert steady_rnd, f"{label}: no render samples after the steady window"
assert steady_rnd[-1] == steady_rnd[0], (
    f"{label}: subprocesses forked mid-session: spawns {steady_rnd[0]} -> {steady_rnd[-1]}")
print(f"tui_assert: PASS perf ({label})")
PY
}

echo "== tui-verify: scenario echo-budget (prompt echoes before the delayed reply) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 13,
  "env": {"MINIMA_DB_PATH": "$TMP/echo.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-echo"},
  "frames": "$TMP/echo-frames.jsonl",
  "raw": "$TMP/echo-raw.bin",
  "steps": [
    {"after": 3.0, "send": "SLOW proof: respond only after a delay"},
    {"after": 5.0, "send": "<CR>"}
  ]
}
EOF
)
capture echo "$SPEC"
python3 "$TUI/scripts/tui_assert.py" "$TMP/echo-frames.jsonl" --check echo \
  --enter-after 5 --prompt-text "SLOW proof" --reply-text "Delayed reply" --echo-budget 0.35
python3 "$TUI/scripts/tui_assert.py" "$TMP/echo-frames.jsonl" --after 2.5 \
  --check single-prompt --check advancing --check final-nonblank --check bottom-anchor

echo "== tui-verify: scenario stream-wipe-perf (code-heavy stream, zero extra wipes) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 14,
  "env": {"MINIMA_DB_PATH": "$TMP/stream.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-stream",
          "MINIMA_TUI_PERF": "$TMP/stream-perf.jsonl"},
  "frames": "$TMP/stream-frames.jsonl",
  "raw": "$TMP/stream-raw.bin",
  "steps": [
    {"after": 3.0, "send": "CODE render some snippets"},
    {"after": 4.5, "send": "<CR>"}
  ]
}
EOF
)
capture stream "$SPEC"
python3 - "$TMP/stream-raw.bin" <<'PY'
import sys
raw = open(sys.argv[1], "rb").read()
wipes = raw.count(b"\x1b[3J")
assert wipes == 1, f"{wipes} ESC[3J wipes (expect exactly 1: the startup clear) - Ink overflow wipe fired"
print("tui_assert: PASS zero-wipe (single startup clear, none during the stream)")
PY
python3 "$TUI/scripts/tui_assert.py" "$TMP/stream-frames.jsonl" --after 2.5 \
  --check single-prompt --check advancing --check final-nonblank
perf_check "$TMP/stream-perf.jsonl" stream 4000

echo "== tui-verify: scenario resume-scrollback (500-msg resume, clean Ctrl+D exit) =="
rm -f "$TMP/resume.db" "$TMP/resume.db-wal" "$TMP/resume.db-shm"
cp "$TMP/fixture.db" "$TMP/resume.db"
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV, "--resume", "fixture-500"],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 12,
  "env": {"MINIMA_DB_PATH": "$TMP/resume.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-resume",
          "MINIMA_TUI_PERF": "$TMP/resume-perf.jsonl"},
  "frames": "$TMP/resume-frames.jsonl",
  "raw": "$TMP/resume-raw.bin",
  "steps": [
    {"after": 4.0, "send": "<CTRLT>"},
    {"after": 6.0, "send": "still here"},
    {"after": 7.0, "send": "<CTRLU>"},
    {"after": 8.5, "send": "<CTRLD>"}
  ]
}
EOF
)
capture resume "$SPEC"
python3 - "$TMP/resume-raw.bin" "$TMP/resume-frames.jsonl" <<'PY'
import json, sys
raw = open(sys.argv[1], "rb").read()
assert b"\x1b[?1049" not in raw, "alt-screen sequence on the inline path"
wipes = raw.count(b"\x1b[3J")
assert wipes == 1, f"{wipes} ESC[3J wipes (expect exactly 1: the startup clear)"
# Clean Ctrl+D shutdown: paste-off then cursor-show are main.ts's last writes; a crash or
# the harness SIGKILL never reaches them.
i_paste_off = raw.rfind(b"\x1b[?2004l")
i_cursor = raw.rfind(b"\x1b[?25h")
assert i_paste_off != -1 and i_cursor > i_paste_off, "clean-exit tail (?2004l then ?25h) missing"
frames = [json.loads(l) for l in open(sys.argv[2])]
assert any("Table of contents:" in row for f in frames if f["t"] >= 4.0 for row in f["screen"]), (
    "Ctrl+T toc text block never rendered")
last = frames[-1]["screen"]
assert sum(1 for row in last if row.strip()) >= 5, "transcript gone from the main buffer after exit"
print("tui_assert: PASS resume-scrollback (no alt-screen, clean exit, transcript persists)")
PY
perf_check "$TMP/resume-perf.jsonl" resume 3000

echo "== tui-verify: scenario clipboard (bracketed paste + Ctrl+Y OSC 52) =="
rm -f "$TMP/clip.db" "$TMP/clip.db-wal" "$TMP/clip.db-shm"
cp "$TMP/fixture.db" "$TMP/clip.db"
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV, "--resume", "fixture-500"],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 7,
  "env": {"MINIMA_DB_PATH": "$TMP/clip.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-clip"},
  "raw": "$TMP/clip-raw.bin",
  "steps": [
    {"after": 2.5, "send": "<PASTE>pasted line one\nline two\n<ENDPASTE>"},
    {"after": 4.5, "send": "<CTRLY>"}
  ]
}
EOF
)
capture clip "$SPEC"
grep -q "pasted line one" "$TMP/clip.txt" || { echo "FAIL: paste not in prompt"; exit 1; }
grep -q "▸ you.*pasted line one" "$TMP/clip.txt" && { echo "FAIL: paste auto-submitted"; exit 1; }
grep -q "Copied last reply" "$TMP/clip.txt" || { echo "FAIL: Ctrl+Y feedback missing"; exit 1; }
LC_ALL=C grep -qa "]52;" "$TMP/clip-raw.bin" || { echo "FAIL: no OSC 52 in output stream"; exit 1; }
echo "tui_assert: PASS clipboard (paste captured, no auto-submit, OSC 52 emitted)"

echo "== tui-verify: scenario modes (Shift+Tab badge ring) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 7,
  "env": {"MINIMA_DB_PATH": "$TMP/modes.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-modes"},
  "frames": "$TMP/mode-frames.jsonl",
  "steps": [
    {"after": 2.5, "send": "<SHIFTTAB>"},
    {"after": 4.0, "send": "<SHIFTTAB>"}
  ]
}
EOF
)
capture modes "$SPEC"
python3 - "$TMP/mode-frames.jsonl" <<'PY'
import json, sys
frames = [json.loads(l) for l in open(sys.argv[1])]
def seen(needle, t0, t1):
    return any(needle in row for f in frames if t0 <= f["t"] <= t1 for row in f["screen"])
assert seen("ACCEPT EDITS", 2.5, 4.0), "no ACCEPT EDITS badge after first Shift+Tab"
assert seen("PLAN", 4.0, 99), "no PLAN badge after second Shift+Tab"
print("tui_assert: PASS modes (Shift+Tab cycles accept-edits -> plan badges)")
PY
python3 "$TUI/scripts/tui_assert.py" "$TMP/mode-frames.jsonl" --after 2.5 --check bottom-anchor

echo "== tui-verify: scenario shortcuts (edit keys + inline Ctrl+Z suspend/resume) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 10,
  "env": {"MINIMA_DB_PATH": "$TMP/keys.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-keys"},
  "frames": "$TMP/keys-frames.jsonl",
  "raw": "$TMP/keys-raw.bin",
  "steps": [
    {"after": 3.0, "send": "abc def"},
    {"after": 3.6, "send": "<HOME>"},
    {"after": 3.9, "send": "X"},
    {"after": 4.2, "send": "<END>"},
    {"after": 4.5, "send": "Y"},
    {"after": 4.8, "send": "<ALTB>"},
    {"after": 5.1, "send": "Z"},
    {"after": 6.0, "send": "<CTRLZ>"},
    {"after": 7.5, "signal": "CONT"}
  ]
}
EOF
)
capture keys "$SPEC"
python3 - "$TMP/keys-frames.jsonl" "$TMP/keys-raw.bin" <<'PY'
import json, sys
frames = [json.loads(l) for l in open(sys.argv[1])]
raw = open(sys.argv[2], "rb").read()
# Home/End/Alt+B editing: "abc def" -> X at start -> Y at end -> Z before the last word.
want = "Xabc ZdefY"
assert any(want in row for f in frames if f["t"] >= 5.1 for row in f["screen"]), (
    f"draft {want!r} never appeared - home/end or word-jump broken")
# Inline suspend signature: paste-off + cursor-show down, cursor-hide + paste-on back up.
# Never the alt screen.
assert b"\x1b[?1049" not in raw, "alt-screen sequence during inline suspend/resume"
i_down = raw.find(b"\x1b[?2004l")
assert i_down != -1, "no bracketed-paste-off on Ctrl+Z"
assert raw.find(b"\x1b[?25h", i_down) != -1, "no cursor-show on Ctrl+Z"
i_up = raw.find(b"\x1b[?2004h", i_down)
assert i_up != -1, "no bracketed-paste re-enable after SIGCONT"
post = [f for f in frames if f["t"] >= 7.5]
assert any(want in row for f in post for row in f["screen"]), (
    "draft not visible after resume - repaint after fg broken")
print("tui_assert: PASS shortcuts (edit keys + inline suspend/resume signature)")
PY

echo "== tui-verify: scenario narrow-55 (below the 60-col floor, ToC block still renders) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": 55, "rows": 20, "duration": 8,
  "env": {"MINIMA_DB_PATH": "$TMP/narrow.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-narrow"},
  "frames": "$TMP/narrow-frames.jsonl",
  "steps": [
    {"after": 3.5, "send": "<CTRLT>"}
  ]
}
EOF
)
capture narrow "$SPEC"
python3 - "$TMP/narrow-frames.jsonl" <<'PY'
import json, sys
frames = [json.loads(l) for l in open(sys.argv[1])]
assert any("Table of contents:" in row for f in frames if f["t"] >= 3.5 for row in f["screen"]), (
    "ToC text block did not render below the 60-col floor")
distinct = {tuple(f["screen"]) for f in frames}
assert len(distinct) >= 3, "app frozen at 55 cols"
print("tui_assert: PASS narrow-55 (one-shot ToC block below the floor, app alive)")
PY

echo "== tui-verify: scenario spike-panel (MP4 gate: near-full panel, zero wipes) =="
rm -f "$TMP/spike.db" "$TMP/spike.db-wal" "$TMP/spike.db-shm"
cp "$TMP/fixture.db" "$TMP/spike.db"
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV, "--resume", "fixture-500"],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 13,
  "env": {"MINIMA_DB_PATH": "$TMP/spike.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-spike",
          "MINIMA_TUI_SPIKE_PANEL": "1", "MINIMA_TUI_PERF": "$TMP/spike-perf.jsonl"},
  "frames": "$TMP/spike-frames.jsonl",
  "raw": "$TMP/spike-raw.bin",
  "steps": [
    {"after": 3.5, "send": "<CTRLT>"},
    {"after": 4.0, "send": "jjjjjjjjjj", "repeat": 20, "gap": 0.18},
    {"after": 7.8, "send": "<PGDN>"},
    {"after": 8.1, "send": "<PGUP>"},
    {"after": 8.4, "send": "G"},
    {"after": 8.8, "send": "gg"},
    {"after": 9.5, "send": "<ESC>"},
    {"after": 11.0, "send": "<CTRLD>"}
  ]
}
EOF
)
capture spike "$SPEC"
python3 - "$TMP/spike-raw.bin" "$TMP/spike-frames.jsonl" <<'PY'
import json, sys
raw = open(sys.argv[1], "rb").read()
assert b"\x1b[?1049" not in raw, "alt-screen sequence during panel ops"
wipes = raw.count(b"\x1b[3J")
assert wipes == 1, f"{wipes} ESC[3J wipes (expect exactly 1: the startup clear) - the panel tripped Ink's scrollback wipe"
i_paste_off = raw.rfind(b"\x1b[?2004l")
i_cursor = raw.rfind(b"\x1b[?25h")
assert i_paste_off != -1 and i_cursor > i_paste_off, "clean-exit tail (?2004l then ?25h) missing"

frames = [json.loads(l) for l in open(sys.argv[2])]
def frames_between(t0, t1):
    return [f for f in frames if t0 <= f["t"] < t1]
def grid_has(f, needle):
    return any(needle in row for row in f["screen"])

opened = [f for f in frames if f["t"] >= 3.5 and grid_has(f, "line 001")]
assert opened, "spike panel never opened (no 'line 001' after Ctrl+T)"
open_latency = opened[0]["t"] - 3.5
print(f"spike: open latency {open_latency:.2f}s (budget 0.35s)")
assert open_latency <= 0.35, f"panel open took {open_latency:.2f}s (budget 0.35s)"

assert any(grid_has(f, "❯ line 201") for f in frames_between(7.0, 7.8)), (
    "cursor not at line 201 after 200 j steps - scroll lost keystrokes")
assert any(grid_has(f, "❯ line 201") for f in frames_between(8.1, 8.4)), (
    "PgDn+PgUp did not return the cursor to line 201")
assert any(grid_has(f, "❯ line 500") for f in frames_between(8.4, 8.8)), "G did not jump to the last line"
assert any(grid_has(f, "❯ line 001") for f in frames_between(8.8, 9.5)), "gg did not jump back to the top"

# The wipe-threshold identity: while the panel is open the frame ends at rows-2, so the
# LAST grid row must never be painted. Settled frames only (a pty read can split a write).
settled = [f for i, f in enumerate(frames)
           if i == len(frames) - 1 or frames[i + 1]["t"] - f["t"] >= 0.15]
open_settled = [f for f in settled if 3.9 <= f["t"] <= 9.4 and grid_has(f, "❯ line")]
assert open_settled, "no settled panel frames captured"
for f in open_settled:
    assert not f["screen"][-1].strip(), (
        f"panel painted the last grid row at t={f['t']} - one row from the wipe threshold")
print(f"spike: last-row-clear held across {len(open_settled)} settled panel frames")

closed = [f for f in settled if f["t"] >= 9.7]
assert closed, "no settled frames after close"
assert not any(grid_has(f, "❯ line") for f in closed), "panel still visible after Esc"
last = frames[-1]["screen"]
assert sum(1 for row in last if row.strip()) >= 5, "transcript gone from the main buffer after panel close + exit"
print("tui_assert: PASS spike-panel (zero extra wipes, last row clear, scrollback intact)")
PY
# Post-close, pre-exit: the composer is back on the bottom rows (THE RULE). The window
# opens AT the Esc step (the close render is the only output before Ctrl+D — nothing
# re-renders after it) and ends before Ctrl+D (Ink erases the live region on exit).
python3 "$TUI/scripts/tui_assert.py" "$TMP/spike-frames.jsonl" --after 9.5 --before 10.9 \
  --check bottom-anchor
perf_check "$TMP/spike-perf.jsonl" spike 3000

echo "== tui-verify: no-mouse-capture sweep (every raw stream) =="
python3 - "$TMP"/echo-raw.bin "$TMP"/stream-raw.bin "$TMP"/resume-raw.bin \
          "$TMP"/clip-raw.bin "$TMP"/keys-raw.bin "$TMP"/spike-raw.bin <<'PY'
import sys
BAD = [b"\x1b[?1000h", b"\x1b[?1002h", b"\x1b[?1003h", b"\x1b[?1006h", b"\x1b[?1049h"]
for path in sys.argv[1:]:
    raw = open(path, "rb").read()
    for seq in BAD:
        assert seq not in raw, f"{path}: inline emitted {seq!r}"
print(f"tui_assert: PASS no-mouse-capture ({len(sys.argv) - 1} raw streams clean)")
PY

echo "== tui-verify: PASS =="
