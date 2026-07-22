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
#                     one — plus render-sample perf budgets; also asserts MP11's verbatim
#                     ```bash fence delimiter in the settled frames
#   stream-code-80/60 MP11 acceptance bookends: the same code-heavy stream at 80 cols and
#                     the 60-col floor — fences verbatim, zero extra wipes, budgets hold
#   resume-scrollback 500-msg resume: no alt-screen (?1049) ever, Ctrl+D exits cleanly,
#                     the transcript persists in the main buffer after exit
#   no-mouse-capture  inline never emits a mouse-capture enable (?1000h/?1002h/?1003h/?1006h)
#                     — swept across every raw stream captured by the suite
#   narrow-55         always-panel (2026-07-20): Ctrl+T opens the panel even below the old
#                     60-col text-degrade floor; Esc closes; the app stays alive
#   panel-toc         MP7+MP8 (D3b, geometry certified by the MP4 spike): idle Ctrl+T opens
#                     the near-full ToC panel over a 500-msg resume, browses (j/G/gg),
#                     Enter READS the section in-panel (MP8), h backs out, Esc restores the
#                     composer WITH the draft; busy Ctrl+T mounts the panel OVER the
#                     stream (always-panel) holding the same last-row-clear identity;
#                     zero extra ESC[3J, last grid row never painted
#   tasks-footer      MP5 (D3a): the mock's TODO tool-call populates the task panel
#                     MID-RUN (tasks 1/3 + current task), Ctrl+B hides it, and a second
#                     session on the same prefs dir honors the persisted hide
#   panel-plan-overview          MP9 (D3b plan view): an unanswered 🔴 gate WINS the Ctrl+G chord (no
#                     panel); answering it lets Ctrl+G open the overview; Enter opens the
#                     step card; /why re-opens the panel — same zero-wipe byte gates
#   plan-council      MP14: during a /plan turn the busy row shows the council progress
#                     line advancing role-by-role (researcher → keeper → critic → synth,
#                     canned council replies from the mock via MINIMA_JUDGE_MODEL=
#                     mock-model); the old per-phase transcript pushes are gone; MP15:
#                     a substantive follow-up turn skips the council (one round summary)
#   panel-draft       MP16: /plan-seed rounds show the D3b `plan (draft)` view converging
#                     (round 1 → round 2); /plan finalize --force flips the SAME Ctrl+G
#                     chord to the ledger-backed Plan Overview (structural switch)
#   plan-exit-gate    verification-off, the mock's EXITPLAN marker calls exit_plan(plan) — the
#                     markdown lands in the transcript, the 4-option overlay (CC's
#                     ExitPlanMode shape, auto-accept flavor first) approves into
#                     accept-edits (the tool is the ONLY approval surface); Shift+Tab OUT
#                     of plan mode is a SILENT clean exit (CC parity, 2026-07-20) — the
#                     ring stays fluid and no approval gate ever appears on the chord
#   verify-consent    MP18: first todowrite-with-verify prompts (command shown verbatim),
#                     'a' + the same verify stays silent, a MUTATED verify re-prompts;
#                     headless halves: -p fails CLOSED (gate unrunnable) without
#                     MINIMA_TUI_ALLOW_VERIFY=1 and verifies with it
#   acceptance        MP19: the whole Track W story in ONE scripted run — /plan (council
#                     line ticks) → Ctrl+G draft → /plan finalize approves (seeds
#                     ledger + consent) → PLANDEMO executes: baseline red → done-gate
#                     blocks → write fixes → re-check verifies → plan closes → ToC ⚠→✓ →
#                     overview + step card → /why; perf budgets green during the run
#   bottom-anchor     THE RULE (2026-07-16; anchor ledger 2026-07-20): the prompt section
#                     is mounted at the terminal bottom — from frame 1 (startup newline
#                     reserve, main.ts) and permanently (explicit ledger height on the live
#                     box, app.tsx / layout.ts nextLiveFrameHeight). Slack 1 everywhere
#                     since the ledger (was 3 on the stream scenarios pre-ledger)
#   overlay-anchor    anchor-ledger regressions (2026-07-20, before-evidence in
#   panel-early       docs/BigPlan/shots/anchor-ledger/): permission-overlay teardown over
#   resize-reanchor   a saturated transcript, panel open/close on a SHORT transcript (the
#   big-200x50        other panel scenarios ride the 500-msg fixture where the old decay
#                     was inert), a mid-run PTY shrink (recovery bounded by SCROLLBACK_
#                     SAFETY_ROWS, exact after the next commit), and the reporter's 200x50
#                     geometry where the committed reply wraps to FEWER rows than the
#                     stream-frame shrink (the float the MP20 ordering alone cannot fix)
#   first-prompt      MUB-167: fresh-session first submit — the banner COMMITS into the
#                     transcript with the echo (it stays on screen) and no blank hole is
#                     left where the live banner stood (pre-fix: the echo printed at the
#                     old banner top, mid-screen, ~13 dead rows above the composer)
#   clear-reseat      MUB-169: /clear replays the boot physics — margin reset + 2J/3J +
#                     home + reserve — so the old transcript leaves the screen AND the
#                     scrollback, and the banner re-seats at the terminal bottom. The ONLY
#                     scenario whose wipe budget is 2 (startup 3J + the deliberate /clear
#                     3J); every other scenario keeps the exactly-1 budget
#   stale-margins     the live-window root cause (2026-07-20): a prior CLI's leaked
#                     DECSTBM scroll region survives 2J/3J/H and resizes, imprisons the
#                     newline reserve (DSR said row 24 of 60), and seats the composer
#                     mid-screen forever — boot now leads the clear with CSI r + CSI ?69l
#
# plus renderer-agnostic coverage ported from the fullscreen-era suite: clipboard
# (bracketed paste + Ctrl+Y OSC 52), modes (Shift+Tab badge ring), modes-busy (the badge
# flips MID-STREAM — the global Shift+Tab arm, 2026-07-20), modes-perm (Shift+Tab over
# the permission overlay auto-approves the pending write, Claude Code parity), bash-grants
# (2026-07-21: the bash overlay offers "[a] Always allow `echo` commands" — a per-command-
# family grant, persisted per project via perm_grants.ts; the next same-family bash turn
# runs with NO overlay, and Enter on the overlay ACCEPTS), shortcuts
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

# Hermeticity (suite-wide, was previously acceptance-only): the TUI under test must never
# see real provider keys. An ambient OPENAI_API_KEY makes mapping.defaultModel() prefer a
# REAL provider model over the zero-cost mock, and a lost pinned-routing race then sends
# the turn to the live API — observed as run-to-run scenario flakes (hung "dispatching…"
# turns, missing replies, dirty exit tails) that vanish standalone. Blank rather than
# unset: a defined-empty var also stops the keychain hydration from re-injecting one.
# MUBIT_API_KEY too (2026-07-20): repo-cwd scenarios load the repo's real .env, and a live
# key arms recall-before-route — a REAL Mubit network call before every turn's routing
# (~5-6s stall; the pinned mock resolved at ~10-11s in A/B runs, past tasks-footer's panel
# window). This was the confirmed root cause of the "offline routing stall from repo cwd"
# flake class. With the key defined-empty, createMubitMemory no-ops and routing resolves
# instantly; no scenario may hit the network.
export ANTHROPIC_API_KEY="" ANTHROPIC_OAUTH_TOKEN="" OPENAI_API_KEY="" \
  OPENAI_COMPAT_API_KEY="" GEMINI_API_KEY="" GOOGLE_API_KEY="" GOOGLE_GENAI_API_KEY="" \
  OPENROUTER_API_KEY="" DEEPSEEK_API_KEY="" GROQ_API_KEY="" XAI_API_KEY="" \
  MUBIT_API_KEY=""
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
# Slack 1 (was 3 pre-ledger): the anchor ledger's floor absorbs the busy-row teardown as
# in-frame padding instead of a 2-row float, so the stream scenarios hold the default slack.
# This tightening is the acceptance proof of the structural fix (anchor-ledger, 2026-07-20).
python3 "$TUI/scripts/tui_assert.py" "$TMP/stream-frames.jsonl" --after 2.5 \
  --check single-prompt --check advancing --check final-nonblank \
  --check bottom-anchor --bottom-slack 1
perf_check "$TMP/stream-perf.jsonl" stream 4000
python3 - "$TMP/stream-frames.jsonl" <<'PY'
import json, sys
frames = [json.loads(l) for l in open(sys.argv[1])]
# MP11: fence delimiters render VERBATIM (dim) — the literal ```bash proves the line no
# longer feeds the inline-backtick toggle (pre-MP11 it collapsed to a bare "bash").
# Assert on the LAST frame (frames only exist when the PTY emits output, so a time window
# after the stream settles can be empty).
assert any("```bash" in row for row in frames[-1]["screen"]), (
    "fence delimiter ```bash not rendered verbatim in the settled stream")
print("tui_assert: PASS fence-verbatim (```bash delimiter visible at 120 cols)")
PY

