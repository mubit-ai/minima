# Stale-DECSTBM root cause — live forensic evidence (2026-07-20)

The anchor ledger shipped bottom-invariance, yet the reporter's real iTerm2 window still
seated the composer ~25 rows from the top with dead space below, from frame 1. Every
clean-room replication (fresh iTerm2/Terminal.app windows, offline + online, typed turns,
242×60) anchored perfectly. The failure followed the WINDOW, not the build.

## The trace that closed it

`before-user-window-probe.jsonl` — instrumented boot in the failing window itself:

- write-tap: `?2004h` → `[r`-less clear (`2J 3J H`) → **59 newlines** → `?25l` → `6n` —
  the byte stream is exactly right;
- DSR reply: **`{"phase":"dsr","row":24}`** — after a 59-newline reserve on a 60-row
  grid the cursor sat at row 24.

A scroll region (DECSTBM, rows 1–24) had been abandoned in the window by an earlier
program — margins survive `2J`/`3J`/`H` and window resizes, so every newline scrolled
inside the stale region and nothing could ever reach the bottom 36 rows. The ledger then
faithfully preserved the bad seat (bottom-invariance is its contract).

`before-user-window-contents.txt` is the window's text buffer in that state: transcript
glued above the frame, composer at visible row ~21 of 60, 39 blank rows below.

## The A/B that proved it

`ab-csi-r-probe.jsonl` — same window, same launcher, one `printf '\033[r'` first:
DSR answers row **60**; the composer seats at the bottom.

## The fix + regression proof

`main.ts` now leads the boot clear with `CSI r` + `CSI ?69l` (margins can't be inherited).
`after-polluted-probe.jsonl` / `after-polluted-242x60.png` — the fixed build booted through
a deliberately polluted region (`printf '\033[5;24r'` first, `scripts/real_term_capture.sh`
`RT_POLLUTE=1`): DSR row 60, composer bottom-anchored, transcript adjacent above it.

CI regression: `tui_verify.sh` scenario `stale-margins` reproduces the pollution in the
pyte PTY (pyte models DECSTBM: the reserve dies at row 24 without the fix) and asserts
bottom-anchor.

A mount cap-seed (first frame at full height so boot would self-seat from any cursor row)
was tried and reverted: it parks the first turns' transcript at the screen top, 40+ rows
from the composer — PNG-refuted the same day. Boot seating stays the reserve's job; the
margin reset makes the reserve trustworthy.
