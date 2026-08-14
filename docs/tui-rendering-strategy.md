# TUI Rendering Strategy: what Minima should render, and when to stop debating it

> **Status:** decision + rationale. Supersedes the inline-vs-fullscreen thread in
> `docs/BigPlan/pr-default-renderer.md` and the prior "OpenCode-style sidebars" bundled plan.
> **One-line answer:** fullscreen default, inline one flag away, both renderers shipped,
> no sidebar system, and the prompt-echo lag is fixed.
>
> **Stop condition:** this doc is closed on arrival. If you re-open the "which renderer" question
> without new evidence, that's a process bug, not a design question.

---

## 0. Why this doc exists (and the anti-pattern it's killing)

`docs/` currently holds ~30 planning/analysis markdown files. The inline-vs-fullscreen question
has been deliberated across multiple sessions without a shipped change. The cheapest way to
reduce lag in this project is to stop writing rendering strategy docs and start deleting
rendering-related latency. This file is the last one. Its goal is to make the decision
*boring* so implementation can start.

## 1. The decision

> **Amended three times (the table below is the current state, not the original one):** on
> 2026-07-16 the decision went further than opt-in: fullscreen was removed entirely, the
> sidebar/panel UI became inline-only (the D3 footer-panel system replaced the sidebar), the
> `?1007h` spike died with the renderer it served, and Terminal.app went out of the support
> matrix. On 2026-07-31 fullscreen was re-introduced as an opt-in (the ADR's reversal bar
> cleared by Claude Code v2.1.89 shipping the same mode) and, later the same day, promoted
> to the boot default on user decision. The sidebar stayed dead. See
> `docs/BigPlan/decision-inline-renderer.md` (all three amendments) and
> `docs/BigPlan/inline-ux-guide.md` (execution).

| Question | Answer | Why (one line) |
|---|---|---|
| Default renderer? | **Fullscreen (alt screen)** | User decision 2026-07-31 after living in the opt-in mode: sticky composer + in-app scroll without typing `--fullscreen` every boot. Resolution is explicit flag > env > per-project persisted `/fullscreen` pref > fullscreen (`cli/main.ts:1270`). |
| Inline (main buffer)? | **One flag away** (`--inline` / `--no-fullscreen` / `MINIMA_TUI_INLINE=1` / `/fullscreen` off, persisted per project) | Mainstream Ink-ecosystem choice (Claude Code, Gemini CLI, Copilot CLI all default inline); native scroll/select/copy/persistence; composes with tmux/SSH/CI. |
| Sidebar? | **Deleted** — Ctrl+T (ToC) and Ctrl+G (plan overview) print one-shot text blocks | The overlay-in-both path was never built; a text block is honest, cheap and renderer-agnostic (§5). |
| Trackpad scroll in fullscreen? | **Wheel capture** (`\u001b[?1000h` + `?1006h`, `app.tsx:1635`), with Option/Shift-drag, `/mouse` and Ctrl+Y as the selection escape hatches | The `?1007h` alternate-scroll spike was never taken; modern terminals hand selection back under modifier-drag. |
| Terminal.app support? | **Out of the support matrix** (2026-07-16 amendment) | Don't keep degrading the modern-terminal experience to paper over Terminal.app. |

**Net:** the work this doc scoped is finished. The prompt echo shipped, the sidebar was deleted
rather than built, the scroll-mode spike was skipped in favour of wheel capture, and the default
flipped to fullscreen. What remains is keeping both renderers honest (§3).

## 2. Evidence (from research, not opinion)

- **Wikipedia / ANSI escape code:** the alternate screen is `CSI ? 1049 h/l`; `CSI 3 J` wipes
  scrollback, which is exactly why Ink's `clearTerminal` forces Minima to bound its inline live
  region (`app.tsx:3597-3602`). The buffer mechanics are terminal-level, not preferences.