# MP11 acceptance bookends: the same code-heavy stream at 80 and at the 60-col floor
# (TOC_MIN_COLS) — clean fences, zero extra wipes, budgets hold while wrapping is live.
for CW in 80 60; do
echo "== tui-verify: scenario stream-code-$CW (MP11: fenced code at $CW cols) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": $CW, "rows": 36, "duration": 14,
  "env": {"MINIMA_DB_PATH": "$TMP/streamcode$CW.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-streamcode$CW",
          "MINIMA_TUI_PERF": "$TMP/streamcode$CW-perf.jsonl"},
  "frames": "$TMP/streamcode$CW-frames.jsonl",
  "raw": "$TMP/streamcode$CW-raw.bin",
  "steps": [
    {"after": 3.0, "send": "CODE render some snippets"},
    {"after": 4.5, "send": "<CR>"}
  ]
}
EOF
)
capture "streamcode$CW" "$SPEC"
python3 - "$TMP/streamcode$CW-raw.bin" "$TMP/streamcode$CW-frames.jsonl" "$CW" <<'PY'
import json, sys
raw = open(sys.argv[1], "rb").read()
wipes = raw.count(b"\x1b[3J")
assert wipes == 1, f"{wipes} ESC[3J wipes at {sys.argv[3]} cols (expect exactly 1: the startup clear)"
frames = [json.loads(l) for l in open(sys.argv[2])]
# Post-Enter, any frame: at narrow widths the opener scrolls off the settled screen, but it
# always streams through the visible tail — and the pre-MP11 garble shows it in NO frame.
assert any("```bash" in row for f in frames if f["t"] > 4.5 for row in f["screen"]), (
    f"fence delimiter ```bash not rendered verbatim at {sys.argv[3]} cols")
print(f"tui_assert: PASS stream-code-{sys.argv[3]} (zero extra wipes, fence verbatim)")
PY
python3 "$TUI/scripts/tui_assert.py" "$TMP/streamcode$CW-frames.jsonl" --after 2.5 \
  --check single-prompt --check advancing --check final-nonblank \
  --check bottom-anchor --bottom-slack 1
perf_check "$TMP/streamcode$CW-perf.jsonl" "streamcode$CW" 4000
done

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
    {"after": 5.2, "send": "<ESC>"},
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
# Idle Ctrl+T opens the ToC PANEL since MP7 (the text block remains the busy/narrow path).
assert any("contents ·" in row for f in frames if 4.0 <= f["t"] < 5.2 for row in f["screen"]), (
    "Ctrl+T ToC panel never opened on the resumed session")
last = frames[-1]["screen"]
assert sum(1 for row in last if row.strip()) >= 5, "transcript gone from the main buffer after exit"
print("tui_assert: PASS resume-scrollback (no alt-screen, panel open/close, clean exit, transcript persists)")
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

echo "== tui-verify: scenario modes-busy (Shift+Tab flips the badge while a turn streams) =="
# Temp cwd: belt-and-braces. The ~8s "offline routing stall from repo cwd" was root-caused
# 2026-07-20: the repo .env's real MUBIT_API_KEY armed recall-before-route (a live Mubit
# call per turn). The prologue now blanks MUBIT_API_KEY suite-wide, but a bare cwd also
# keeps this scenario independent of whatever the repo's env files grow next.
mkdir -p "$TMP/busywork"
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$TMP/busywork",
  "cols": 120, "rows": 36, "duration": 20,
  "env": {"MINIMA_DB_PATH": "$TMP/modes-busy.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-modes-busy"},
  "frames": "$TMP/modes-busy-frames.jsonl",
  "steps": [
    {"after": 3.5, "send": "SLOW mid-run mode flip"},
    {"after": 4.0, "send": "<CR>"},
    {"after": 4.7, "send": "<SHIFTTAB>"}
  ]
}
EOF
)
capture modes-busy "$SPEC"
python3 - "$TMP/modes-busy-frames.jsonl" <<'PY'
import json, sys
frames = [json.loads(l) for l in open(sys.argv[1])]
def grid_has(screen, needle):
    return any(needle in row for row in screen)
# Fail loud on the mount race: keys typed before Ink mounts are dropped, and a prompt
# that lost its "SLOW" marker gets the instant short reply — every later assert would
# then blame the wrong thing.
assert any(grid_has(f["screen"], "SLOW mid-run mode flip") for f in frames if f["t"] >= 4.0), (
    "typed prompt truncated - the send raced the app mount, retime the steps")
# The SLOW reply's first delta lands ~2.5s after submit, so 4.7-6.3 is a guaranteed
# mid-turn window: the badge must flip there, BEFORE any model output exists (the old
# composer-owned Shift+Tab was disabled the whole time a turn ran).
mid = [f for f in frames if 4.7 <= f["t"] <= 6.3
       and grid_has(f["screen"], "ACCEPT EDITS") and not grid_has(f["screen"], "Delayed reply")]
assert mid, "no ACCEPT EDITS badge while the turn was still streaming"
assert any(grid_has(f["screen"], "Delayed reply") for f in frames if f["t"] >= 6.0), (
    "the delayed reply never arrived - the mode flip disturbed the running turn")
print("tui_assert: PASS modes-busy (Shift+Tab flips the badge mid-stream)")
PY

echo "== tui-verify: scenario modes-perm (Shift+Tab over the permission overlay auto-approves) =="
rm -rf "$TMP/permwork" && mkdir -p "$TMP/permwork"
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$TMP/permwork",
  "cols": 120, "rows": 36, "duration": 18,
  "env": {"MINIMA_DB_PATH": "$TMP/modes-perm.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-modes-perm"},
  "frames": "$TMP/perm-frames.jsonl",
  "steps": [
    {"after": 3.5, "send": "WRITEFILE please"},
    {"after": 4.0, "send": "<CR>"},
    {"after": 6.5, "send": "<SHIFTTAB>"}
  ]
}
EOF
)
capture modes-perm "$SPEC"
python3 - "$TMP/perm-frames.jsonl" <<'PY'
import json, sys
frames = [json.loads(l) for l in open(sys.argv[1])]
def grid_has(screen, needle):
    return any(needle in row for row in screen)
def seen(needle, t0, t1=99.0):
    return any(grid_has(f["screen"], needle) for f in frames if t0 <= f["t"] <= t1)
# Fail loud on the mount race (see modes-busy): a truncated prompt loses the WRITEFILE
# marker and no tool call ever fires.
assert seen("WRITEFILE please", 4.0), (
    "typed prompt truncated - the send raced the app mount, retime the steps")
# The overlay must be parked on screen BEFORE Shift+Tab (no y/a/n is ever sent).
assert seen("run write", 4.0, 6.5), "permission overlay for the write never appeared"
# Claude Code parity: cycling into accept-edits resolves the pending prompt itself.
# Assert on the LAST frame (frames only exist when the PTY emits output — the resolve,
# the write, and the reply can all settle within ~0.2s of the chord, after which the
# screen never changes again and a time-window assert would see zero frames).
last = frames[-1]["screen"]
assert any("ACCEPT EDITS" in row for row in last), (
    "no ACCEPT EDITS badge after Shift+Tab over the overlay")
assert not any(" permission " in row for row in last), (
    "permission overlay still on screen after the mode cycle")
assert seen("File recorded", 5.5), (
    "the write's second-phase reply never arrived - the prompt was not auto-resolved")
print("tui_assert: PASS modes-perm (Shift+Tab auto-approves the pending write)")
PY
test -f "$TMP/permwork/perm_probe.txt" || { echo "FAIL: perm_probe.txt was not written"; exit 1; }
grep -q "mode-cycled approval" "$TMP/permwork/perm_probe.txt" || {
  echo "FAIL: perm_probe.txt content wrong"; exit 1; }
echo "tui_assert: PASS modes-perm file content"

echo "== tui-verify: scenario bash-grants (per-command grant: [a] persists the family, next call silent) =="
rm -rf "$TMP/grantwork" && mkdir -p "$TMP/grantwork"
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$TMP/grantwork",
  "cols": 120, "rows": 36, "duration": 16,
  "env": {"MINIMA_DB_PATH": "$TMP/bash-grants.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-bash-grants"},
  "frames": "$TMP/grant-frames.jsonl",
  "steps": [
    {"after": 3.5, "send": "BASHCMD first run"},
    {"after": 4.0, "send": "<CR>"},
    {"after": 6.5, "send": "a"},
    {"after": 9.5, "send": "BASHCMD second run"},
    {"after": 10.0, "send": "<CR>"}
  ]
}
EOF
)
capture bash-grants "$SPEC"
python3 - "$TMP/grant-frames.jsonl" <<'PY'
import json, sys
frames = [json.loads(l) for l in open(sys.argv[1])]
def grid_has(screen, needle):
    return any(needle in row for row in screen)
def seen(needle, t0, t1=99.0):
    return any(grid_has(f["screen"], needle) for f in frames if t0 <= f["t"] <= t1)
# Fail loud on the mount race: a truncated prompt loses the BASHCMD marker.
assert seen("BASHCMD first run", 4.0), (
    "typed prompt truncated - the send raced the app mount, retime the steps")
# The bash overlay must be up before the 'a', offering the per-FAMILY grant (not the
# whole-tool copy) — the canned command is `echo grant-probe`, so the family is `echo`.
assert seen("Always allow `echo` commands", 4.0, 6.5), (
    "bash overlay missing the per-command-family [a] label before the grant")
# After the grant, the first turn's second-phase reply lands.
assert seen("Command recorded", 6.5, 9.5), (
    "the first bash turn never completed after the [a] grant")
