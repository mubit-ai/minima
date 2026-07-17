# MP0 inline baseline (MUB-143)

Captured 2026-07-16 on `mp0-inline-baseline` (product code identical to `f1a7c5c`; the
capture scripts land in this commit). **This is the committed visual reference for the
inline renderer** — every later MP (deletions MP1–3, panels MP5–9, rendering MP10–12) diffs
its after-shots against these. Guide: `docs/BigPlan/inline-ux-guide.md` §5.

Primary target: **iTerm2 @ 120×36** (user-confirmed daily size). Bookends: 60×24
(`TOC_MIN_COLS` floor) and 55×20 (below-floor / tmux-narrow equivalent).

## Re-run

```bash
bun packages/tui/scripts/mock_openai_sse.ts &          # OpenAI-SSE mock on :8399
bash docs/BigPlan/shots/inline-baseline/capture-specs.sh all    # or a single scenario name
python3 docs/BigPlan/shots/inline-baseline/check_echo.py \
  docs/BigPlan/shots/inline-baseline/echo-gap.frames.jsonl \
  --enter-after 5 --prompt-text "SLOW proof: respond only after a delay" \
  --reply-text "Delayed reply"
```

## Echo proof (the shipped D1 fix, PR #133 — confirmed)

`check_echo.py` on `echo-gap.frames.jsonl` (mock delays the reply 2.5s):

| event | t |
|---|---|
| Enter keystroke (spec step) | 5.00s |
| **first frame with the prompt echoed in the transcript** | **5.01s** |
| first frame with any reply text | 10.34s |

Echo latency after Enter: **0.01s** (next captured frame) — PASS, echo precedes all model
output by 5.3s. This assertion becomes MP1's echo-budget tui-verify scenario.

## Perf + cold start (MP1 budget inputs)

`perf.jsonl` (500-msg fixture resume + one streamed mock reply, 120×36):

| metric | value |
|---|---|
| `render` samples | 14 (p50 **1.4ms**, p95/max **381ms**) |
| max `renders` counter / max `stdinListeners` | 17 / 1 |
| `window` samples | **none — viewport(fullscreen)-path only**; inline budgets must gate on `render.ms` |
| cold start (first PTY frame, `plain-chat.frames.jsonl`) | **0.21s** |

The 381ms outlier is the one-time 500-message resume mount (`<Static>` commit), not
steady-state: MP1's frame-cost budget needs a separate resume-mount allowance vs the
per-frame budget (steady-state renders are ~1–2ms).

## Scenarios

| file | size | what it shows (verified by eyeball) |
|---|---|---|
| `plain-chat.png` (+frames) | 120×36 | `▸ you` echo block, assistant reply, prompt box, status bar — the canonical idle look |
| `echo-gap.png` (+frames) | 120×36 | final state of the echo proof run (echo + delayed reply) |
| `code-heavy-120.png` | 120×36 | fenced blocks today: no visual container; long code lines hard-wrap and continuation loses indent (**MP11 before**) |
| `code-heavy-60.png` | 60×24 | same content at the floor; footer warts (below) clearly visible |
| `fixture-resume.png` | 120×36 | 500-msg resume: tool block (`⚙ bash:`), resume notice, restored footer stats `↑1414 ↓614` (**MP12 before**) |
| `gt-banner.png` | 120×36 | GT footer state after `/gt-seed`: plan banner `▸ plan 3/3 … ⚠ 1 off-plan (drift)` + 🟡 flagged row + 🔴 gate row + gate-answer prompt (**MP6 before** — exactly the rows that fold into D3a) |
| `gt-block.png` | 120×36 | Ctrl+G one-shot GT overview block: step list + per-step `verify` + DRIFT + `Σ $0.0000 realized (stamped steps)` (**MP9 before**) |
| `gt-off-notice.png` | 120×36 | Ctrl+G with GT unset → one-line OFF notice |
| `toc-block.png` | 120×36 | Ctrl+T one-shot ToC block: numbered sections, per-section `$ · tok`, tool aggregates (**MP7 before**) |
| `boundary-60.png` | 60×24 | ToC block at the floor width |
| `narrow-55.png` | 55×20 | below-floor state (degrade target for the text-snapshot rule) |
| `perf.jsonl` | 120×36 | numbers only (table above) |

## Warts observed (pre-existing — they are the point of a baseline)

1. **Code blocks have no container and wrap badly** (`code-heavy-*.png`): fence language
   renders as a bare colored word; wrapped code continuation lines lose all indentation.
   → MP11's acceptance criteria.
2. **Floor-width footer squeeze** (`code-heavy-60.png`, `boundary-60.png`): at 60 cols the
   keys legend fuses into `ctrl+Modelctrl+rRout⇧tabMode…` and the status bar truncates
   mid-token. Footer behavior at/below the floor is part of MP5's footer-restack scope.
3. **Below-floor ghost frame** (`narrow-55.png`): after a `<Static>` append at 55 cols the
   shot shows a stale duplicate of the prompt box + status above the new one — wrapped
   footer rows break Ink's erase math below the floor. Evidence for the 60-col floor rule
   (below it, degrade harder, never render the full footer).
4. **Long committed blocks already clamp** with a dim `… +N more lines` row (`toc-block`
   +473, `boundary-60` +475): prior art for MP12's tool-output indicator — MP12 should
   extend/reuse this, not invent a new one.
5. **Gate wins the Ctrl+G chord** (observed live during capture): with the seeded 🔴
   unanswered, Ctrl+G goes to the gate — the overview only opens after answering
   (`capture-specs.sh` gt-block comments; this is the designed rule MP9 must preserve).
   Corollary (`gt-banner.png`): while the gate prompt is up, typed text does not reach the
   composer (`esc to type` hint) — plain keys are gate answers.
6. **pyte renders emoji/CJK as hollow boxes** in fixture shots — capture-emulator artifact,
   not an app bug (raw PTY bytes are correct; same class as the U2/U3 notes).
