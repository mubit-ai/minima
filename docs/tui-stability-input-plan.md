# TUI Stability & Input Overhaul — `fix/tui-stability-input`

## Context

The Minima Ink TUI (fullscreen renderer) freezes/lags with session length — worst during wheel scrolling and after `/resume` — the prompt box jumps during scroll, sections vanish when they don't fully fit, copy/paste is broken, and there's no Claude Code-style permission-mode cycling. Decisions made up front: base on **feat/BP-UX-TrackB tip**, **full permission gating**, **line-level viewport**, all clipboard behaviors "like Claude Code where it makes sense", terminals = **iTerm2 / Ghostty / kitty / tmux**, **one PR with staged commits**, **inline renderer stays untouched**.

Branch: `fix/tui-stability-input` @ `3b2cddf` (TrackB tip), developed in the worktree `minima-tui-fixes`.

## Root-cause findings (verified by exploration)

1. **No listener leak.** All `useEffect` subscriptions in `app.tsx` have stable deps and cleanups. The freeze/lag is **compute**: `getScrollableMessages` → `messages.map(computeMsgHeight)` (O(n·lines·stringWidth)) runs unmemoized **every render** (`app.tsx:2148`, `layout.ts:232`), and renders fire from 80 ms stream flushers, every wheel notch (no coalescing, `app.tsx:787-789`), and app state changes. Cost scales with transcript → "lag grows", worst post-`/resume` (huge transcript) and during wheel storms.
2. **Stored `scrollOffset` is never clamped** (only the derived offset is, `layout.ts:236`) — over-scroll banks dead offset, so scrolling back feels frozen.
3. **Prompt-box jump**: crossing pinned↔scrolled (offset 0↔1) swings `messagesBudget` ~6 rows (stream/thoughts reserves collapse to a 1-row hint, `app.tsx:2137-2147`).
4. **Vanishing sections**: whole-message clip granularity; `clipMessageToHeight` drops any straddling section whose chrome floor won't fit (`layout.ts:299-306`).
5. **Copy broken**: SGR mouse tracking (`?1000h`+`?1006h`, `app.tsx:809`) disables native terminal selection. **Paste broken**: no bracketed paste (`?2004`) anywhere; trailing-`\n` paste auto-submits (`text-input.tsx:55-64`); input is a cursor-less single-line buffer.
6. **Modes**: B2 = 2-state build↔plan ring in `src/agent/modes.ts` (no persistence), `PolicyBundle` resolution in `src/agent/policy.ts`, gate at `makeModeGatedBeforeToolCall` (`src/tui/permissions.ts:194-224`). Clean hook points for 4 modes.

## Stages (one PR, each stage = green, reviewable commits)

### Stage 0 — Plan doc + fixtures
- This document.
- Fixture generator: 500-message synthetic session (script under `packages/tui/scripts/`) loadable via `--resume`/offline for perf tests.

### Stage 1 — Perf relief on the existing renderer (issues 1+2, low risk)
- `WeakMap<ChatMessage,{cols,h}>` height cache `cachedMsgHeight()` in `layout.ts` (messages are append/replace-only — identity keying verified sound). Use in `getScrollableMessages` + `offsetForMessage`.
- `useMemo` the `getScrollableMessages` call keyed `[messages, messagesBudget, scrollOffset, cols]`; `React.memo(MessageRow)` (`messages.tsx:126`).
- Clamp stored offset at every mutation site (wheel, PgUp/PgDn) via a `maxOffsetRef`.
- **Wheel coalescing** in `mouse-scroll.ts`: leading-edge-immediate + 33 ms trailing accumulator; callback signature becomes `(notches: number)`; timer cleared when callback unset (no leak). `setTimeout`, not microtask — storms span many stdin chunks.
- Optional `MINIMA_TUI_PERF=<file>` probe: log per-render window-computation duration + render count (used by soak test).
- Unit tests: cached==uncached property; over-scroll clamp; coalescer (fake timers: N notches → 1 callback, unmount clears).

### Stage 2 — PTY validation harness (before the risky rewrite)
Extend `packages/tui/scripts/pty_capture.py` (additive):
- `<WHEELUP>`/`<WHEELDN>` tokens (inject `ESC[<64;10;20M` / `65`), repeat-count support for storms.
- **Incremental frame capture**: feed pyte progressively with per-chunk timestamps (today it feeds the whole stream once) → enables prompt-row-stability and responsiveness assertions across intermediate frames.
- Assert wrapper script (`packages/tui/scripts/tui_assert.py`): greps pyte grid/frames for invariants; Make targets `tui-check` / `tui-viewport-check`.
- Baseline specs against the **old** renderer: scroll sweep, 200-notch storm, `/resume` 500-msg, PNG captures (Pillow) for later visual parity.