# The second BASHCMD turn matches the persisted `echo` grant: NO overlay, straight to the
# tool + reply. (Frames exist here because the turn itself paints.)
assert not any(
    grid_has(f["screen"], " permission ") for f in frames if 10.0 <= f["t"]
), "the second same-family bash call re-prompted despite the grant"
last = frames[-1]["screen"]
count = sum(1 for row in last if "Command recorded" in row)
assert count >= 2, (
    f"expected both bash turns' replies in the settled frame, saw {count}")
print("tui_assert: PASS bash-grants (family grant label, silent second call)")
PY
python3 "$TUI/scripts/tui_assert.py" "$TMP/grant-frames.jsonl" --after 2.5 \
  --check single-prompt --check final-nonblank --check bottom-anchor --bottom-slack 1

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

echo "== tui-verify: scenario narrow-55 (always-panel: Ctrl+T opens the panel below 60 cols) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": 55, "rows": 20, "duration": 8,
  "env": {"MINIMA_DB_PATH": "$TMP/narrow.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-narrow"},
  "frames": "$TMP/narrow-frames.jsonl",
  "steps": [
    {"after": 3.5, "send": "<CTRLT>"},
    {"after": 5.5, "send": "<ESC>"}
  ]
}
EOF
)
capture narrow "$SPEC"
python3 - "$TMP/narrow-frames.jsonl" <<'PY'
import json, sys
frames = [json.loads(l) for l in open(sys.argv[1])]
def seen(needle, t0, t1=99):
    return any(needle in row for f in frames if t0 <= f["t"] <= t1 for row in f["screen"])
# Always-panel (2026-07-20): the old 60-col text degrade is gone — the panel opens at
# any width the app renders, and Esc still restores the composer.
assert seen("contents ·", 3.5, 5.5), "ToC panel did not open below the old 60-col floor"
assert not seen("Table of contents:", 3.5), "narrow Ctrl+T still printed the text block"
# Last-frame assert: the close repaint can settle within ~0.05s of the Esc, after which
# the screen emits nothing more — a time-window check would see zero frames.
assert not any("contents ·" in row for row in frames[-1]["screen"]), (
    "panel still visible after Esc at 55 cols")
distinct = {tuple(f["screen"]) for f in frames}
assert len(distinct) >= 3, "app frozen at 55 cols"
print("tui_assert: PASS narrow-55 (panel opens below 60 cols, Esc closes, app alive)")
PY

echo "== tui-verify: scenario panel-toc (D3b: open, browse, draft survives, busy opens the panel too) =="
rm -f "$TMP/spike.db" "$TMP/spike.db-wal" "$TMP/spike.db-shm"
cp "$TMP/fixture.db" "$TMP/spike.db"
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV, "--resume", "fixture-500"],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 17.5,
  "env": {"MINIMA_DB_PATH": "$TMP/spike.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-spike",
          "MINIMA_TUI_PERF": "$TMP/spike-perf.jsonl"},
  "frames": "$TMP/spike-frames.jsonl",
  "raw": "$TMP/spike-raw.bin",
  "steps": [
    {"after": 3.5, "send": "draft123"},
    {"after": 4.2, "send": "<CTRLT>"},
    {"after": 4.6, "send": "jjjjjjjjjj", "repeat": 3, "gap": 0.15},
    {"after": 5.6, "send": "G"},
    {"after": 6.0, "send": "gg"},
    {"after": 6.4, "send": "<CR>"},
    {"after": 6.8, "send": "jj"},
    {"after": 7.2, "send": "h"},
    {"after": 7.6, "send": "<ESC>"},
    {"after": 8.4, "send": "<CTRLU>"},
    {"after": 8.6, "send": "SLOW proof while busy"},
    {"after": 9.0, "send": "<CR>"},
    {"after": 9.8, "send": "<CTRLT>"},
    {"after": 14.0, "send": "<ESC>"},
    {"after": 15.2, "send": "<CTRLD>"}
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

LIST = "contents ·"
READER = "contents ▸"
opened = [f for f in frames if f["t"] >= 4.2 and grid_has(f, LIST)]
assert opened, "ToC panel never opened (no breadcrumb after Ctrl+T)"
open_latency = opened[0]["t"] - 4.2
print(f"panel-toc: open latency {open_latency:.2f}s (budget 0.35s)")
assert open_latency <= 0.35, f"panel open took {open_latency:.2f}s (budget 0.35s)"

# Browsing really moves the cursor: the grids inside the open window keep changing.
distinct = {tuple(f["screen"]) for f in frames_between(4.4, 6.3)}
assert len(distinct) >= 4, f"only {len(distinct)} distinct panel grids - j/G/gg navigation dead?"

# MP8: Enter on a section title reads it IN the panel; h backs out to the list.
assert any(grid_has(f, READER) for f in frames_between(6.4, 7.2)), (
    "Enter did not open the in-panel reader (no 'contents ▸' breadcrumb)")
back = [f for f in frames_between(7.2, 7.6) if grid_has(f, LIST) and not grid_has(f, READER)]
assert back, "h did not back out of the reader to the section list"

# The wipe-threshold identity: while the panel is open the frame ends at rows-2, so the
# LAST grid row must never be painted. Settled frames only (a pty read can split a write).
settled = [f for i, f in enumerate(frames)
           if i == len(frames) - 1 or frames[i + 1]["t"] - f["t"] >= 0.15]
open_settled = [f for f in settled
                if 4.4 <= f["t"] <= 7.5 and (grid_has(f, LIST) or grid_has(f, READER))]
assert open_settled, "no settled panel frames captured"
for f in open_settled:
    assert not f["screen"][-1].strip(), (
        f"panel painted the last grid row at t={f['t']} - one row from the wipe threshold")
print(f"panel-toc: last-row-clear held across {len(open_settled)} settled panel frames")

# Esc closes ≤1 frame and the suspended draft SURVIVES into the restored composer.
closed = [f for f in frames_between(7.6, 8.4)
          if not grid_has(f, LIST) and not grid_has(f, READER)]
assert closed, "panel still visible after Esc"
close_latency = closed[0]["t"] - 7.6
print(f"panel-toc: close latency {close_latency:.2f}s (budget 0.35s)")
assert close_latency <= 0.35, f"panel close took {close_latency:.2f}s (budget 0.35s)"
assert any(grid_has(f, "draft123") for f in closed), "composer draft lost across the panel session"

# Always-panel (2026-07-20): busy Ctrl+T mounts the panel OVER the running stream — the
# zero-wipe byte gate above already covers this window, and the settled busy-panel frames
# must hold the same last-row-clear identity as the idle ones.
busy_win = frames_between(9.8, 13.5)
assert any(grid_has(f, LIST) for f in busy_win), "busy Ctrl+T did not mount the ToC panel"
assert not any(grid_has(f, "Table of contents:") for f in busy_win), (
    "busy Ctrl+T still printed the one-shot text block")
busy_settled = [f for f in settled if 10.0 <= f["t"] <= 13.5 and grid_has(f, LIST)]
assert busy_settled, "no settled busy-panel frames captured"
for f in busy_settled:
    assert not f["screen"][-1].strip(), (
        f"busy panel painted the last grid row at t={f['t']} - one row from the wipe threshold")
closed_busy = [f for f in frames_between(14.0, 15.2) if not grid_has(f, LIST)]
assert closed_busy, "panel still visible after the post-stream Esc"

last = frames[-1]["screen"]
assert sum(1 for row in last if row.strip()) >= 5, "transcript gone from the main buffer after panel close + exit"
print("tui_assert: PASS panel-toc (zero extra wipes, reader in-panel, draft survives, busy panel mounts)")
PY
# Post-close, pre-resubmit: the composer is back on the bottom rows (THE RULE) — the
# reseat basis makes the close frame full-height and bottom-anchored.
python3 "$TUI/scripts/tui_assert.py" "$TMP/spike-frames.jsonl" --after 7.6 --before 8.9 \
  --check bottom-anchor
perf_check "$TMP/spike-perf.jsonl" panel-toc 3000

echo "== tui-verify: scenario tasks-footer (D3a: mid-run todos, Ctrl+B, persisted hide) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 14,
  "env": {"MINIMA_DB_PATH": "$TMP/tasks.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-tasks",
          "MINIMA_TUI_BIG_PLAN": "0"},
  "frames": "$TMP/tasks-frames.jsonl",
  "raw": "$TMP/tasks-raw.bin",
  "steps": [
    {"after": 3.0, "send": "TODO plan this work"},
    {"after": 4.5, "send": "<CR>"},
    {"after": 8.0, "send": "a"},
    {"after": 11.2, "send": "<CTRLB>"}
  ]
}
EOF
)
capture tasks "$SPEC"
python3 - "$TMP/tasks-frames.jsonl" <<'PY'
import json, sys
frames = [json.loads(l) for l in open(sys.argv[1])]
def grid_has(f, needle):
    return any(needle in row for row in f["screen"])
# The panel appears MID-RUN (the todowrite lands while the second-phase reply streams;
# the "a" step at 8.0 always-allows the todowrite permission prompt, which shows ~6.7).
shown = [f for f in frames if 8.0 <= f["t"] < 11.2 and grid_has(f, "tasks 1/3")]
assert shown, "task panel (tasks 1/3) never appeared after the TODO tool call"
assert any(grid_has(f, "wire the panel data") for f in shown), (
    "current in_progress task not shown in the panel header")
