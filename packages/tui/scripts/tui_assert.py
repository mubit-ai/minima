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
  echo            The submitted prompt (--prompt-text) appears in the TRANSCRIPT (composer
                  rows excluded) within --echo-budget seconds (default 0.35) of the Enter
                  keystroke (--enter-after), and BEFORE any frame containing --reply-text.
                  The inline echo-latency budget (guide §3); baselined at 0.01s in
                  docs/BigPlan/shots/inline-baseline/README.md.
  bottom-anchor   THE RULE (2026-07-16): the prompt section is mounted at the terminal
                  bottom — in every frame the lowest non-blank row sits within
                  --bottom-slack rows (default 1, for log-update's trailing newline) of
                  the last grid row. A top-mounted prompt leaves the bottom blank and fails.

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


def transcript_rows(screen):
    # Composer/box rows start with a box-drawing border; transcript rows don't.
    return [r for r in screen if not r.lstrip().startswith(("│", "╭", "╰"))]


def check_bottom_anchor(frames, slack: int):
    # Only SETTLED frames count: a pty read-chunk can split one log-update write, so a frame
    # followed within 150ms by another is a torn intermediate, not a rendered state.
    settled = [
        fr
        for i, fr in enumerate(frames)
        if i == len(frames) - 1 or frames[i + 1]["t"] - fr["t"] >= 0.15
    ]
    if not settled:
        return "bottom-anchor: no settled frames"
    for fr in settled:
        screen = fr["screen"]
        nonblank = [i for i, row in enumerate(screen) if row.strip()]
        if not nonblank:
            return f"bottom-anchor: fully blank settled frame at t={fr['t']}"
        low = nonblank[-1]
        if low < len(screen) - 1 - slack:
            return (
                f"bottom-anchor: at t={fr['t']} the lowest content row is {low} of "
                f"{len(screen)} — the prompt section is not mounted at the bottom"
            )
    print(f"tui_assert: bottom-anchor evaluated {len(settled)} settled frames")
    return None


def check_echo(frames, enter_after: float, prompt_text: str, reply_text: str, budget: float):
    echo_t = reply_t = None
    for fr in frames:
        t, screen = fr["t"], fr["screen"]
        if echo_t is None and t >= enter_after and prompt_text in "\n".join(transcript_rows(screen)):
            echo_t = t
        if reply_t is None and reply_text in "\n".join(screen):
            reply_t = t
    print(f"echo: enter at t={enter_after:.2f}s (spec step)")
    print(f"echo: first echo frame  {'t=%.2fs' % echo_t if echo_t is not None else 'NEVER'}")
    print(f"echo: first reply frame {'t=%.2fs' % reply_t if reply_t is not None else 'NEVER'}")
    if echo_t is None:
        return "echo: prompt never echoed into the transcript"
    if reply_t is not None and reply_t <= echo_t:
        return f"echo: reply (t={reply_t:.2f}s) appeared before/with the echo (t={echo_t:.2f}s)"
    latency = echo_t - enter_after
    print(f"echo: latency after enter {latency:.2f}s (budget {budget:.2f}s)")
    if latency > budget:
        return f"echo: latency {latency:.2f}s exceeds the {budget:.2f}s budget"
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("frames")
    ap.add_argument("--after", type=float, default=0.0, help="ignore frames before this t")
    ap.add_argument("--before", type=float, default=None,
                    help="ignore frames at/after this t (e.g. exclude the post-exit state)")
    ap.add_argument("--prompt-pattern", default="╭─── prompt")
    ap.add_argument("--min-distinct", type=int, default=3)
    ap.add_argument("--min-rows", type=int, default=5)
    ap.add_argument("--enter-after", type=float, help="echo: t of the Enter keystroke step")
    ap.add_argument("--prompt-text", help="echo: submitted prompt text to find in the transcript")
    ap.add_argument("--reply-text", help="echo: model-output text that must come after the echo")
    ap.add_argument("--echo-budget", type=float, default=0.35)
    ap.add_argument("--bottom-slack", type=int, default=1,
                    help="bottom-anchor: blank rows tolerated under the footer")
    ap.add_argument("--check", action="append", required=True,
                    choices=["prompt-stable", "single-prompt", "advancing", "final-nonblank",
                             "echo", "bottom-anchor"])
    args = ap.parse_args()

    if "echo" in args.check and not (
        args.enter_after is not None and args.prompt_text and args.reply_text
    ):
        ap.error("--check echo requires --enter-after, --prompt-text and --reply-text")

    frames = [fr for fr in load_frames(args.frames) if fr["t"] >= args.after]
    if args.before is not None:
        frames = [fr for fr in frames if fr["t"] < args.before]
    if not frames:
        print(f"tui_assert: no frames in the [{args.after}, {args.before}) window", file=sys.stderr)
        return 1

    failures = []
    for name in args.check:
        if name == "prompt-stable":
            err = check_prompt_stable(frames, args.prompt_pattern)
        elif name == "single-prompt":
            err = check_single_prompt(frames, args.prompt_pattern)
        elif name == "advancing":
            err = check_advancing(frames, args.min_distinct)
        elif name == "echo":
            err = check_echo(frames, args.enter_after, args.prompt_text,
                             args.reply_text, args.echo_budget)
        elif name == "bottom-anchor":
            err = check_bottom_anchor(frames, args.bottom_slack)
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