### Stage 3 — Line-level viewport (issues 2+3, the surgery)
Architecture (Ink 5.2.1 internals verified):
- **New `src/tui/lines.ts`** (pure, no React): `renderMessageToLines(msg, cols) → string[]` of self-contained ANSI lines pre-wrapped to ≤ cols, mirroring `MessageRow` visuals (4 role layouts, inline bold/`code`, thinking border, `clampToolText`). Blank separators emitted as `" "` (empty Text measures height 0 in Ink). **Single shared break-point engine** refactored out of `layout.ts`'s `wrapRows` so styled and plain wrapping agree by construction. Hand-rolled SGR helpers; `string-width` already a dep at Ink's major.
- **Caches**: `WeakMap<ChatMessage,{cols,lines}>` (GC'd with transcript replaces; no LRU needed — tool bodies pre-clamped); separate incremental `streamCache` for the streaming tail (O(delta) per 80 ms flush; reset when text isn't an extension or cols change).
- **New `src/tui/viewport.ts`**: `buildLineIndex` (prefix sums, `useMemo [messages, cols]`), `ScrollState = null | {topLine}` (null = pinned/follow — deletes the follow-newest effect; absolute topLine keeps content stationary on appends while scrolled), `scrollBy` (clamped at every mutation; re-pins crossing bottom), `windowLines` (binary search + slices, O(viewportRows + log n), emits ≤ viewportRows lines **by construction**).
- **Live-region stability**: stream/thoughts become ordinary lines in the virtual stream (no `fsThoughtsRows`/`fsStreamRows` reservations) + a **permanent 1-row status line** in fullscreen ("↑ scrolled…" / blank) so crossing pinned↔scrolled changes zero heights outside the viewport → prompt box cannot move on scroll.
- **Render**: one `<Text wrap="truncate">` per visible line inside the existing flex-end/overflow-hidden Box — a 1-line Text can never occupy 2 rows, so Σ(rows) ≤ region holds exactly (garble impossible by construction; truncate is the per-line failsafe).
- **Rollout**: behind `MINIMA_TUI_VIEWPORT` (default **ON**; `=0` = byte-identical old path) for one release, then delete old path (`getScrollableMessages`, `clipMessageToHeight`, `offsetForMessage`). Keep `wrappedLineCount`/`markdownBodyHeight`/`tailToFit` — inline renderer still uses them. ToC jump: `setScroll({topLine: prefix[k]})`.
- **Inline renderer (`<Static>` branch): untouched.**
- Unit tests: `lines.test.ts` (width ≤ cols fuzz incl. CJK/emoji; styled/plain line-count parity property; role chrome; streaming incremental==from-scratch), `viewport.test.ts` (line-sweep invariant — successor to `layout.test.ts:161` garble guard; partial top/bottom slicing; append-while-scrolled stationary; clamp on shrink; re-pin).

### Stage 4 — Clipboard, paste, shortcuts (issues 4+6)
- **Generalize the stdin filter** (`mouse-scroll.ts` → `input-filter.ts`): additive bracketed-paste capture (`ESC[200~…ESC[201~`) alongside mouse regex; enable `?2004h` with alt-screen, disable on exit. Paste delivered as one event → text-input inserts verbatim, **never auto-submits** (fixes trailing-`\n` fire; the endsWithLF branch only applies to real Enter).
- **text-input.tsx**: add cursor position + Left/Right; multi-line drafts (pasted `\n` kept; `inputExtraLines` already budgets height); readline keys **Ctrl+A** (home), **Ctrl+E stays app-level** (thinking) so use **Ctrl+K/U/W** (kill-to-end / kill-line / kill-word). **Ctrl+V** = paste from system clipboard via `pbpaste` fallback (primary path = terminal Cmd+V through bracketed paste).
- **Copy**: `/copy` command + **Ctrl+Y** = copy last assistant message via **OSC 52** (works in iTerm2/kitty/Ghostty; through tmux with `set-clipboard on` — emit tmux passthrough wrapping when `$TMUX` set) + `pbcopy` fallback on darwin.
- **Selection**: keep wheel capture; `/mouse` toggle already exists (`app.tsx:806-813`) — surface it (footer hint: "selection: /mouse off or Option-drag"); document Option-drag (iTerm2/kitty/Ghostty native override). **Ctrl+C unchanged** (abort/quit — Claude Code parity).
- Tests: filter unit tests (paste block spanning chunks, lone ESC passthrough regression); PTY: multi-line paste lands in prompt without submit; Ctrl+Y writes OSC 52 to stream (assert raw capture contains `]52;`).