first = shown[0]["t"]
print(f"tasks-footer: panel first visible at t={first:.2f}s")
settled = [f for i, f in enumerate(frames)
           if i == len(frames) - 1 or frames[i + 1]["t"] - f["t"] >= 0.15]
# The hide render is the only output after the Ctrl+B step — window opens AT the step.
hidden = [f for f in settled if f["t"] >= 11.2]
assert hidden, "no settled frames after Ctrl+B"
assert not any(grid_has(f, "tasks 1/3") for f in hidden), "Ctrl+B did not hide the task panel"
print("tui_assert: PASS tasks-footer (panel mid-run, current task shown, Ctrl+B hides)")
PY
python3 "$TUI/scripts/tui_assert.py" "$TMP/tasks-frames.jsonl" --after 2.5 \
  --check single-prompt --check final-nonblank --check bottom-anchor

echo "== tui-verify: scenario tasks-footer-restart (persisted hide survives; /tasks cancel) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 13.5,
  "env": {"MINIMA_DB_PATH": "$TMP/tasks2.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-tasks",
          "MINIMA_TUI_BIG_PLAN": "0"},
  "frames": "$TMP/tasks2-frames.jsonl",
  "steps": [
    {"after": 3.0, "send": "TODO plan this work"},
    {"after": 4.5, "send": "<CR>"},
    {"after": 8.0, "send": "a"},
    {"after": 10.6, "send": "/tasks cancel"},
    {"after": 11.3, "send": "<CR>"}
  ]
}
EOF
)
capture tasks2 "$SPEC"
python3 - "$TMP/tasks2-frames.jsonl" <<'PY'
import json, sys
frames = [json.loads(l) for l in open(sys.argv[1])]
assert not any("tasks 1/3" in row for f in frames for row in f["screen"]), (
    "persisted hide ignored: the task panel reappeared in a fresh session on the same prefs dir")
assert any("todowrite: 3 tasks" in row for f in frames for row in f["screen"]), (
    "todowrite never ran in the restart session - the hide assert proved nothing")
# The CC-style reject: /tasks cancel clears the list and reports the model was told.
assert any("Cancelled: 3 task(s) cleared" in row
           for f in frames if f["t"] >= 11.3 for row in f["screen"]), (
    "/tasks cancel did not clear + report")
print("tui_assert: PASS tasks-footer-restart (hide persisted; /tasks cancel rejects the list)")
PY

echo "== tui-verify: scenario panel-plan-overview (MP9: gate wins the chord, overview, step card, /why) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 18,
  "env": {"MINIMA_DB_PATH": "$TMP/planoverview.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-planoverview",
          "MINIMA_TUI_BIG_PLAN": "1"},
  "frames": "$TMP/planoverview-frames.jsonl",
  "raw": "$TMP/planoverview-raw.bin",
  "steps": [
    {"after": 3.0, "send": "/bp-seed"},
    {"after": 4.5, "send": "<CR>"},
    {"after": 6.0, "send": "<CTRLG>"},
    {"after": 7.0, "send": "a"},
    {"after": 8.0, "send": "<CTRLG>"},
    {"after": 9.0, "send": "<CR>"},
    {"after": 10.0, "send": "<ESC>"},
    {"after": 10.6, "send": "<ESC>"},
    {"after": 11.2, "send": "/why"},
    {"after": 12.0, "send": "<CR>"},
    {"after": 13.2, "send": "<ESC>"},
    {"after": 13.7, "send": "/tasks cancel"},
    {"after": 14.4, "send": "<CR>"},
    {"after": 15.2, "send": "<CTRLG>"},
    {"after": 16.2, "send": "<CTRLD>"}
  ]
}
EOF
)
capture planoverview "$SPEC"
python3 - "$TMP/planoverview-raw.bin" "$TMP/planoverview-frames.jsonl" <<'PY'
import json, sys
raw = open(sys.argv[1], "rb").read()
assert b"\x1b[?1049" not in raw, "alt-screen sequence during plan panel ops"
wipes = raw.count(b"\x1b[3J")
assert wipes == 1, f"{wipes} ESC[3J wipes (expect exactly 1: the startup clear)"
frames = [json.loads(l) for l in open(sys.argv[2])]
def frames_between(t0, t1):
    return [f for f in frames if t0 <= f["t"] < t1]
def grid_has(f, needle):
    return any(needle in row for row in f["screen"])

PLAN_OVERVIEW_CRUMB = "plan · "
CARD = "plan ▸ step"
# The armed 🔴 gate WINS the chord: from the seed until the answer, Ctrl+G (pressed at
# 6.0) must NOT open the panel — the gate-focus keys own the composer instead. (The
# gate-focus arms at seed time and Ctrl+G re-arms the SAME state, so the window spans
# the whole blocked period: the re-arm may not produce a fresh frame.)
block_win = frames_between(4.5, 7.0)
assert not any(grid_has(f, PLAN_OVERVIEW_CRUMB) for f in block_win), "panel opened over an unanswered 🔴 gate"
assert any(grid_has(f, "[a]ccept") for f in block_win), "gate-focus keys not on the composer"
# Answered → Ctrl+G opens the overview with the full tiered rows.
opened = [f for f in frames_between(8.0, 9.0) if grid_has(f, PLAN_OVERVIEW_CRUMB)]
assert opened, "Ctrl+G did not open the Plan Overview after the gate was answered"
assert any(grid_has(f, "Seed blocked verification") for f in opened), "seeded step titles missing"
# Enter → the step card (shared stepCardLines surface).
assert any(grid_has(f, CARD) for f in frames_between(9.0, 10.0)), "Enter did not open the step card"
# Esc pops card → overview, Esc closes.
assert any(grid_has(f, PLAN_OVERVIEW_CRUMB) and not grid_has(f, CARD) for f in frames_between(10.0, 10.6)), (
    "Esc did not pop the card back to the overview")
closed = [f for f in frames_between(10.6, 11.2) if not grid_has(f, PLAN_OVERVIEW_CRUMB)]
assert closed, "Esc did not close the overview"
# /why re-opens the panel (the primary /why surface in a TTY).
assert any(grid_has(f, PLAN_OVERVIEW_CRUMB) for f in frames_between(12.0, 13.2)), "/why did not open the plan panel"
# /tasks cancel is a REAL reject: the plan closes and NOTHING resurrects it — the D3a
# header disappears and Ctrl+G reports no plan instead of showing the cancelled one.
assert any(grid_has(f, "plan closed") for f in frames_between(14.4, 15.2)), (
    "/tasks cancel did not report closing the plan")
post = frames_between(15.2, 16.2)
assert any(grid_has(f, "No plan recorded") for f in post), (
    "Ctrl+G after cancel did not report an empty ledger")
assert not any(grid_has(f, PLAN_OVERVIEW_CRUMB) for f in post), "plan panel resurrected a cancelled plan"
assert not any(grid_has(f, " plan 3/3 · ▸") for f in post), "D3a header still shows the cancelled plan"
last = frames[-1]["screen"]
assert sum(1 for row in last if row.strip()) >= 5, "transcript gone after exit"
print("tui_assert: PASS panel-plan-overview (gate wins, overview, step card, /why, cancel kills the plan)")
PY

echo "== tui-verify: scenario plan-council (MP14: busy-row council progress line) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 32,
  "env": {"MINIMA_DB_PATH": "$TMP/plancouncil.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-plancouncil",
          "MINIMA_TUI_BIG_PLAN": "1", "MINIMA_JUDGE_MODEL": "mock-model",
          "ANTHROPIC_API_KEY": "", "ANTHROPIC_OAUTH_TOKEN": "", "OPENAI_API_KEY": "",
          "GEMINI_API_KEY": "", "GOOGLE_API_KEY": "", "GOOGLE_GENAI_API_KEY": "",
          "OPENROUTER_API_KEY": "", "DEEPSEEK_API_KEY": "", "GROQ_API_KEY": "", "XAI_API_KEY": ""},
  "frames": "$TMP/plancouncil-frames.jsonl",
  "raw": "$TMP/plancouncil-raw.bin",
  "steps": [
    {"after": 3.0, "send": "/plan start demo council progress"},
    {"after": 3.6, "send": "<CR>"},
    {"after": 4.4, "send": "please research the codebase and draft a plan for the demo"},
    {"after": 5.2, "send": "<CR>"},
    {"after": 18.0, "send": "how should the widget registry interact with the tests you proposed?"},
    {"after": 18.8, "send": "<CR>"},
    {"after": 25.0, "send": "how should the widget registry interact with the tests you proposed?"},
    {"after": 25.8, "send": "<CR>"}
  ]
}
EOF
)
capture plancouncil "$SPEC"
python3 - "$TMP/plancouncil-raw.bin" "$TMP/plancouncil-frames.jsonl" <<'PY'
import json, sys
raw = open(sys.argv[1], "rb").read()
wipes = raw.count(b"\x1b[3J")
assert wipes == 1, f"{wipes} ESC[3J wipes (expect exactly 1: the startup clear)"
frames = [json.loads(l) for l in open(sys.argv[2])]
# The busy row's council line must ADVANCE role-by-role (first-seen strictly ordered).
# MINIMA_JUDGE_MODEL=mock-model points the council meta calls at the mock (otherwise the
# default judge model has no key, every meta call fails fast, and the phases blink by).
# Provider keys are pinned EMPTY in the spec env: spawn.ts unpins children, so the
# researcher would otherwise run the catalog default model — and keychain hydration can
# supply a REAL key on a dev machine (a real network call + nondeterministic seconds of
# latency inside the gate). Empty-but-defined blocks hydration; the child fails fast and
# the round's research digest falls back — real research-through-the-mock is MP19's job.
def first_seen(needle):
    for f in frames:
        if any(needle in row for row in f["screen"]):
            return f["t"]
    return None
