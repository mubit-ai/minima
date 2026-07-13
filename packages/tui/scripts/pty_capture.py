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
             <CTRLC> <CTRLL> <CTRLP> <CTRLR> <CTRLT> <CTRLE> <CTRLG> <SPACE>

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
    "<CTRLT>": "\x14", "<CTRLE>": "\x05", "<CTRLG>": "\x07",
    "<SPACE>": " ",
}


def expand(s: str) -> bytes:
    for k, v in TOKENS.items():
        s = s.replace(k, v)
    return s.encode()


def render_row(row, cols: int) -> str:
    """A pyte row (sparse column->Char mapping) as a plain string, trailing space trimmed."""
    return "".join(row[x].data for x in range(cols)).rstrip()


# pyte's 16 ANSI color names -> RGB. Note pyte uses "brown" for SGR 33 (not "yellow"),
# and 256/truecolor come through as "RRGGBB" hex strings handled in _resolve().
_PALETTE = {
    "black": (0, 0, 0), "red": (194, 54, 33), "green": (37, 188, 36),
    "brown": (173, 173, 39), "blue": (73, 46, 225), "magenta": (211, 56, 211),
    "cyan": (51, 187, 200), "white": (203, 204, 205),
    "brightblack": (129, 131, 131), "brightred": (252, 57, 31),
    "brightgreen": (49, 231, 34), "brightbrown": (234, 236, 35),
    "brightblue": (88, 51, 255), "brightmagenta": (249, 53, 248),
    "brightcyan": (20, 240, 240), "brightwhite": (233, 235, 235),
}
_DEFAULT_FG = (205, 205, 205)
_DEFAULT_BG = (13, 13, 13)


def _resolve(color: str, default):
    if color == "default":
        return default
    if color in _PALETTE:
        return _PALETTE[color]
    try:  # 256/truecolor arrive as "RRGGBB" hex
        return (int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16))
    except (ValueError, IndexError):
        return default


def render_png(screen, path: str, font_size: int = 18) -> None:
    """Rasterize the visible pyte grid (with colors/bold/reverse) to a PNG via Pillow + Menlo, so a
    reader can visually inspect the TUI. Requires pillow (`uv run --with pillow`)."""
    import unicodedata

    from PIL import Image, ImageDraw, ImageFont

    font_path = "/System/Library/Fonts/Menlo.ttc"
    regular = ImageFont.truetype(font_path, font_size, index=0)
    bold = ImageFont.truetype(font_path, font_size, index=1)
    ascent, descent = regular.getmetrics()
    cw = int(round(regular.getlength("M")))  # monospace advance width
    ch = ascent + descent  # cell height
    cols, rows = screen.columns, screen.lines

    img = Image.new("RGB", (cols * cw, rows * ch), _DEFAULT_BG)
    d = ImageDraw.Draw(img)
    for y in range(rows):
        line = screen.buffer[y]  # defaultdict; indexing empty cells returns default_char
        x = 0
        while x < cols:
            c = line[x]
            fg = _resolve(c.fg, _DEFAULT_FG)
            bg = _resolve(c.bg, _DEFAULT_BG)
            if c.reverse:
                fg, bg = bg, fg
            wide = 2 if (c.data and unicodedata.east_asian_width(c.data[0]) in "WF") else 1
            px, py = x * cw, y * ch
            if bg != _DEFAULT_BG:
                d.rectangle([px, py, px + cw * wide - 1, py + ch - 1], fill=bg)
            if c.data and c.data != " ":
                d.text((px, py), c.data, font=(bold if c.bold else regular), fill=fg)
            x += wide
    img.save(path, "PNG")


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

    png = spec.get("png")
    if png:
        render_png(screen, png)
        print(f"=== wrote PNG: {png} ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