### Stage 5 — Permission modes on Shift+Tab (issue 5, full gating)
- **Ring** in `src/agent/modes.ts`: `build → acceptEdits → plan → build`; `bypass` joins the ring only when enabled via `--dangerously-bypass` flag or `/mode bypass` (Claude Code parity: bypass is opt-in, never default, never persisted).
- **Bundles** (`src/agent/modes.ts` + new policy action `"auto"` in `src/agent/policy.ts`): `ACCEPT_EDITS_BUNDLE` = `write/edit/apply_patch → auto` (skip prompt), bash → normal; `BYPASS_BUNDLE` = all → auto; `PLAN_BUNDLE` exists (writes → ask, plan-mode outranks session grants).
- **Gate**: extend `makeModeGatedBeforeToolCall` (`permissions.ts:194-224`) to handle `auto` (run without prompt + `emitGuardEvent({kind:"mode-auto"})` audit); bypass short-circuits `checkPermission`.
- **UI**: badges via existing `badge_slot.ts` slot — PLAN magenta (exists), `⏵⏵ accept edits` green, `BYPASS` red; footer legend updated; persist last non-bypass mode per project in `config_store.ts`.
- Tests: policy/permissions unit tests per mode; PTY: Shift+Tab cycles badges; plan-mode still prompts on write; acceptEdits runs a scripted edit tool without prompt (offline fixture).

### Stage 6 — Soak + final validation
- 10-min PTY soak on the 500-msg fixture with wheel storms + repeated `/resume`: assert frames keep advancing, `process.stdin` listener count constant (probe via `MINIMA_TUI_PERF`), per-window compute stays bounded (no growth with time), final grid clean.
- Visual parity PNGs old vs new per role; manual checklist run in iTerm2, Ghostty, and tmux (wheel feel, Option-drag select, Cmd+V multi-line paste, Ctrl+Y through tmux).
- Rebase onto current TrackB tip before PR; PR to `feat/BP-UX-TrackB` (not main).

## Verification (how "done" is proven)
1. `bun test` in `packages/tui` — all existing + new unit suites green.
2. `make tui-check` / `tui-viewport-check` — PTY assertions: Σ-rows/no-garble after 200-notch storm, prompt-box border row index constant across pinned↔scrolled bursts, partial sections visible top+bottom, 500-msg `/resume` responsive within wall-clock bound, paste/copy/mode-badge assertions.
3. Soak test (Stage 6) passes; PNGs eyeballed.

## Key risks
| Risk | Mitigation |
|---|---|
| Garble regression (the historical Ink bug) | 1-line-per-`<Text wrap="truncate">` makes Σ rows exact by construction; PTY storm tests; `MINIMA_TUI_VIEWPORT=0` escape hatch for one release |
| Styled/plain wrap parity drift | single shared break-point engine + fuzz property test; per-line truncate failsafe |
| tmux re-encodes mouse/clipboard | test suite runs specs through tmux too; OSC 52 tmux passthrough wrapping |
| TrackB moves under us | rebase before PR; fixes are localized to files TrackB rarely touches now |

---

## Follow-up (2026-07-14): the per-render git fork + standard shortcuts

Field report after the first PR round (user running the B5 tip without this branch): scroll
banked into an invisible buffer then took seconds to catch up, with the terminal title
flapping `bun run`↔`git`.

**Root cause (both branches): `useRef(detectRepo(process.cwd()))`** — a `useRef` argument
is evaluated on EVERY render, and `detectRepo` forks `git rev-parse` synchronously
(`Bun.spawnSync`, ~10ms event-loop block per render). Wheel storms saturated the loop,
stdin backlogged, and Ctrl+C looked dead because its handler never ran. Same class:
`useState(isTipsEnabled())` re-read a config file per render. Fix: lazy `useState(() => …)`
initializers. The original soak missed it because the probe only timed window compute —
it now samples whole-render wall time and wraps `Bun.spawnSync`, and tui-verify asserts a
FLAT spawn count across the storm window plus render p95 < 100ms.

Also landed in this round:
- **Merged `fix/TUI-small-fixes` (B4 /undo + B5 /rewind)** into this branch; `initialValue`
  prefill seeds the rewritten TextInput's draftRef, `typedText` syncs so the prompt-box
  height matches a seeded multi-line draft.
- **Ctrl+Z job control** (`src/tui/suspend.ts`): teardown mirrors main.ts's shutdown writes,
  self-SIGTSTP; SIGCONT restores raw mode + alt screen + mouse/paste modes and repaints via
  a state bump. PTY-tested with a real SIGCONT (`signal` step in pty_capture).
- **Ctrl+D**: EOF quit on an empty draft; delete-forward otherwise. **Home/End** via an
  input-filter side-channel (Ink 5 swallows them). **Alt+←/→ / Alt+B/F** word jumps,
  **Alt+Backspace** kill-word. `/help` prints the full keyboard table.
- **Selection hint**: a click under mouse capture raises a 4s status-line hint (hold
  Option/Shift to select · /mouse off · Ctrl+Y copies last reply).