stages = [
    "council: researcher …",
    "researcher ✓ · keeper …",
    "keeper ✓ · critic …",
    "critic ✓ · synth …",
]
times = [first_seen(s) for s in stages]
for s, t in zip(stages, times):
    assert t is not None, f"busy row never showed {s!r}"
assert times == sorted(times), f"council phases out of order: {times}"
assert times[-1] - times[0] > 0.5, f"phases blinked by in {times[-1] - times[0]:.2f}s - meta calls not hitting the mock"
# MP14 dropped the per-phase transcript pushes - the round-summary note is the record.
assert not any("· scope:" in row or "· research:" in row for f in frames for row in f["screen"]), (
    "old per-phase council transcript pushes still render")
assert any("council cost $" in row for f in frames for row in f["screen"]), (
    "round-summary council note missing")
# MP15: the substantive FOLLOW-UP turn is not plan-stakes - it goes straight to the
# planner (+ silent keeper mini-update): no council busy line after it submits and no
# second round summary. Anchored to the ACTUAL submission frame, not wall-clock (under
# load turn 1's council can still be live at the scripted send time, false-positiving a
# wall-clock window on ITS busy line — and keys typed while busy are eaten, so the send
# is RETRIED at 25.0; a doubled submission is harmless: every follow-up is non-stakes,
# the councils-stay-at-one invariant is exactly what is asserted).
FOLLOWUP = "how should the widget registry"
t_submit = None
for f in frames:
    if any(FOLLOWUP in row and "▋" not in row for row in f["screen"]) and f["t"] > 18.0:
        t_submit = f["t"]
        break
assert t_submit is not None, "follow-up turn never rendered - bump the step times"
assert any(
    "Baseline reply" in row for f in frames if f["t"] <= t_submit for row in f["screen"]
), "turn 1 had not completed before the follow-up - bump the step times"
assert not any(
    "council: researcher" in row for f in frames if f["t"] > t_submit for row in f["screen"]
), "follow-up turn re-convened the council (MP15 conditional convening broken)"
cost_rows = {row.strip() for f in frames for row in f["screen"] if "council cost $" in row}
assert len(cost_rows) == 1, f"expected ONE council round summary, saw: {cost_rows}"
print("tui_assert: PASS plan-council (line advances role-by-role; follow-up skips the council)")
PY
# Anchor-ledger coverage: the council children's ChildTree teardown is a live-frame shrink
# the old design floated on. Slack 2 (settled frames, whole run): plan-mode transitions
# oscillate a row; the defect class this catches floats 5+.
python3 "$TUI/scripts/tui_assert.py" "$TMP/plancouncil-frames.jsonl" --after 2.5 \
  --check final-nonblank --check bottom-anchor --bottom-slack 2

echo "== tui-verify: scenario panel-draft (MP16: D3b plan-draft view, round-over-round) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$TMP",
  "cols": 120, "rows": 36, "duration": 18,
  "env": {"MINIMA_DB_PATH": "$TMP/plandraft.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-plandraft",
          "MINIMA_TUI_BIG_PLAN": "1", "MINIMA_JUDGE_MODEL": "mock-model",
          "ANTHROPIC_API_KEY": "", "ANTHROPIC_OAUTH_TOKEN": "", "OPENAI_API_KEY": "",
          "GEMINI_API_KEY": "", "GOOGLE_API_KEY": "", "GOOGLE_GENAI_API_KEY": "",
          "OPENROUTER_API_KEY": "", "DEEPSEEK_API_KEY": "", "GROQ_API_KEY": "", "XAI_API_KEY": ""},
  "frames": "$TMP/plandraft-frames.jsonl",
  "raw": "$TMP/plandraft-raw.bin",
  "steps": [
    {"after": 3.0, "send": "/plan-seed"},
    {"after": 3.5, "send": "<CR>"},
    {"after": 4.2, "send": "<CTRLG>"},
    {"after": 5.0, "send": "jj"},
    {"after": 5.4, "send": "G"},
    {"after": 5.8, "send": "gg"},
    {"after": 6.2, "send": "<ESC>"},
    {"after": 7.0, "send": "/plan-seed"},
    {"after": 7.4, "send": "<CR>"},
    {"after": 8.0, "send": "<CTRLG>"},
    {"after": 8.8, "send": "<ESC>"},
    {"after": 9.6, "send": "/plan finalize --force"},
    {"after": 10.2, "send": "<CR>"},
    {"after": 15.5, "send": "<CTRLG>"},
    {"after": 17.0, "send": "<ESC>"}
  ]
}
EOF
)
capture plandraft "$SPEC"
python3 - "$TMP/plandraft-raw.bin" "$TMP/plandraft-frames.jsonl" <<'PY'
import json, sys
raw = open(sys.argv[1], "rb").read()
assert b"\x1b[?1049" not in raw, "alt-screen sequence during draft panel ops"
wipes = raw.count(b"\x1b[3J")
assert wipes == 1, f"{wipes} ESC[3J wipes (expect exactly 1: the startup clear)"
frames = [json.loads(l) for l in open(sys.argv[2])]
def win(t0, t1):
    return [f for f in frames if t0 <= f["t"] < t1]
def has(f, needle):
    return any(needle in row for row in f["screen"])
# Round 1 draft view: crumb + the seeded step text; the cursor moves during nav.
r1 = [f for f in win(4.2, 6.2) if has(f, "plan (draft) · round 1")]
assert r1, "Ctrl+G did not open the round-1 draft view"
assert any(has(f, "Scaffold") for f in r1), "seeded draft steps missing from the view"
cursors = {i for f in r1 for i, row in enumerate(f["screen"]) if "❯" in row}
assert len(cursors) >= 2, f"draft cursor never moved during nav (rows {cursors})"
# Round 2: same chord, richer snapshot.
assert any(has(f, "plan (draft) · round 2") for f in win(8.0, 9.0)), (
    "second seed did not show round 2 in the draft view")
# After finalize the SAME chord opens the ledger-backed Plan Overview (structural switch).
post = win(15.5, 17.0)
assert any(has(f, "plan · ") for f in post), "post-finalize Ctrl+G did not open the Plan Overview"
assert not any(has(f, "plan (draft)") for f in post), "draft view survived finalize"
print("tui_assert: PASS panel-draft (round 1 -> round 2 -> finalize flips to the Plan Overview)")
PY

echo "== tui-verify: scenario plan-exit-gate (exit_plan tool gate; Shift+Tab is a silent exit) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$TMP",
  "cols": 120, "rows": 36, "duration": 22,
  "env": {"MINIMA_DB_PATH": "$TMP/planexit.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-planexit",
          "MINIMA_TUI_BIG_PLAN": "0"},
  "frames": "$TMP/planexit-frames.jsonl",
  "raw": "$TMP/planexit-raw.bin",
  "steps": [
    {"after": 3.0, "send": "<SHIFTTAB>"},
    {"after": 3.4, "send": "<SHIFTTAB>"},
    {"after": 4.0, "send": "EXITPLAN draft the sandbox cleanup plan"},
    {"after": 4.8, "send": "<CR>"},
    {"after": 8.0, "send": "<CR>"},
    {"after": 11.0, "send": "<SHIFTTAB>"},
    {"after": 12.0, "send": "please describe the cleanup approach once more"},
    {"after": 12.8, "send": "<CR>"},
    {"after": 16.5, "send": "<SHIFTTAB>"},
    {"after": 18.0, "send": "<SHIFTTAB>"},
    {"after": 18.6, "send": "<SHIFTTAB>"},
    {"after": 19.4, "send": "<SHIFTTAB>"}
  ]
}
EOF
)
capture planexit "$SPEC"
python3 - "$TMP/planexit-raw.bin" "$TMP/planexit-frames.jsonl" <<'PY'
import json, sys
raw = open(sys.argv[1], "rb").read()
assert b"\x1b[?1049" not in raw, "alt-screen sequence during exit-gate ops"
wipes = raw.count(b"\x1b[3J")
assert wipes == 1, f"{wipes} ESC[3J wipes (expect exactly 1: the startup clear)"
frames = [json.loads(l) for l in open(sys.argv[2])]
def win(t0, t1):
    return [f for f in frames if t0 <= f["t"] < t1]
def has(f, n):
    return any(n in row for row in f["screen"])