- **Ink docs:** `<Static>` "permanently renders its output above everything else… only renders new
  items and ignores items that were previously rendered." That append-only commit is the cheapest
  possible render model for streaming chat, and it's *why* every major Ink-based AI CLI defaults
  inline. Minima is Ink-based → inline stays the cheap path and is kept fully supported; the
  fullscreen frame pays its repaint cost knowingly (§3c) in exchange for the sticky composer.
- **OpenCode does NOT use Ink.** Its deps are `@opentui/core` + `@opentui/solid` (SolidJS) on a
  custom renderer. Its docs list only WezTerm / Alacritty / Ghostty / Kitty as supported
  terminals; Terminal.app is excluded. That's how OpenCode gets trackpad-scroll *and* text
  selection simultaneously: modern terminals provide selection under mouse capture (modifier-
  drag: Option in iTerm2, Shift in kitty/Ghostty/WezTerm), and/or via alternate-scroll mode. The
  "mouse capture disables selection" tax is a *Terminal.app* problem, not a universal one.
- **Bubble Tea** explicitly markets itself for apps "either inline, full-window, or a mix of both."
  The "mix" (overlay panels over an inline base) is a recognized, shipped pattern, not a
  research bet. It was the model proposed for Minima's sidebar; Minima did not take it (§5).

## 3. Avoiding lag (the real kind: rendering perf)

There are two lag sources: one is killed, one is mitigated.

### 3a. The perceived-lag killer: prompt echo (shipped)
`onSubmit` used to never echo the prompt: the user row appeared only as a side-effect of the
agent's `message_start` event, which fires after recall+route, so for seconds (or a whole
plan council round) the submitted prompt was invisible, and a route error lost it entirely.
This was the single biggest "feels laggy" complaint and it had nothing to do with the
renderer. Fixed as planned (`docs/BigPlan/pr-prompt-echo.md`, Plan C): `onSubmit` pushes the
verbatim prompt into `messages` before recall/route and sets `pendingEchoRef` (`app.tsx:5076`),
and the loop's later `message_start(user)` is deduped through that ref, whose single-slot
discipline `tests/behavior.test.ts` pins.

### 3b. Inline rendering: keep it cheap by construction
The inline renderer is already near-optimal *because* of Ink's `<Static>` model:
- Finished messages commit once to scrollback and are never re-diffed (`app.tsx:4066`).
- Only the live region (streaming reply + busy + input) re-renders per frame.
- **Invariant to preserve:** the live region must stay strictly below `rows`, or Ink calls
  `clearTerminal` (`CSI 3 J`) and wipes the scrollback (`app.tsx:3597-3602`). The
  `streamTailBudget` / `tailToFit` bounding (`app.tsx:3696`) exists for exactly this: don't
  remove it, and don't add unbounded live elements above the footer.

### 3c. Fullscreen rendering: the expensive path, already mitigated
Fullscreen repaints the whole bounded frame every tick (`height={rows}`, `overflow="hidden"`,
`app.tsx:3926`). That's the inherent cost of an app-owned frame. Minima already does the right
things:
- **Windowed viewport** — only the visible slice renders (`view.lines`, `app.tsx:3944`), not all
  history.
- **Wheel coalescing** — the input filter nets a burst of notches into one ~30Hz callback
  (`input-filter.ts:31-42`), so a fast trackpad flick = one repaint, not fifty.
- **Perf gate** — `make tui-verify` asserts the `MINIMA_TUI_PERF` budgets. The suite is
  renderer-explicit now (Plan A, done): the `fs-*` scenarios pass `--fullscreen`
  (`tui_verify.sh:1578`), every inline scenario pins `--inline` via `INLINE_ARGV`, and
  `fs-persist` proves the bare-boot default. **Still open:** the `MINIMA_TUI_PERF` scenarios all
  run under `INLINE_ARGV`, so the budgets are not yet exercised on the now-default fullscreen path.

The fullscreen perf risk to *watch* (not yet a problem): any new full-height element (a pinned
footer, an always-on panel) adds rows to every repaint. Keep such chrome's row count in one
constant and profile with `make tui-verify` before and after.

## 4. Usability, in impact order

