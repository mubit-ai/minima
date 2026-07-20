# Inline rendering brief — footer panels, prompt echo, inline polish

> **Purpose:** self-contained briefing for a fresh agent/session. Read top-to-bottom; no prior
> conversation memory assumed. This is the **consolidated, decision-final** direction.
> **Worktree:** `/Users/eldaru/Mubit/Minima/minima-j1` · **Branch:** `feat/BP-UX` (PR #131 open).
> **Validated at SHA:** `1bd27b3` (line refs drift — re-pin at execution time).
>
> **Corrections (2026-07-16, validated against `4e7d989`):** (1) `pr-opencode-sidebar.md`
> *was* written and executed — the docked sidebar landed as PR #135 and is now slated for
> **removal** (Q&A decision Q2 = delete; see the guide's MP2/MP3). (2) **D1 (prompt echo) has
> shipped** — PR #133, merged into `feat/BP-UX`; PTY frames prove echo at t=8.01s before the
> first reply frame at t=10.29s. §2-D1 below is kept for the record. (3) The §1 clause "the
> existing `--fullscreen` code can stay as a legacy opt-in (do NOT rip it out)" is
> **superseded**: after trying fullscreen, the decision is full removal (flags, alt-screen,
> viewport, sidebar — ADR amendment in `decision-inline-renderer.md`), with `tui-verify`
> re-based on inline *first*. (4) SidebarChassis is removed with it — panel UI language is
> Claude Code inline, not the OpenCode chassis.
>
> **Execution now lives in [`inline-ux-guide.md`](inline-ux-guide.md)** (atomic mini
> projects MP0–MP19); this brief remains the design rationale for D2/D3.
>
> **Supersedes:** `docs/BigPlan/pr-opencode-sidebar.md` (executed, then reversed — see above).
> **Rides on:** `docs/BigPlan/pr-prompt-echo.md` (Plan C — shipped),
> `docs/BigPlan/pr-default-renderer.md` (Plan A — the "inline stays default" decision stands;
> its fullscreen-verify wording is now moot, see §6), `docs/tui-rendering-strategy.md` (§4
> reframed here).

---

## 1. The decision (final, do not re-litigate)

**Minima ships one renderer: inline (main buffer).** Fullscreen / alternate-screen is no longer a
product direction. Concretely:

- **Inline is the default and the focus.** Native terminal scrollback, native select/copy, works in
  tmux/SSH/CI, transcript persists after exit. This matches the entire Ink-based AI-CLI ecosystem
  (Claude Code, Gemini CLI, Copilot CLI — all Ink, all inline-default).
- **No fullscreen features will be built.** The existing `--fullscreen` flag / alt-screen code can
  stay as a legacy opt-in (do NOT rip it out — `make tui-verify` still exercises it and removal is
  risky/unrelated), but **no new work targets it.** Sidebars/panels are delivered inline only.
- **Why:** research confirmed the fullscreen tradeoff (frame-anchored UI) is not worth losing
  native scroll/select/copy/tmux/CI. OpenCode gets its docked sidebar only because it runs on a
  *custom framed renderer* (OpenTUI + SolidJS), not Ink — a multi-week rewrite we are NOT doing.
  Inline is the constraint; we design within it.

If you find yourself wanting to "just flip fullscreen on," re-read `docs/tui-rendering-strategy.md`
§7 first. The answer is no.

## 2. What we're building (three deliverables)

### D1 — Prompt-echo fix (ship first, independent)
**Already specced in `docs/BigPlan/pr-prompt-echo.md`.** Summary: `onSubmit` (`app.tsx:3459`)
never echoes the prompt — the user row appears only as a side-effect of the agent's `message_start`
event (`app.tsx:1428`) after recall+route (`runtime.ts:222`), so the prompt is invisible for
seconds and lost on route error. Fix = optimistic echo (push verbatim text at submit) + a
`pendingEchoRef` dedup + clear in `finally`. **This is the highest-impact, lowest-risk work. It is
the perceived-lag killer. Do it before anything else.**

### D2 — In-band inline polish (better message rendering + keystroke jump-to-message)
Two sub-parts, both inline-only, both replacing sidebar functionality with in-band UX:

- **Better message rendering.** Improve `MessageRow` (`src/tui/messages.tsx`, the `▸ you` header at
  `:135-144`) toward a Claude-Code-style clean block. Anchor on: verbatim prompt shown (lands free
  once D1 ships), readable assistant blocks, code blocks don't garble at narrow widths. Propose a
  specific styling pass (left accent bar? cleaner role headers?) and PTY-shot before/after.
- **Jump-to-message via keystroke** — *instead of* a sidebar. Replace the ToC's "click a section to
  jump" navigation with a keystroke-driven flow (e.g. Ctrl+J opens a fuzzy/numbered message picker
  in the live region; selecting jumps scroll to that message). No docked panel; the terminal's
  native scrollback does the actual scrolling. Design the interaction, then implement against the
  existing scroll plumbing.

### D3 — Footer-mounted panel system (the headline feature)
The thing the user actually wants, modelled on Claude Code's footer plan-tracker, extended to host
Ctrl+T (ToC) and Ctrl+G (Ground-Truth) as **full live-region browsers**:

- **D3a — Persistent compact footer panel (CC-style task tracker).** Always-on, small, lives in
  the inline live region just above the prompt. Shows current plan steps / task status sourced
  from `PlanSessionStore` (`planSessionRef.current`, `app.tsx:947`; steps refresh via `todowrite`
  per the comment at `app.tsx:932`). Bounded to a few rows so it never threatens the live-region
  height budget (see §3 constraint). Collapsible.
- **D3b — Ctrl+T / Ctrl+G expand to a full live-region panel with live updates + internal scroll.**
  Pressing Ctrl+T (`app.tsx:1739` → `requestTocSidebar`) or Ctrl+G (`app.tsx:1754` →
  `requestGtSidebar`) **expands the panel to near-full-viewport** (all but the prompt + footer
  chrome), shows the ToC / GT overview with **live updates** (the live region re-renders every
  Ink frame, so live is free), and is **internally scrollable** when content overflows (window via
  the existing `clipPanelLines`, `src/tui/layout.ts:603`). Closing it shrinks back to the compact
  footer panel. **All inline — no alternate screen.**

  Reroute the keybindings: today `requestTocSidebar`/`requestGtSidebar` open the fullscreen-docked
  panels (`sidebarGeometry`, `layout.ts:558`). Repoint them at the inline live-region panel.

## 3. The hard constraint (read twice)

**The inline live region must stay strictly below `rows` tall, or Ink calls `clearTerminal**
(`CSI 3 J`) and **wipes the entire scrollback** (all `<Static>` history). This is documented at
`app.tsx:3597-3602` and is the single most important invariant of the inline renderer.

Implications for D3:
- The "full live-region panel" (D3b) is not literally `rows` tall — it is `rows - footerChrome`
  where footerChrome reserves the prompt + status bar + the compact panel's collapsed state.
  Compute it explicitly from `rows` (see how `streamTailBudget` / `busyIndicatorHeight`
  `app.tsx:3660` already reserve live rows).
- Internal scrolling (windowing) is **mandatory** for D3b, not optional — the panel must cap its
  rendered rows at its budget regardless of content size, exactly as `clipPanelLines` already does
  for the fullscreen panels. Reuse that primitive; do not write a new windowing function.
- Profile with `make tui-verify` (after fixing it per Plan A) before AND after D3 — any regression
  in the perf budget likely means the live region crept toward `rows`.

## 4. The feasibility spike (do this before D3 code)

**Spike goal:** confirm a near-full-height panel renders correctly in the inline live region
(above the prompt, overpainting nothing in `<Static>`) **without** triggering `clearTerminal`,
and that internal windowing scrolls smoothly.

The risk: the live region is the only app-owned area in inline; `<Static>` content above it
belongs to the terminal and cannot be overpainted. A "full-page" panel in the live region is
feasible *in principle* (the live region can be large, just `< rows`), but the exact behavior
when it's near-`rows`-tall — especially interaction with streaming replies and the busy indicator
— needs a 1-hour PTY confirmation before committing to the full build.

**Spike deliverable:** a minimal `<TestPanel>` rendered in the live region at `rows - 3` for a
scrolling 500-line list, driven through the `pty_capture.py` harness. If scrollback survives a
full cycle (open panel → scroll → close → scrollback intact), green-light D3. If Ink wipes
scrollback, fall back to: D3b becomes a **transient panel that commits a snapshot to `<Static>`**
on close (print-once), and live updates are bounded to a small fixed-height strip. Pick after
evidence, not assumption.

## 5. Existing primitives to reuse (do not reinvent)

- **`clipPanelLines`** (`layout.ts:603`) — window `lines` to exactly `innerHeight` rows with a
  cursor visible. Use this for D3b's internal scroll.
- **`tailToFit` / `streamTailBudget`** (`app.tsx:3696`) — the pattern for bounding a live element
  to a row budget. Mirror it for the panel's height reservation.
- **`PlanSessionStore`** (`app.tsx:947`) — the data source for D3a's task list and D3b's GT
  overview. Steps refresh on `todowrite` (`app.tsx:932`).
- **Wheel coalescing** (`src/tui/input-filter.ts:31-42`) — if D3b should be wheel-scrollable in
  inline, wire the panel's internal scroll to `setMouseScrollCallback` the same way the fullscreen
  viewport does (`app.tsx:1270`). Note: in inline, mouse capture has the selection tradeoff —
  prefer **keystroke scroll** (j/k, arrows, PgUp/PgDn) for D3b to keep native selection intact.
- **`footerBlock`** (`app.tsx:4084`, rendered at `:4355` inline) — the shared footer (suggestions,
  busy, input, status bar). D3a's compact panel mounts just above this block.

## 6. What NOT to do

- **No alternate screen / no `--fullscreen` features.** Inline only. Don't touch `main.ts:208`
  default logic; don't add sidebar-in-fullscreen work.
- **No bundling.** D1 is its own commit/PR and lands first. D2 and D3 are separate. A bisect must
  isolate the echo fix from the panel work.
- **Do not let the live region reach `rows`.** This wipes scrollback (§3). Every D3 height change
  gets a PTY check.
- **Do not build a custom renderer (OpenTUI-style).** Out of scope. We live within Ink-inline.
- **Do not write another rendering-strategy doc.** This is the last one. New evidence → edit this
  file; do not fork.
- **`pr-default-renderer.md` (Plan A):** the "inline stays default" decision stands, but its step
  A1 ("make `tui-verify` pass `--fullscreen`") is now the *only* reason fullscreen code stays
  exercised at all — keep the verify explicit so it doesn't inherit a default we're de-emphasizing.

## 7. Sequencing

1. **D1 — prompt echo** (`docs/BigPlan/pr-prompt-echo.md`). Independent. Ship first. Verify: PTY
   shot with a slow mock shows the user block before any reply.
2. **Spike (§4).** 1-hour PTY confirmation that a near-full live-region panel doesn't wipe
   scrollback. Gate for D3.
3. **D3a — compact footer panel.** Small, always-on, bounded rows. Lowest-risk slice of D3.
4. **D3b — Ctrl+T/Ctrl+G full live-region browser** with internal scroll. Reroute the keybindings
   at `app.tsx:1739`/`:1754`. Depends on spike green.
5. **D2 — message rendering + keystroke jump-to-message.** Can interleave with D3; independent of
   the panel system.

## 8. Gate (every commit)

`cd packages/tui && bun test && bun run check && ./node_modules/.bin/biome check src` + a PTY shot
under `docs/BigPlan/shots/` + `make tui-verify` (perf budget intact). Conventional commit messages;
one logical change per commit; push `feat/BP-UX`.

## 9. References

- `docs/BigPlan/pr-prompt-echo.md` — D1 full spec.
- `docs/BigPlan/pr-default-renderer.md` — the inline-default decision record.
- `docs/tui-rendering-strategy.md` — the research + rationale (inline vs fullscreen, OpenCode =
  OpenTUI not Ink, Bubble Tea "mix" model). §7 ("what NOT to do") is binding.
- `packages/tui/src/tui/app.tsx` — render tree, live region, keybindings, plan state.
- `packages/tui/src/tui/layout.ts` — `clipPanelLines`, the geometry primitives.
- `packages/tui/scripts/pty_capture.py` + `tui_verify.sh` — the PTY harness for the spike and gate.