# The model's exit_plan(plan) call: the plan markdown lands in the transcript and the
# 4-option approval overlay opens (CC's ExitPlanMode shape — auto-accept flavor FIRST);
# Enter approves the default = auto-accept, so approval lands in accept-edits mode
# (plan verification off, no BigPlan.md — approval is the mode flip).
tool = win(4.85, 8.0)
assert any(has(f, "Sandbox cleanup plan") for f in tool), "plan markdown not shown before the ask"
assert any(has(f, "auto-accept edits") for f in tool), "approval overlay missing the auto-accept flavor"
assert any(has(f, "Finalize & build") for f in tool), "approval overlay missing the plain-build flavor"
approved = win(8.0, 10.5)
assert any(has(f, "Plan approved") for f in approved), "approve did not surface the approval message"
# Settled-state check (frames only exist on output, and mode-flip repaints straggle
# under load): the LAST frame before plan re-entry at t=11 is the settled post-approval
# screen — PLAN gone, ACCEPT EDITS on (the auto-accept landing).
pre_reentry = [f for f in frames if f["t"] < 11.0]
assert pre_reentry, "no frames before plan re-entry"
assert not has(pre_reentry[-1], "[PLAN]"), "PLAN badge survived approval (settled frame)"
assert has(pre_reentry[-1], "ACCEPT EDITS"), "auto-accept approval did not land in accept-edits"
# One chord re-enters plan from accept-edits (the ring: … → acceptEdits → plan).
assert any(has(f, "[PLAN]") for f in win(11.0, 12.8)), "chord did not re-enter plan from accept-edits"
# Shift+Tab OUT of plan mode is a SILENT clean exit (Claude Code parity) — the ring just
# advances, no dialog ever. 16.5 exits plan (badge gone), 18.0/18.6 ride build→accept→plan,
# 19.4 exits again: no chord may ever surface the approval gate (neither the legacy
# "Exit plan mode?" question nor the exit_plan tool's Finalize options).
assert not any(has(f, "Exit plan mode?") for f in frames), (
    "the deleted Shift+Tab exit gate resurfaced")
assert not any(has(f, "Finalize &") for f in win(16.5, 99.0)), (
    "Shift+Tab opened an approval gate - it must be a silent mode cycle")
exited = [f for f in win(16.5, 18.0)]
assert exited and not has(exited[-1], "[PLAN]"), "PLAN badge survived the silent exit (settled frame)"
assert any(has(f, "ACCEPT EDITS") for f in win(18.0, 18.6)), "ring did not advance to accept-edits"
assert any(has(f, "[PLAN]") for f in win(18.6, 19.4)), "ring did not re-enter plan mode"
assert not has(frames[-1], "[PLAN]"), "PLAN badge survived the final silent exit (settled frame)"
print("tui_assert: PASS plan-exit-gate (4-option tool gate + auto-accept landing; silent chord + fluid ring)")
PY

echo "== tui-verify: scenario verify-consent (MP18: first-run prompt, silence, mutation re-prompt) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$TMP",
  "cols": 120, "rows": 36, "duration": 22,
  "env": {"MINIMA_DB_PATH": "$TMP/vconsent.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-vconsent",
          "MINIMA_TUI_BIG_PLAN": "1", "MINIMA_TUI_STOP_STRIKES": "0"},
  "frames": "$TMP/vconsent-frames.jsonl",
  "raw": "$TMP/vconsent-raw.bin",
  "steps": [
    {"after": 3.0, "send": "TODOV record the demo step"},
    {"after": 3.8, "send": "<CR>"},
    {"after": 7.0, "send": "a"},
    {"after": 9.5, "send": "TODOV record the demo step once more"},
    {"after": 10.3, "send": "<CR>"},
    {"after": 14.0, "send": "TODOVSWAP mutate the verify now"},
    {"after": 14.8, "send": "<CR>"},
    {"after": 18.0, "send": "a"}
  ]
}
EOF
)
capture vconsent "$SPEC"
python3 - "$TMP/vconsent-raw.bin" "$TMP/vconsent-frames.jsonl" <<'PY'
import json, sys
raw = open(sys.argv[1], "rb").read()
wipes = raw.count(b"\x1b[3J")
assert wipes == 1, f"{wipes} ESC[3J wipes (expect exactly 1: the startup clear)"
frames = [json.loads(l) for l in open(sys.argv[2])]
def win(t0, t1):
    return [f for f in frames if t0 <= f["t"] < t1]
def has(f, n):
    return any(n in row for row in f["screen"])
# First TODOV: the overlay shows the verify as a shell command; 'a' grants allow-always.
# (Stop-strikes are disabled in this scenario's env: an armed in_progress step otherwise
# spirals the plan-not-done nag through every later turn and eats the scripted sends.)
assert any(has(f, "echo consent-ok") for f in win(3.8, 7.0)), (
    "first-run overlay did not show the verify command")
# Second TODOV (same verify, always granted): NO overlay between submit and the reply.
second = win(10.4, 14.0)
assert second and not any(has(f, "verify (runs as a shell command)") for f in second), (
    "an already-approved verify re-prompted")
# TODOVSWAP (mutated verify): the overlay RE-PROMPTS with the new command. Window opens
# AT the CR step (14.8): with MUBIT_API_KEY blanked suite-wide the pre-route recall is
# gone and the overlay can paint <0.1s after submit — a later window start sees zero
# frames (frames exist only on output) and misses the one overlay repaint.
assert any(has(f, "echo consent-swapped") for f in win(14.5, 18.0)), (
    "a mutated verify did not re-prompt")
print("tui_assert: PASS verify-consent (first-run prompt, silent repeat, mutation re-prompt)")
PY

echo "== tui-verify: scenario headless-verify-consent (MP18: -p fails closed without opt-in) =="
rm -f "$TMP/hconsent.db" "$TMP/hconsent.db-wal" "$TMP/hconsent.db-shm"
MINIMA_DB_PATH="$TMP/hconsent.db" MINIMA_HARNESS_DIR="$TMP/prefs-hconsent" MINIMA_TUI_BIG_PLAN=1 \
  bun run "$TUI/src/cli/main.ts" --offline --model mock-model --provider mock \
  --provider-url "http://127.0.0.1:$MOCK_PORT/v1" -p "TODOVDONE claim the step is done" > "$TMP/hconsent.out" 2>&1 || true
python3 - "$TMP/hconsent.db" <<'PY'
import sqlite3, sys
rows = sqlite3.connect(sys.argv[1]).execute(
    "SELECT outcome FROM gates WHERE kind = 'step_check'").fetchall()
assert rows and all(r[0] == "unrunnable" for r in rows), (
    f"headless deny-all should block the gate as unrunnable, got {rows}")
print("tui_assert: PASS headless fail-closed (gate unrunnable, verify never ran)")
PY
rm -f "$TMP/hconsent2.db" "$TMP/hconsent2.db-wal" "$TMP/hconsent2.db-shm"
MINIMA_DB_PATH="$TMP/hconsent2.db" MINIMA_HARNESS_DIR="$TMP/prefs-hconsent2" MINIMA_TUI_BIG_PLAN=1 \
  MINIMA_TUI_ALLOW_VERIFY=1 \
  bun run "$TUI/src/cli/main.ts" --offline --model mock-model --provider mock \
  --provider-url "http://127.0.0.1:$MOCK_PORT/v1" -p "TODOVDONE claim the step is done" > "$TMP/hconsent2.out" 2>&1 || true
python3 - "$TMP/hconsent2.db" <<'PY'
import sqlite3, sys
rows = sqlite3.connect(sys.argv[1]).execute(
    "SELECT outcome FROM gates WHERE kind = 'step_check'").fetchall()
assert rows and all(r[0] == "verified" for r in rows), (
    f"MINIMA_TUI_ALLOW_VERIFY=1 should let the gate verify, got {rows}")
print("tui_assert: PASS headless opt-in (MINIMA_TUI_ALLOW_VERIFY=1 gate verified)")
PY

echo "== tui-verify: scenario acceptance (MP19: the whole Track W story, one scripted run) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$TMP",
  "cols": 120, "rows": 40, "duration": 42,
  "env": {"MINIMA_DB_PATH": "$TMP/accept.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-accept",
          "MINIMA_TUI_BIG_PLAN": "1", "MINIMA_JUDGE_MODEL": "mock-model",
          "MINIMA_TUI_PERF": "$TMP/accept-perf.jsonl",
          "ANTHROPIC_API_KEY": "", "ANTHROPIC_OAUTH_TOKEN": "", "OPENAI_API_KEY": "",
          "GEMINI_API_KEY": "", "GOOGLE_API_KEY": "", "GOOGLE_GENAI_API_KEY": "",
          "OPENROUTER_API_KEY": "", "DEEPSEEK_API_KEY": "", "GROQ_API_KEY": "", "XAI_API_KEY": ""},
  "frames": "$TMP/accept-frames.jsonl",
  "raw": "$TMP/accept-raw.bin",
  "steps": [
    {"after": 3.0, "send": "/plan start build the demo widget"},
    {"after": 3.6, "send": "<CR>"},
    {"after": 4.4, "send": "please research and draft the demo widget plan"},
    {"after": 5.2, "send": "<CR>"},
    {"after": 12.5, "send": "<CTRLG>"},
    {"after": 14.0, "send": "<ESC>"},
    {"after": 15.0, "send": "/plan finalize"},
    {"after": 15.6, "send": "<CR>"},
    {"after": 20.0, "send": "PLANDEMO build it now"},
    {"after": 20.8, "send": "<CR>"},
    {"after": 23.5, "send": "a"},
    {"after": 27.0, "send": "a"},
    {"after": 31.0, "send": "<CTRLT>"},
    {"after": 33.0, "send": "<ESC>"},
    {"after": 34.0, "send": "<CTRLG>"},
    {"after": 35.5, "send": "<CR>"},
    {"after": 37.0, "send": "<ESC>"},
    {"after": 37.6, "send": "<ESC>"},
    {"after": 38.5, "send": "/why"},
    {"after": 39.1, "send": "<CR>"}
  ]
}
EOF
)
capture accept "$SPEC"
python3 - "$TMP/accept-raw.bin" "$TMP/accept-frames.jsonl" <<'PY'
import json, sys
raw = open(sys.argv[1], "rb").read()
assert b"\x1b[?1049" not in raw, "alt-screen sequence during the acceptance run"
wipes = raw.count(b"\x1b[3J")
assert wipes == 1, f"{wipes} ESC[3J wipes (expect exactly 1: the startup clear)"
frames = [json.loads(l) for l in open(sys.argv[2])]
def has(f, n):
    return any(n in row for row in f["screen"])
