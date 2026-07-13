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
      "env": {"MINIMA_TUI_PERF": "/tmp/perf.jsonl"},  # optional; merged into the child env
      "frames": "/tmp/frames.jsonl", # optional; per-chunk grid snapshots as JSONL
      "steps": [                     # timed keystrokes; "send" supports the tokens below
        {"after": 2.0, "send": "hello"},
        {"after": 3.0, "send": "<CR>"},
        {"after": 4.0, "send": "<WHEELUP>", "repeat": 100, "gap": 0.005}  # a wheel storm
      ]
    }

Send tokens: <ESC> <CR> <ENTER> <TAB> <UP> <DOWN> <LEFT> <RIGHT> <PGUP> <PGDN> <BS>
             <CTRLC> <CTRLL> <CTRLP> <CTRLR> <CTRLT> <CTRLE> <CTRLG> <SPACE>
             <WHEELUP> <WHEELDN> <PASTE> <ENDPASTE> <SHIFTTAB>

Steps may set "repeat" (send N times) and "gap" (seconds between repeats, default 0 = one
burst). A nonzero gap spreads the repeats across separate stdin chunks — closer to a real
trackpad storm than one giant write, and it exercises cross-chunk wheel coalescing.

With "frames", every PTY read chunk appends {"t": <s since start>, "screen": [rows...]} to
the given JSONL file (one pyte stream fed progressively — parser state carries across chunks,
so split escapes stay correct). tui_assert.py consumes this for invariants like "the prompt
box row never moves during a wheel storm".

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
    "<ESC>": "\x1b", "<CR>": "\r", "<ENTER>": "\r", "<TAB>": "\t", "<SHIFTTAB>": "\x1b[Z",
    "<UP>": "\x1b[A", "<DOWN>": "\x1b[B", "<LEFT>": "\x1b[D", "<RIGHT>": "\x1b[C",
    "<PGUP>": "\x1b[5~", "<PGDN>": "\x1b[6~", "<BS>": "\x7f",
    "<CTRLC>": "\x03", "<CTRLL>": "\x0c", "<CTRLP>": "\x10", "<CTRLR>": "\x12",
    "<CTRLT>": "\x14", "<CTRLE>": "\x05", "<CTRLG>": "\x07", "<CTRLA>": "\x01",
    "<CTRLK>": "\x0b", "<CTRLU>": "\x15", "<CTRLW>": "\x17", "<CTRLV>": "\x16", "<CTRLY>": "\x19",
    "<SPACE>": " ",
    # Bracketed paste envelope (what the terminal sends around a paste when ?2004h is set).
    "<PASTE>": "\x1b[200~", "<ENDPASTE>": "\x1b[201~",
    # SGR mouse wheel reports (button 64 = up, 65 = down) at an arbitrary in-grid cell —
    # what a terminal sends per wheel notch when ?1000h/?1006h tracking is on.
    "<WHEELUP>": "\x1b[<64;10;10M", "<WHEELDN>": "\x1b[<65;10;10M",
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
    frames_path = spec.get("frames")
    raw_path = spec.get("raw")  # optional: dump the raw output byte stream (OSC 52 asserts etc.)

    # Expand steps into a flat (time, bytes) schedule so "repeat"/"gap" storms interleave
    # with PTY reads instead of blocking the loop mid-burst.
    events = []
    for s in steps:
        data = expand(s["send"])
        repeat = int(s.get("repeat", 1))
        gap = float(s.get("gap", 0.0))
        for i in range(repeat):
            events.append((float(s["after"]) + i * gap, data))
    events.sort(key=lambda e: e[0])

    master, slave = os.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env["COLUMNS"] = str(cols)
    env["LINES"] = str(rows)
    env.pop("CI", None)  # a present CI var (even empty) flips Ink into non-interactive mode
    env.update(spec.get("env", {}))

    p = subprocess.Popen(
        spec["cmd"], stdin=slave, stdout=slave, stderr=slave,
        env=env, cwd=spec.get("cwd"), close_fds=True, preexec_fn=os.setsid,
    )
    os.close(slave)

    start = time.time()
    next_event = 0
    chunks = []  # (seconds-since-start, bytes) per PTY read — replayable for frame snapshots
    while time.time() - start < duration:
        now = time.time() - start
        while next_event < len(events) and now >= events[next_event][0]:
            os.write(master, events[next_event][1])
            next_event += 1
        # Wake for the next scheduled event (fine-grained during storms), else poll at 100ms.
        wait = 0.1
        if next_event < len(events):
            wait = max(0.001, min(wait, events[next_event][0] - now))
        r, _, _ = select.select([master], [], [], wait)
        if r:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            chunks.append((time.time() - start, data))

    try:
        os.killpg(os.getpgid(p.pid), signal.SIGKILL)
    except Exception:
        pass

    # One pyte stream fed progressively: parser state persists across feeds, so escapes split
    # between reads stay correct (equivalent to one big feed). HistoryScreen keeps lines that
    # scrolled off the top in `history.top` — that is the native scrollback. With "frames",
    # snapshot the visible grid after each chunk for time-indexed assertions (tui_assert.py).
    screen = pyte.HistoryScreen(cols, rows, history=5000, ratio=0.5)
    stream = pyte.ByteStream(screen)
    frames_f = open(frames_path, "w") if frames_path else None
    for t, data in chunks:
        stream.feed(bytes(data))
        if frames_f:
            frame = {"t": round(t, 3), "screen": [line.rstrip() for line in screen.display]}
            frames_f.write(json.dumps(frame) + "\n")
    if frames_f:
        frames_f.close()
        print(f"=== wrote {len(chunks)} frames: {frames_path} ===")
    if raw_path:
        with open(raw_path, "wb") as f:
            for _, data in chunks:
                f.write(data)
        print(f"=== wrote raw stream: {raw_path} ===")

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
