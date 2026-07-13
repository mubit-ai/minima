#!/usr/bin/env bash
# PTY verification for the fullscreen TUI: drive a real session (500-msg fixture) through
# wheel storms in a pseudo-terminal and assert rendering invariants (see tui_assert.py)
# plus perf budgets from the MINIMA_TUI_PERF probe. Wired to `make tui-verify`.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
TUI=$ROOT/packages/tui
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "== tui-verify: generating 500-message fixture =="
(cd "$ROOT" && bun run "$TUI/scripts/gen-fixture-session.ts" \
  --db "$TMP/fixture.db" --messages 500 --name fixture-500 > /dev/null)

echo "== tui-verify: scenario storm (resume + 150-notch wheel storm) =="
SPEC=$(cat <<EOF
{
  "cmd": ["bun", "run", "$TUI/src/cli/main.ts", "--offline", "--resume", "fixture-500"],
  "cwd": "$ROOT",
  "cols": 100, "rows": 30, "duration": 9,
  "env": {"MINIMA_DB_PATH": "$TMP/fixture.db", "MINIMA_TUI_PERF": "$TMP/perf.jsonl"},
  "frames": "$TMP/frames.jsonl",
  "steps": [
    {"after": 3.0, "send": "<WHEELUP>", "repeat": 100, "gap": 0.005},
    {"after": 5.0, "send": "<WHEELDN>", "repeat": 50, "gap": 0.005},
    {"after": 6.5, "send": "<PGUP>"},
    {"after": 7.0, "send": "<PGDN>"}
  ]
}
EOF
)
uv run --with pyte python "$TUI/scripts/pty_capture.py" "$SPEC" > "$TMP/capture.txt"
tail -2 "$TMP/capture.txt"

python3 "$TUI/scripts/tui_assert.py" "$TMP/frames.jsonl" --after 2.5 \
  --check prompt-stable --check single-prompt --check advancing --check final-nonblank

echo "== tui-verify: scenario clipboard (bracketed paste + Ctrl+Y OSC 52) =="
SPEC2=$(cat <<EOF
{
  "cmd": ["bun", "run", "$TUI/src/cli/main.ts", "--offline", "--resume", "fixture-500"],
  "cwd": "$ROOT",
  "cols": 100, "rows": 30, "duration": 7,
  "env": {"MINIMA_DB_PATH": "$TMP/fixture.db"},
  "raw": "$TMP/raw.bin",
  "steps": [
    {"after": 2.5, "send": "<PASTE>pasted line one\nline two\n<ENDPASTE>"},
    {"after": 4.0, "send": "<CTRLY>"}
  ]
}
EOF
)
uv run --with pyte python "$TUI/scripts/pty_capture.py" "$SPEC2" > "$TMP/clip.txt"
grep -q "pasted line one" "$TMP/clip.txt" || { echo "FAIL: paste not in prompt"; exit 1; }
# The paste must NOT have submitted: no user-echo of the pasted text in the transcript.
grep -q "▸ you.*pasted line one" "$TMP/clip.txt" && { echo "FAIL: paste auto-submitted"; exit 1; }
grep -q "Copied last reply" "$TMP/clip.txt" || { echo "FAIL: Ctrl+Y feedback missing"; exit 1; }
LC_ALL=C grep -qa "]52;" "$TMP/raw.bin" || { echo "FAIL: no OSC 52 in output stream"; exit 1; }
echo "tui_assert: PASS clipboard (paste captured, no auto-submit, OSC 52 emitted)"

echo "== tui-verify: perf budget (window compute bounded, listeners flat) =="
python3 - "$TMP/perf.jsonl" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
assert rows, "no perf samples - MINIMA_TUI_PERF probe not wired?"
ms = sorted(r["ms"] for r in rows)
cold, median = ms[-1], ms[len(ms) // 2]
renders = rows[-1]["renders"]
listeners = {r["stdinListeners"] for r in rows}
print(f"samples={len(rows)} cold_max={cold:.1f}ms median={median:.2f}ms "
      f"renders={renders} listeners={sorted(listeners)}")
# Generous machine-independent budgets: catch order-of-magnitude regressions, not noise.
assert cold < 500, f"cold window compute {cold:.1f}ms exceeds 500ms"
assert median < 30, f"median window compute {median:.2f}ms exceeds 30ms"
assert renders < 300, f"{renders} renders for a 150-notch storm - coalescing broken?"
assert max(listeners) <= 3, f"stdin listener growth: {sorted(listeners)}"
PY

echo "== tui-verify: PASS =="