def first(n, t0=0.0):
    for f in frames:
        if f["t"] >= t0 and has(f, n):
            return f["t"]
    return None
# The story, in order: council line ticks -> the draft is visible -> /plan finalize
# approves into build (badge gone by the execution prompt) -> the done-gate
# blocks the early completion -> the fix lands -> the re-check verifies -> the ToC carries
# the failed-then-fixed marker -> the overview + step card show the verified step -> /why.
beats = [
    ("council line", first("council: researcher")),
    ("draft view", first("plan (draft) · round 1", 12.0)),
    ("finalize note", first("Plan written", 15.0)),
    ("verify in todowrite overlay", first("test -f demo_widget.ts", 20.0)),
    ("gate blocked red", first("Step not verified", 21.0)),
    ("the fix (write overlay)", first("run write", 21.0)),
    ("gate green + plan closed", first("Demo complete", 24.0)),
    ("ToC failed-then-fixed", first("⚠→✓", 30.0)),
    ("overview verified step", first("✅", 33.5)),
    ("step card", first("plan ▸ step 1", 35.0)),
    ("why evidence", first("test -f demo_widget.ts", 38.5)),
]
missing = [name for name, t in beats if t is None]
assert not missing, f"acceptance beats missing: {missing}"
order = [t for _, t in beats]
assert order == sorted(order), f"acceptance beats out of order: {beats}"
pre_exec = [f for f in frames if f["t"] < 20.0]
assert pre_exec and not has(pre_exec[-1], "[PLAN]"), (
    "approval did not flip plan mode off before the execution prompt")
print("tui_assert: PASS acceptance (plan -> draft -> gate -> red -> fix -> green -> evidence)")
PY
perf_check "$TMP/accept-perf.jsonl" accept 4000

echo "== tui-verify: scenario overlay-anchor (ledger: perm teardown over a saturated transcript) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 23,
  "env": {"MINIMA_DB_PATH": "$TMP/otanchor.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-otanchor",
          "MINIMA_TUI_BIG_PLAN": "0"},
  "frames": "$TMP/otanchor-frames.jsonl",
  "raw": "$TMP/otanchor-raw.bin",
  "steps": [
    {"after": 3.0, "send": "CODE saturate the transcript"},
    {"after": 3.6, "send": "<CR>"},
    {"after": 12.0, "send": "TODO plan this work"},
    {"after": 12.5, "send": "<CR>"},
    {"after": 16.5, "send": "<CR>"},
    {"after": 19.5, "send": "<CR>"}
  ]
}
EOF
)
capture otanchor "$SPEC"
python3 - "$TMP/otanchor-raw.bin" "$TMP/otanchor-frames.jsonl" <<'PY'
import json, sys
raw = open(sys.argv[1], "rb").read()
wipes = raw.count(b"\x1b[3J")
assert wipes == 1, f"{wipes} ESC[3J wipes (expect exactly 1: the startup clear)"
frames = [json.loads(l) for l in open(sys.argv[2])]
# Liveness: the todowrite permission overlay must actually have appeared — otherwise the
# teardown under test never ran and the anchor gate below passes vacuously. The approve key
# is Enter (2026-07-21: pins key.return→"Yes once" in a real PTY — the only scripted
# approval in this scenario, so a regression parks the overlay forever and the settled
# assert below fails). It is retried at 19.5 because keys typed while busy are eaten under
# load (plan-council precedent); a post-approve CR on the empty composer is a no-op.
assert any("permission" in row for f in frames for row in f["screen"]), (
    "the todowrite permission overlay never appeared - mock too slow? bump step times")
assert not any(" permission " in row for row in frames[-1]["screen"]), (
    "the permission overlay never resolved - Enter did not accept the pending call")
print("tui_assert: PASS overlay-anchor liveness (zero extra wipes, perm overlay Enter-approved)")
PY
# Enter approves the todowrite permission overlay (~10-16 rows) → its teardown is the
# shrink under test. Pre-ledger: composer stranded 3 rows up (before-evidence shots).
python3 "$TUI/scripts/tui_assert.py" "$TMP/otanchor-frames.jsonl" --after 2.5 \
  --check single-prompt --check final-nonblank --check bottom-anchor --bottom-slack 1

echo "== tui-verify: scenario panel-early (ledger: Ctrl+T open/close on a SHORT transcript) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 14,
  "env": {"MINIMA_DB_PATH": "$TMP/pearly.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-pearly"},
  "frames": "$TMP/pearly-frames.jsonl",
  "raw": "$TMP/pearly-raw.bin",
  "steps": [
    {"after": 3.0, "send": "CODE hello"},
    {"after": 3.6, "send": "<CR>"},
    {"after": 8.5, "send": "<CTRLT>"},
    {"after": 9.5, "send": "j"},
    {"after": 10.5, "send": "<ESC>"}
  ]
}
EOF
)
capture pearly "$SPEC"
python3 - "$TMP/pearly-raw.bin" "$TMP/pearly-frames.jsonl" <<'PY'
import json, sys
raw = open(sys.argv[1], "rb").read()
wipes = raw.count(b"\x1b[3J")
assert wipes == 1, f"{wipes} ESC[3J wipes (expect exactly 1: the startup clear)"
frames = [json.loads(l) for l in open(sys.argv[2])]
# The panel must have actually opened (contents title) — otherwise the close shrink under
# test never happened and the anchor assert below passes vacuously.
assert any("contents" in row for f in frames if 8.5 <= f["t"] <= 10.5 for row in f["screen"]), (
    "ToC panel never opened on the short transcript")
print("tui_assert: PASS panel-early (panel opened, zero extra wipes)")
PY
python3 "$TUI/scripts/tui_assert.py" "$TMP/pearly-frames.jsonl" --after 2.5 \
  --check final-nonblank --check bottom-anchor --bottom-slack 1

echo "== tui-verify: scenario resize-reanchor (ledger: mid-run PTY shrink recovers) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": 120, "rows": 40, "duration": 17,
  "env": {"MINIMA_DB_PATH": "$TMP/resizere.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-resizere"},
  "frames": "$TMP/resizere-frames.jsonl",
  "raw": "$TMP/resizere-raw.bin",
  "steps": [
    {"after": 3.0, "send": "CODE hello"},
    {"after": 3.6, "send": "<CR>"},
    {"after": 8.5, "resize": [120, 32]},
    {"after": 10.5, "send": "SLOW again"},
    {"after": 11.0, "send": "<CR>"}
  ]
}
EOF
)
capture resizere "$SPEC"
python3 - "$TMP/resizere-raw.bin" <<'PY'
import sys
raw = open(sys.argv[1], "rb").read()
wipes = raw.count(b"\x1b[3J")
# <= 2, not == 1: Ink re-renders the OLD tree against the new rows on resize — if that
# frame no longer fits, its clearTerminal is unavoidable without patching Ink. The ledger's
# job is RECOVERY (the asserts below), not preventing this one wipe.
assert wipes <= 2, f"{wipes} ESC[3J wipes (expect <=2: startup clear + at most Ink's resize wipe)"
print(f"tui_assert: PASS resize-wipes ({wipes} total)")
PY
# Post-resize: the cap-seeded frame re-anchors within SCROLLBACK_SAFETY_ROWS (pre-ledger
# this was a PERMANENT float — the app repainted once and never re-anchored). Window opens
# AT the resize step (8.5): with the suite's Mubit key blanked the CODE turn finishes
# before ~8.6, so the only guaranteed output in this window is the resize repaint itself
# (~0.05s after the step) — a later window start sees zero frames and errors out.
python3 "$TUI/scripts/tui_assert.py" "$TMP/resizere-frames.jsonl" --after 8.5 --before 10.4 \
  --check bottom-anchor --bottom-slack 2
# ...and the next commit re-pins it exactly.
python3 "$TUI/scripts/tui_assert.py" "$TMP/resizere-frames.jsonl" --after 12.0 \
  --check final-nonblank --check bottom-anchor --bottom-slack 1

echo "== tui-verify: scenario big-200x50 (ledger: reporter geometry, wide-terminal stream commit) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": 200, "rows": 50, "duration": 14,
  "env": {"MINIMA_DB_PATH": "$TMP/big200.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-big200",
          "MINIMA_TUI_PERF": "$TMP/big200-perf.jsonl"},
  "frames": "$TMP/big200-frames.jsonl",
  "raw": "$TMP/big200-raw.bin",
  "steps": [
    {"after": 3.0, "send": "CODE render some snippets"},
    {"after": 4.5, "send": "<CR>"}
  ]
}
EOF
)
capture big200 "$SPEC"
python3 - "$TMP/big200-raw.bin" <<'PY'
import sys
raw = open(sys.argv[1], "rb").read()
wipes = raw.count(b"\x1b[3J")
assert wipes == 1, f"{wipes} ESC[3J wipes (expect exactly 1: the startup clear)"
print("tui_assert: PASS zero-wipe (big-200x50)")
PY
# At 200 cols the committed reply wraps to FEWER rows than the stream-frame shrink it must
# compensate — the float the MP20 commit ordering alone could not fix (before-evidence:
# lowest row 42/50 sustained from the commit). The ledger's floor must hold slack 1 THROUGH
# the commit, at the reporter's exact geometry.
python3 "$TUI/scripts/tui_assert.py" "$TMP/big200-frames.jsonl" --after 2.5 \
  --check single-prompt --check advancing --check final-nonblank \
  --check bottom-anchor --bottom-slack 1