1. **Prompt echo** (Plan C). Highest impact, lowest risk, independent of everything else. **Shipped** (§3a).
2. **Alternate scroll mode spike** — not taken. Fullscreen ships wheel capture instead
   (`app.tsx:1635`); `\u001b[?1007h` appears nowhere in the source. Selection comes back
   via Option/Shift-drag, `/mouse` or Ctrl+Y.
3. **Sidebar as overlay** (Plan B restructured) — not built. The sidebar system was deleted
   instead; Ctrl+T and Ctrl+G print one-shot text blocks (§5).
4. **Mouse-on-by-default** — effectively adopted with the fullscreen default: wheel capture is
   on in the alt screen. The `/mouse` toggle still frees the wheel and prints the modifier-drag
   hint (`app.tsx:3879`), and the inline renderer never captures the mouse at all.

## 5. The sidebar, and why there isn't one

The features this doc scoped (OpenCode-style sidebar, Ctrl+T/Ctrl+G, full-height borderless panel
with cwd + version footer) were not delivered as panels in either renderer. The sidebar system was
deleted (`inline-ux-guide.md` MP2): no `sidebarGeometry`, no `SidebarChassis`, no auto-open, and
`tests/behavior.test.ts` asserts the absence of those symbols so they cannot creep back in.

What shipped instead, and what to reuse:

- **One-shot text blocks.** Ctrl+T prints a table of contents and Ctrl+G a plan overview into the
  transcript (`renderTocText` / `renderPlanOverviewText`, clipped to `cols - 6`). This is the
  text-snapshot fallback this doc named, adopted as the answer rather than the consolation
  prize. It is cheap and renderer-agnostic, and it survives scroll and copy in both renderers.
- **The panel seam.** Live-region panels that do render chrome measure themselves through
  `panelOuterHeight` and `clipPanelLines` (`src/tui/layout.ts`); see `src/tui/expand_panel.tsx`.
  That is the contract to reuse if a panel is ever wanted again. The rewind picker's model lives in
  `src/tui/rewind_picker.ts` (pure, no React) and is worth reading first.

**The crux that killed the overlay:** an absolute-positioned overlay over Ink's `<Static>` live
region in the main buffer was never confirmed to render reliably. The live region is the only
app-owned area, and `<Static>` content belongs to the terminal. The fullscreen frame has no such
constraint, but the ADR's "no feature may require fullscreen" line rules out building the panel
only there.

## 6. Sequencing (all of it resolved)

1. **Plan C — prompt echo.** Shipped (§3a). (`docs/BigPlan/pr-prompt-echo.md`)
2. **Plan A — verify decoupling.** Done: `tui_verify.sh` runs the fullscreen scenarios with an
   explicit `--fullscreen` and pins every inline scenario with `--inline`. The decision it recorded
   (inline stays default) was itself superseded on 2026-07-31.
   (`docs/BigPlan/pr-default-renderer.md`)
3. **Alternate-scroll spike.** Not taken; wheel capture ships instead (§4.2).
4. **Plan B — sidebar overlay.** Not taken; the sidebar was deleted (§5).
   (`docs/BigPlan/pr-opencode-sidebar.md`)

Nothing here is open. The only outstanding item in this doc is the perf-budget gap in §3c.

## 7. What NOT to do

- **Do not re-litigate the renderer default.** It flipped to fullscreen on 2026-07-31 after the
  user lived in the opt-in mode; inline stays fully supported one flag away for tmux/SSH/CI and for
  anyone who wants native scroll/select/copy. Re-opening it needs new evidence clearing the ADR's
  §5 bar, as the 2026-07-31 re-introduction did.
- **Do not make a feature require one renderer.** Anything that only works in the alt screen, or
  only in the main buffer, re-opens this whole debate. Both paths ship; features fit both.
- **Do not write another rendering-strategy doc.** This is the last one. New evidence → append a
  section here or edit a row in §1; do not fork a new file.
- **Do not resurrect the sidebar as a geometry system.** The one-shot text blocks are the shipped
  answer (§5), and a regression test pins the deleted symbols out of the source.
