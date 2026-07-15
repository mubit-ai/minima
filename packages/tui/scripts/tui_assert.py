#!/usr/bin/env python3
"""Assert invariants over a pty_capture frames JSONL (pty_capture.py spec key "frames").

Usage:
    python tui_assert.py <frames.jsonl> [--after S] [--prompt-pattern P] \
        --check prompt-stable --check single-prompt --check advancing --check final-nonblank

Checks (repeatable --check; all evaluated over frames with t >= --after, default 0):
  prompt-stable   The row index of the prompt-box top border (--prompt-pattern, default
                  "╭─── prompt") is identical in every frame that contains it. Scrolling
                  must never move the prompt box; only typing/overlays may (run those in
                  a separate capture).
  single-prompt   Every frame has at most one prompt-box top border and at most one bottom
                  ("╰") on that box's row range — two prompts on screen is the frame-fusion
                  garble signature.
  advancing       At least --min-distinct (default 3) distinct grids among the frames —
                  the app is alive (spinner/stream mutating), not frozen.
  final-nonblank  The last frame has at least --min-rows (default 5) non-blank rows.

Exit 0 = all pass. Exit 1 = failures (one line each on stderr). Exit 2 = usage error.
"""
import argparse
import json
import sys


def load_frames(path: str):
    frames = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                frames.append(json.loads(line))
    return frames


def prompt_rows(frame, pattern: str):
    return [i for i, row in enumerate(frame["screen"]) if pattern in row]


def check_prompt_stable(frames, pattern: str):
    seen = {}  # row index -> first frame t
    for fr in frames:
        for r in prompt_rows(fr, pattern):
            seen.setdefault(r, fr["t"])
    if len(seen) > 1:
        detail = ", ".join(f"row {r} (first at t={t})" for r, t in sorted(seen.items()))
        return f"prompt-stable: prompt box moved across frames: {detail}"
    if not seen:
        return f"prompt-stable: pattern {pattern!r} never appeared in any frame"
    return None


def check_single_prompt(frames, pattern: str):
    for fr in frames:
        rows = prompt_rows(fr, pattern)
        if len(rows) > 1:
            return f"single-prompt: {len(rows)} prompt boxes at t={fr['t']} (rows {rows})"
    return None


def check_advancing(frames, min_distinct: int):
    distinct = {tuple(fr["screen"]) for fr in frames}
    if len(distinct) < min_distinct:
        return (
            f"advancing: only {len(distinct)} distinct grids across {len(frames)} frames "
            f"(need >= {min_distinct}) — app frozen?"
        )
    return None


def check_final_nonblank(frames, min_rows: int):
    last = frames[-1]["screen"]
    nonblank = sum(1 for row in last if row.strip())
    if nonblank < min_rows:
        return f"final-nonblank: only {nonblank} non-blank rows in the final frame (need >= {min_rows})"
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("frames")
    ap.add_argument("--after", type=float, default=0.0, help="ignore frames before this t")
    ap.add_argument("--prompt-pattern", default="╭─── prompt")
    ap.add_argument("--min-distinct", type=int, default=3)
    ap.add_argument("--min-rows", type=int, default=5)
    ap.add_argument("--check", action="append", required=True,
                    choices=["prompt-stable", "single-prompt", "advancing", "final-nonblank"])
    args = ap.parse_args()

    frames = [fr for fr in load_frames(args.frames) if fr["t"] >= args.after]
    if not frames:
        print(f"tui_assert: no frames at t >= {args.after}", file=sys.stderr)
        return 1

    failures = []
    for name in args.check:
        if name == "prompt-stable":
            err = check_prompt_stable(frames, args.prompt_pattern)
        elif name == "single-prompt":
            err = check_single_prompt(frames, args.prompt_pattern)
        elif name == "advancing":
            err = check_advancing(frames, args.min_distinct)
        else:
            err = check_final_nonblank(frames, args.min_rows)
        if err:
            failures.append(err)
        else:
            print(f"tui_assert: PASS {name} ({len(frames)} frames)")

    for f in failures:
        print(f"tui_assert: FAIL {f}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