perf_check "$TMP/big200-perf.jsonl" big200 4000

echo "== tui-verify: scenario first-prompt (MUB-167: banner commits with the first echo, no mid-frame hole) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 11,
  "env": {"MINIMA_DB_PATH": "$TMP/firstprompt.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-firstprompt"},
  "frames": "$TMP/firstprompt-frames.jsonl",
  "raw": "$TMP/firstprompt-raw.bin",
  "steps": [
    {"after": 3.0, "send": "SLOW first prompt of a fresh session"},
    {"after": 4.0, "send": "<CR>"}
  ]
}
EOF
)
capture firstprompt "$SPEC"
python3 - "$TMP/firstprompt-frames.jsonl" <<'PY'
import json, sys
frames = [json.loads(l) for l in open(sys.argv[1])]
def grid_has(f, needle):
    return any(needle in row for row in f["screen"])
# Pre-submit: the live banner is on screen.
assert any(grid_has(f, "██") for f in frames if f["t"] < 4.0), "MINIMA banner never rendered on the fresh session"
settled = [f for i, f in enumerate(frames)
           if i == len(frames) - 1 or frames[i + 1]["t"] - f["t"] >= 0.15]
post = [f for f in settled if f["t"] >= 4.2 and grid_has(f, "▸ you")]
assert post, "no settled frames with the echoed prompt after submit"
# The banner COMMITTED with the echo: it stays on screen above the transcript instead of
# being erased into a dead-padding hole.
assert all(grid_has(f, "██") for f in post), "banner erased on first submit - it must commit into the transcript"
# The MUB-167 symptom: pre-fix the vanished banner rows sat as blank padding between the
# echo (stranded at the old banner top) and the composer — a constant 10-row hole through
# the busy window (A/B measured 2026-07-22; the committed banner holds it at 4: the busy
# spinner separation plus the turn-end teardown transient the ledger decays per commit).
for f in post:
    rows = f["screen"]
    first_echo = next(i for i, row in enumerate(rows) if "▸ you" in row)
    last_content = max(i for i, row in enumerate(rows) if row.strip())
    run = best = 0
    for i in range(first_echo, last_content + 1):
        run = run + 1 if not rows[i].strip() else 0
        best = max(best, run)
    assert best <= 5, (
        f"{best}-row blank hole below the first echo at t={f['t']} - banner rows left as live-frame padding")
print(f"tui_assert: PASS first-prompt (banner committed, no mid-frame hole across {len(post)} settled frames)")
PY
python3 "$TUI/scripts/tui_assert.py" "$TMP/firstprompt-frames.jsonl" --after 2.5 \
  --check single-prompt --check final-nonblank --check bottom-anchor --bottom-slack 1

echo "== tui-verify: scenario clear-reseat (MUB-169: /clear drops scrollback + re-seats the banner at the bottom) =="
SPEC=$(cat <<EOF
{
  "cmd": [$INLINE_ARGV],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 13,
  "env": {"MINIMA_DB_PATH": "$TMP/clearreseat.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-clearreseat"},
  "frames": "$TMP/clearreseat-frames.jsonl",
  "raw": "$TMP/clearreseat-raw.bin",
  "steps": [
    {"after": 3.0, "send": "CODE hello"},
    {"after": 3.6, "send": "<CR>"},
    {"after": 8.5, "send": "/clear"},
    {"after": 9.3, "send": "<CR>"}
  ]
}
EOF
)
capture clearreseat "$SPEC"
python3 - "$TMP/clearreseat-raw.bin" "$TMP/clearreseat-frames.jsonl" <<'PY'
import json, sys
raw = open(sys.argv[1], "rb").read()
wipes = raw.count(b"\x1b[3J")
# The ONE deliberate exception to the suite's exactly-1 budget: startup clear + /clear.
assert wipes == 2, f"{wipes} ESC[3J wipes (expect exactly 2: the startup clear + the /clear reseat)"
frames = [json.loads(l) for l in open(sys.argv[2])]
def grid_has(f, needle):
    return any(needle in row for row in f["screen"])
# Liveness: the CODE turn actually painted a transcript to clear.
assert any(grid_has(f, "```bash") for f in frames if f["t"] < 9.3), (
    "the CODE turn never rendered - nothing on screen to clear, the reseat assert is vacuous")
# Window opens AT the CR step (9.3): frames exist only on output, and the whole /clear
# repaint can land within ~0.05s of the submit — a later window start sees zero frames.
post = [f for f in frames if f["t"] >= 9.3]
assert post, "no frames after /clear"
# The old transcript is GONE from the visible screen (the 3J above proves the scrollback).
assert not any(grid_has(f, "```bash") or grid_has(f, "▸ you") for f in post), (
    "old transcript still on the visible screen after /clear")
# ...and the banner is back.
assert any(grid_has(f, "██") for f in post), "banner did not repaint after /clear"
last = frames[-1]["screen"]
assert any("██" in row for row in last), "banner not on the settled post-/clear screen"
print("tui_assert: PASS clear-reseat (second 3J deliberate, transcript gone, banner repainted)")
PY
# Post-/clear: the fresh banner + composer seat at the terminal bottom (THE RULE) — the
# reseat's reserve + cap-seeded frame, not a mid-screen repaint over stale rows.
python3 "$TUI/scripts/tui_assert.py" "$TMP/clearreseat-frames.jsonl" --after 9.3 \
  --check final-nonblank --check bottom-anchor --bottom-slack 1

# Root-caused live 2026-07-20: a prior CLI that pinned its UI with DECSTBM and died
# uncleanly leaves scroll margins in the WINDOW forever (they survive 2J/3J/H and
# resizes). The reserve then scrolls inside rows 1..24 and the composer seats mid-screen
# with dead rows below. Boot must reset margins (CSI r + CSI ?69l) before the clear.
echo "== tui-verify: scenario stale-margins (inherited DECSTBM region must not eat the seat) =="
SPEC=$(cat <<EOF
{
  "cmd": ["sh", "-c", "printf '\\\\033[5;24r'; exec bun run $TUI/src/cli/main.ts --offline --model mock-model --provider mock --provider-url http://127.0.0.1:$MOCK_PORT/v1"],
  "cwd": "$ROOT",
  "cols": 120, "rows": 36, "duration": 12,
  "env": {"MINIMA_DB_PATH": "$TMP/margins.db", "MINIMA_HARNESS_DIR": "$TMP/prefs-margins"},
  "frames": "$TMP/margins-frames.jsonl",
  "raw": "$TMP/margins-raw.bin",
  "steps": [
    {"after": 3.0, "send": "CODE render some snippets"},
    {"after": 4.0, "send": "<CR>"}
  ]
}
EOF
)
capture margins "$SPEC"
# Slack 1 from t=2.5 like the stream scenarios: with margins reset at boot the reserve
# seats frame 1 exactly, so no post-commit tightening pass is needed — and a second
# late-window invocation would hit the frames-only-on-output trap (a fast turn leaves
# zero frames after its cutoff).
python3 "$TUI/scripts/tui_assert.py" "$TMP/margins-frames.jsonl" --after 2.5 \
  --check single-prompt --check advancing --check final-nonblank \
  --check bottom-anchor --bottom-slack 1

echo "== tui-verify: no-mouse-capture sweep (every raw stream) =="
python3 - "$TMP"/echo-raw.bin "$TMP"/stream-raw.bin "$TMP"/resume-raw.bin \
          "$TMP"/clip-raw.bin "$TMP"/keys-raw.bin "$TMP"/spike-raw.bin \
          "$TMP"/tasks-raw.bin "$TMP"/planoverview-raw.bin \
          "$TMP"/streamcode80-raw.bin "$TMP"/streamcode60-raw.bin \
          "$TMP"/plancouncil-raw.bin "$TMP"/plandraft-raw.bin "$TMP"/planexit-raw.bin \
          "$TMP"/vconsent-raw.bin "$TMP"/accept-raw.bin \
          "$TMP"/otanchor-raw.bin "$TMP"/pearly-raw.bin "$TMP"/resizere-raw.bin \
          "$TMP"/big200-raw.bin "$TMP"/firstprompt-raw.bin "$TMP"/clearreseat-raw.bin \
          "$TMP"/margins-raw.bin <<'PY'
import sys
BAD = [b"\x1b[?1000h", b"\x1b[?1002h", b"\x1b[?1003h", b"\x1b[?1006h", b"\x1b[?1049h"]
for path in sys.argv[1:]:
    raw = open(path, "rb").read()
    for seq in BAD:
        assert seq not in raw, f"{path}: inline emitted {seq!r}"
print(f"tui_assert: PASS no-mouse-capture ({len(sys.argv) - 1} raw streams clean)")
PY

echo "== tui-verify: PASS =="
