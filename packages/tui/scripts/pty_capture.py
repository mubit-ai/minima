#!/usr/bin/env python3
"""Capture a "screenshot" of the Minima TUI by driving it in a real PTY.

The TUI is an Ink/React app that renders inline in the terminal's MAIN screen buffer and commits
its finalized transcript to native scrollback via <Static>. A fixed-grid emulator alone can't show
that scrollback, so this uses pyte's HistoryScreen: the visible grid is the "screen", and lines that
scroll off the top land in history — which is exactly how we verify the transcript is scrollable.

Usage:
    uv run --with pyte python packages/tui/scripts/pty_capture.py '<json-spec>'

Spec (JSON):
    {
      "cmd": ["bun", "run", "src/cli/main.ts", "--offline"],  # argv (required)
      "cwd": "/path/to/repo",        # optional; set to the repo root so .env(.harness) load
      "cols": 100, "rows": 30,       # terminal size (default 80x24)
      "duration": 8,                 # seconds to run before SIGKILL (default 8)
      "show_history": true,          # also print scrollback above the screen (default true)
      "steps": [                     # timed keystrokes; "send" supports the tokens below
        {"after": 2.0, "send": "hello"},
        {"after": 3.0, "send": "<CR>"}
      ]
    }

Send tokens: <ESC> <CR> <ENTER> <TAB> <UP> <DOWN> <LEFT> <RIGHT> <PGUP> <PGDN> <BS>
             <CTRLC> <CTRLL> <CTRLP> <CTRLR> <SPACE>

Notes:
  - A present CI env var (even empty) flips Ink into non-interactive mode, so it is stripped.
  - The child is SIGKILLed at `duration` (before it can emit its exit sequences), so the last Ink
    paint stays on the emulated grid.
  - pyte models a fixed grid + scrollback; it proves "prompt at the bottom / no void / clean render /
    lines in scrollback". True wheel/trackpad scrolling is a real-terminal, human check.
"""
import fcntl
import json
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time

import pyte

TOKENS = {
    "<ESC>": "\x1b", "<CR>": "\r", "<ENTER>": "\r", "<TAB>": "\t",
    "<UP>": "\x1b[A", "<DOWN>": "\x1b[B", "<LEFT>": "\x1b[D", "<RIGHT>": "\x1b[C",
    "<PGUP>": "\x1b[5~", "<PGDN>": "\x1b[6~", "<BS>": "\x7f",
    "<CTRLC>": "\x03", "<CTRLL>": "\x0c", "<CTRLP>": "\x10", "<CTRLR>": "\x12",
    "<SPACE>": " ",
}


def expand(s: str) -> bytes:
    for k, v in TOKENS.items():
        s = s.replace(k, v)
    return s.encode()


def render_row(row, cols: int) -> str:
    """A pyte row (sparse column->Char mapping) as a plain string, trailing space trimmed."""
    return "".join(row[x].data for x in range(cols)).rstrip()


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: pty_capture.py '<json-spec>'", file=sys.stderr)
        return 2
    spec = json.loads(sys.argv[1])
    rows = spec.get("rows", 24)
    cols = spec.get("cols", 80)
    duration = spec.get("duration", 8)
    steps = spec.get("steps", [])
    show_history = spec.get("show_history", True)

    master, slave = os.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env["COLUMNS"] = str(cols)
    env["LINES"] = str(rows)
    env.pop("CI", None)  # a present CI var (even empty) flips Ink into non-interactive mode

    p = subprocess.Popen(
        spec["cmd"], stdin=slave, stdout=slave, stderr=slave,
        env=env, cwd=spec.get("cwd"), close_fds=True, preexec_fn=os.setsid,
    )
    os.close(slave)

    start = time.time()
    sent = [False] * len(steps)
    raw = bytearray()
    while time.time() - start < duration:
        now = time.time() - start
        for i, s in enumerate(steps):
            if not sent[i] and now >= s["after"]:
                os.write(master, expand(s["send"]))
                sent[i] = True
        r, _, _ = select.select([master], [], [], 0.1)
        if r:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            raw += data

    try:
        os.killpg(os.getpgid(p.pid), signal.SIGKILL)
    except Exception:
        pass

    # Feed the full accumulated stream once (robust vs. escapes split across reads). HistoryScreen
    # keeps lines that scrolled off the top in `history.top` — that is the native scrollback.
    screen = pyte.HistoryScreen(cols, rows, history=5000, ratio=0.5)
    pyte.ByteStream(screen).feed(bytes(raw))

    if show_history and screen.history.top:
        hist = list(screen.history.top)
        print(f"=== SCROLLBACK ({len(hist)} lines above the screen) ===")
        for idx, row in enumerate(hist):
            print(f"h{idx:03} |{render_row(row, cols)}")

    print(f"=== SCREEN {cols}x{rows} (visible) ===")
    for idx, line in enumerate(screen.display):
        print(f"{idx:2} |{line.rstrip()}")
    print(f"=== {len(screen.display)} visible rows; {len(screen.history.top)} in scrollback ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
