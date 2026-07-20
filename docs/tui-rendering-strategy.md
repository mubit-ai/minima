# TUI Rendering Strategy — what Minima should render, and when to stop debating it

> **Status:** decision + rationale. Supersedes the inline-vs-fullscreen thread in
> `docs/BigPlan/pr-default-renderer.md` and the prior "OpenCode-style sidebars" bundled plan.
> **One-line answer:** inline default, fullscreen opt-in, sidebar as an **overlay in both**,
> fix the prompt-echo lag first, and ship the sidebar *after* — not before.
>
> **Stop condition:** this doc is closed on arrival. If you re-open the "which renderer" question
> without new evidence, that's a process bug, not a design question.

---

## 0. Why this doc exists (and the anti-pattern it's killing)

`docs/` currently holds ~30 planning/analysis markdown files. The inline-vs-fullscreen question
has been deliberated across multiple sessions without a shipped change. **The cheapest way to
reduce lag in this project is to stop writing rendering strategy docs and start deleting
rendering-related latency.** This file is the last one. Its goal is to make the decision
*boring* so implementation can start.

## 1. The decision

> **Amended 2026-07-16 (rows 2–5 superseded):** the final decision went further — fullscreen is
> **removed entirely** (not kept opt-in), the sidebar/panel UI is **inline-only** (the D3
> footer-panel system replaces the sidebar), the `?1007h` spike is dead with the renderer it
> served, and Terminal.app is **out** of the support matrix. See
> `docs/BigPlan/decision-inline-renderer.md` (amendment) and
> `docs/BigPlan/inline-ux-guide.md` (execution).

| Question | Answer | Why (one line) |
|---|---|---|
| Default renderer? | **Inline (main buffer)** — no change | Mainstream Ink-ecosystem choice (Claude Code, Gemini CLI, Copilot CLI all default inline); native scroll/select/copy/persistence; composes with tmux/SSH/CI. |
| Fullscreen? | **Opt-in** (`--fullscreen` / `MINIMA_TUI_FULLSCREEN=1`) | Kept for the power-user frame: docked sidebar, overlays, in-app scroll. |
| Sidebar? | **Overlay that works in both renderers** | Bubble Tea calls this "a mix of both"; reuses Minima's existing overlay contract (`tocPanelGeometry`, `layout.ts:590`). No default flip needed. |
| Trackpad scroll in fullscreen? | **Alternate scroll mode spike (`\u001b[?1007h`)** first; mouse-capture (`/mouse`) as the fallback | `?1007h` gives wheel→arrows *without* disabling selection on modern terminals. |
| Terminal.app support? | **Best-effort, not a constraint that blocks UX** | Don't keep degrading the modern-terminal experience to paper over Terminal.app. |

**Net:** no product default changes. The work is (a) one bug fix, (b) one overlay path, (c) one
scroll-mode spike. Everything else is already built.

## 2. Evidence (from research, not opinion)

- **Wikipedia / ANSI escape code:** the alternate screen is `CSI ? 1049 h/l`; `CSI 3 J` wipes
  scrollback — which is exactly why Ink's `clearTerminal` forces Minima to bound its inline live
  region (`app.tsx:3597-3602`). The buffer mechanics are terminal-level, not preferences.
- **Ink docs:** `<Static>` "permanently renders its output above everything else… only renders new
  items and ignores items that were previously rendered." That append-only commit is the cheapest
  possible render model for streaming chat, and it's *why* every major Ink-based AI CLI defaults
  inline. Minima is Ink-based → the inline default is the native choice, not a compromise.
- **OpenCode does NOT use Ink.** Its deps are `@opentui/core` + `@opentui/solid` (SolidJS) on a
  custom renderer. Its docs list **only** WezTerm / Alacritty / Ghostty / Kitty as supported
  terminals — Terminal.app is excluded. That's how OpenCode gets trackpad-scroll *and* text
  selection simultaneously: **modern terminals provide selection under mouse capture** (modifier-
  drag: Option in iTerm2, Shift in kitty/Ghostty/WezTerm), and/or via alternate-scroll mode. The
  "mouse capture disables selection" tax is a *Terminal.app* problem, not a universal one.
- **Bubble Tea** explicitly markets itself for apps "either inline, full-window, or a mix of both."
  The "mix" — overlay panels over an inline base — is a recognized, shipped pattern, not a
  research bet. That's the model for Minima's sidebar.

## 3. Avoiding lag (the real kind — rendering perf)

There are two lag sources. One is cheap to kill, one is already mitigated.

### 3a. The perceived-lag killer: prompt echo (do this first)
`onSubmit` (`app.tsx:3459`) never echoes the prompt. The user row appears only as a side-effect of
the agent's `message_start` event (`app.tsx:1428`), which fires **after** recall+route
(`runtime.ts:222`) — so for seconds (or a whole plan council round) the submitted prompt is
invisible, and a route error loses it entirely. **This is the single biggest "feels laggy"
complaint and it has nothing to do with the renderer.** Fix: optimistic echo + dedup ref (see
`docs/BigPlan/pr-prompt-echo.md`, Plan C). Land this before touching anything else.

