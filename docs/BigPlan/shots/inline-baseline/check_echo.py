#!/usr/bin/env python3
"""MP0 echo proof: the submitted prompt must be echoed into the transcript BEFORE any
model output exists. Reads a pty_capture frames JSONL (visible grid per read-chunk) and
asserts ordering; prints the timing table that lands in README.md.

Usage:
  python check_echo.py <frames.jsonl> --enter-after 5 \
      --prompt-text "SLOW proof" --reply-text "Delayed reply"

Pass = first frame (after Enter) whose TRANSCRIPT contains prompt-text precedes the first
frame containing reply-text. Composer rows (the bordered input box) are excluded so typing
into the box doesn't count as an echo. Seed for MP1's echo-budget tui-verify scenario.
"""

from __future__ import annotations

import argparse
import json
import sys


def transcript_rows(screen: list[str]) -> list[str]:
    # Composer/box rows start with a box-drawing border; transcript rows don't.
    return [r for r in screen if not r.lstrip().startswith(("│", "╭", "╰"))]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("frames")
    ap.add_argument("--enter-after", type=float, required=True)
    ap.add_argument("--prompt-text", required=True)
    ap.add_argument("--reply-text", required=True)
    args = ap.parse_args()

    echo_t = reply_t = None
    with open(args.frames) as f:
        for line in f:
            fr = json.loads(line)
            t, screen = fr["t"], fr["screen"]
            joined_transcript = "\n".join(transcript_rows(screen))
            joined_all = "\n".join(screen)
            if echo_t is None and t >= args.enter_after and args.prompt_text in joined_transcript:
                echo_t = t
            if reply_t is None and args.reply_text in joined_all:
                reply_t = t

    print(f"enter keystroke at      : t={args.enter_after:.2f}s (spec step)")
    print(f"first echo frame        : t={echo_t:.2f}s" if echo_t is not None else "first echo frame        : NEVER")
    print(f"first reply frame       : t={reply_t:.2f}s" if reply_t is not None else "first reply frame       : NEVER")
    if echo_t is not None:
        print(f"echo latency after enter: {echo_t - args.enter_after:.2f}s")

    if echo_t is None:
        print("FAIL: prompt never echoed into the transcript", file=sys.stderr)
        return 1
    if reply_t is not None and reply_t <= echo_t:
        print("FAIL: reply appeared before (or with) the echo", file=sys.stderr)
        return 1
    print("PASS: echo precedes any model output")
    return 0


if __name__ == "__main__":
    sys.exit(main())