### 3b. Inline rendering — keep it cheap by construction
The inline renderer is already near-optimal *because* of Ink's `<Static>` model:
- Finished messages commit once to scrollback and are never re-diffed (`app.tsx:4066`).
- Only the live region (streaming reply + busy + input) re-renders per frame.
- **Invariant to preserve:** the live region must stay strictly below `rows`, or Ink calls
  `clearTerminal` (`CSI 3 J`) and wipes the scrollback (`app.tsx:3597-3602`). The
  `streamTailBudget` / `tailToFit` bounding (`app.tsx:3696`) exists for exactly this — don't
  remove it, and don't add unbounded live elements above the footer.

### 3c. Fullscreen rendering — the expensive path, already mitigated
Fullscreen repaints the whole bounded frame every tick (`height={rows}`, `overflow="hidden"`,
`app.tsx:3926`). That's the inherent cost of an app-owned frame. Minima already does the right
things:
- **Windowed viewport** — only the visible slice renders (`view.lines`, `app.tsx:3944`), not all
  history.
- **Wheel coalescing** — the input filter nets a burst of notches into one ~30Hz callback
  (`input-filter.ts:31-42`), so a fast trackpad flick = one repaint, not fifty.
- **Perf gate** — `make tui-verify` asserts the `MINIMA_TUI_PERF` budgets. **Fix this suite to
  pass `--fullscreen` explicitly** (`tui_verify.sh` currently inherits the default — Plan A) so
  the perf contract is enforced regardless of the default.

The fullscreen perf risk to *watch* (not yet a problem): any new full-height element (a borderless
sidebar chassis, a pinned footer) adds rows to every repaint. Keep the sidebar's chrome row count
in one constant (`SIDEBAR_CHROME_ROWS`) and profile with `make tui-verify` before and after.

## 4. Usability, in impact order

1. **Prompt echo** (Plan C). Highest impact, lowest risk, independent of everything else. **Ship today.**
2. **Alternate scroll mode spike** — write `\u001b[?1007h` on fullscreen enter; handle the
   resulting arrow sequences as scroll. If it works on iTerm2/Ghostty/kitty/WezTerm, fullscreen
   trackpad scroll "just works" with native selection intact. ~half-day spike; contained.
3. **Sidebar as overlay** (Plan B restructured) — the OpenCode *look* delivered as an overlay
   panel in both renderers, using the existing `tocPanelGeometry` contract. No default flip.
4. **Mouse-on-by-default** — *only* if you decide to adopt OpenCode's "modern terminals only"
   stance. Otherwise keep the `/mouse` toggle; it already works and already prints the
   modifier-drag hint (`app.tsx:4000`).

## 5. Delivering the features you want, without the default flip

The features you actually want — OpenCode-style sidebar, Ctrl+T/Ctrl+G, full-height borderless
panel with cwd + version footer — do **not** require fullscreen to be the default. They require a
render path:

- **Overlay in inline:** the sidebar renders as a right-anchored, absolute-positioned panel over
  the live region, using `tocPanelGeometry` (`layout.ts:590`) — the same contract the rewind picker
  already uses (`rewind-panel.tsx`, `app.tsx:3795`). Inline keeps native scroll/select/copy; the
  sidebar floats.
- **Docked in fullscreen:** the existing `sidebarGeometry` in-flow dock (`layout.ts:558`) stays for
  the opt-in fullscreen users who want the transcript to reflow around the panel.
- **Shared borderless chassis:** one component (`SidebarChassis`) wraps both — bold header (accent
  cyan/green), gray body, pinned `cwd` + `● Minima {VERSION}` (`src/version.ts:9`) footer. Both
  renderers get the OpenCode look from one implementation.

**Crux to resolve before coding the overlay-in-inline:** confirm an absolute-positioned overlay
renders correctly over Ink's `<Static>` live region in the main buffer (the live region is the only
app-owned area; `<Static>` content belongs to the terminal). If overlay-in-inline proves fragile,
the fallback is the **text-snapshot** path (already used for too-narrow screens) — print a one-shot
contents block. Honest, cheap, not pretty. Pick after a 1-hour spike, not after another doc.

## 6. Sequencing (the only plan you need from here)

1. **Plan C — prompt echo.** Independent. Ship first. (`docs/BigPlan/pr-prompt-echo.md`)
2. **Plan A — verify decoupling.** Make `make tui-verify` pass `--fullscreen` explicitly; record
   the inline-stays-default decision. (`docs/BigPlan/pr-default-renderer.md`)
3. **Alternate-scroll spike.** Half-day experiment; lands trackpad scroll in fullscreen.
4. **Plan B — sidebar overlay** (rewritten around the overlay-in-inline spike outcome).
   (`docs/BigPlan/pr-opencode-sidebar.md` — pending rewrite)

No step blocks step 1. Start there.

## 7. What NOT to do

- **Do not flip the renderer default to fullscreen** to make the sidebar visible. That trades the
  mainstream, native-scroll experience for a feature, and breaks tmux/SSH/CI users. The sidebar
  fits the renderer, not the other way around.
- **Do not write another rendering-strategy doc.** This is the last one. New evidence → append a
  section here or edit a row in §1; do not fork a new file.
- **Do not bundle the prompt-echo fix with the sidebar work.** Different risk profiles, different
  review cadences, different PRs.
- **Do not optimize fullscreen repaint performance before fixing the prompt echo.** The echo is the
  lag users actually feel.
