# Decision: Inline renderer over fullscreen (ADR)

> **Status:** ACCEPTED — 2026-07-16. Binding unless new evidence (a custom renderer effort, or a
> terminal-protocol change that removes the fullscreen tradeoffs) is presented.
> **Supersedes:** the fullscreen-default proposal in the prior "OpenCode-style sidebars" plan.
> **Companion docs:** `inline-rendering-brief.md` (the *what* / build plan),
> `tui-rendering-strategy.md` (research + prose rationale), `pr-default-renderer.md` (the
> inline-stays-default decision record + verify decoupling).

This record exists so a future reader — human or agent — can understand **why** Minima renders
inline and does not pursue fullscreen, without re-running the analysis. If you want to re-open
this, §5 is the bar your new evidence must clear.

---

## 1. The decision

**Minima ships one renderer: inline (main buffer). Fullscreen / alternate-screen is not a product
direction.** The existing `--fullscreen` / `MINIMA_TUI_FULLSCREEN=1` code stays as a legacy opt-in
(removing it is unrelated risk and `make tui-verify` still exercises it), but **no new features
target fullscreen, and no feature requires the user to be in fullscreen.**

All UI we build — including the sidebar/panel features previously tied to fullscreen — is
delivered as **inline live-region panels** (see `inline-rendering-brief.md` §2 D3).

## 2. Context

Minima's TUI is built on **Ink** (React for CLIs, Yoga flexbox). Ink supports two render modes:

- **Inline (main buffer):** finished output commits to the terminal's native scrollback via
  `<Static>`; only a small live region (prompt + streaming reply) is re-rendered per frame.
- **Fullscreen (alternate screen, `\u001b[?1049h`):** a bounded, app-owned frame (`height={rows}`,
  `overflow="hidden"`) that the app repaints every tick; in-app scrolling via PgUp/PgDn or captured
  mouse.

Inline was already the recent default. A plan was proposed to **flip fullscreen to default** so an
OpenCode-style docked sidebar would be visible without opting in. That proposal forced this
decision: which renderer is Minima's product surface?

## 3. The decision drivers (evidence)

1. **The mainstream Ink ecosystem is inline-default.** Ink's own "Who's Using Ink?" list names
   Claude Code, Gemini CLI, and GitHub Copilot CLI — all Ink, all inline-default. `<Static>` is
   purpose-built for append-only scrollback, the cheapest possible render model for streaming chat.
   Choosing inline puts Minima on the proven, mainstream path; choosing fullscreen-default
   isolates it.
2. **Fullscreen loses a stack of native capabilities.** In the alternate screen the terminal has no
   scrollback, so the app must re-implement: scrolling, text selection, copy, search, and history
   persistence. Output doesn't survive exit (the screen is restored, no trace), can't be piped to a
   file or `grep`'d, and composes poorly with tmux panes, SSH sessions, and CI logs.
3. **The trackpad-scroll problem is dissolved by inline, manufactured by fullscreen.** Inline uses
   the terminal's native scrollback, so trackpad scroll + click-drag select + copy all work
   simultaneously, for free. Fullscreen must capture the mouse (`\u001b[?1000h`, which disables
   native selection) or use alternate-scroll mode (`\u001b[?1007h`, terminal-dependent). The user's
   "scroll feels broken in fullscreen" complaint is structural, not a bug.
4. **OpenCode's docked sidebar is not replicable in Ink.** OpenCode does **not** use Ink — its deps
   are `@opentui/core` + `@opentui/solid` (SolidJS) on **OpenTUI**, a custom framed renderer, and
   its docs list only WezTerm/Alacritty/Ghostty/Kitty as supported (Terminal.app excluded). Its
   full-height docked sidebar exists because of that custom renderer and modern-terminal stance.
   Matching it in Ink would require a multi-week renderer rewrite (essentially building OpenTUI),
   which is out of scope.
5. **The feature fullscreen unlocks (frame-anchored panels) is deliverable inline.** Bubble Tea —
   the other major TUI framework — explicitly markets apps "either inline, full-window, or a mix of
   both." The "mix" (overlay/footer panels over an inline base) is a recognized, shipped pattern.
   Minima can deliver the sidebar/ToC/GT as **inline live-region panels** without a frame.

## 4. Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Fullscreen default** (flip to make sidebar visible) | ❌ Rejected | Trades the mainstream native-UX stack (scroll/select/copy/tmux/CI/persistence) for one feature. Justification was circular ("fullscreen is needed so the sidebar shows; the sidebar shows because fullscreen"). Breaks tmux/SSH/CI users by default. |
| **Both renderers, sidebar fullscreen-only** | ❌ Rejected | Maintaining two renderers doubles the layout/test/perf surface. Forces users into fullscreen to reach core features. The sidebar is deliverable inline. |
| **Custom framed renderer (OpenTUI-style)** | ❌ Rejected | Multi-week rewrite of the rendering layer; drops the Ink ecosystem and its `<Static>` model. Far out of scope for the UX win. |
| **Inline-only; panels as live-region footer/overlay** | ✅ **Chosen** | Keeps every native capability; delivers the panel features inline; single renderer to maintain. Bounded by the live-region height invariant (§6). |

## 5. What would it take to reverse this?

Re-open only if **new evidence** clears one of these bars:

- A terminal protocol or Ink change removes fullscreen's tradeoffs (e.g., robust native selection
  under alt-screen everywhere, not just modern terminals), **or**
- Minima commits to a custom renderer (OpenTUI-style) that makes the docked-sidebar experience
  attainable without the alt-screen costs, **or**
- A measured user demand that the inline panel system (D3) genuinely cannot serve.

Absent one of these, the decision is closed. Re-debating it without new evidence is a process bug.

## 6. The constraint that makes inline panel design non-trivial

Choosing inline is correct, but it imposes one binding technical invariant that every inline panel
must respect:

> **The inline live region must stay strictly below `rows` tall.** If it reaches `rows`, Ink calls
> `clearTerminal` (`CSI 3 J`) and **wipes the entire scrollback** (all `<Static>` history).
> Documented at `packages/tui/src/tui/app.tsx:3597-3602`.

Consequences (handled in `inline-rendering-brief.md` §3/§4):
- "Full live-region panels" (Ctrl+T/Ctrl+G browsers) are `rows - footerChrome` tall, computed
  explicitly — never literally `rows`.
- Internal windowing (`clipPanelLines`, `layout.ts:603`) is mandatory for any panel whose content
  can overflow.
- The inline panel work ships behind a 1-hour PTY spike confirming a near-`rows` panel doesn't
  trigger the wipe.

This is the price of inline. It is accepted because the price of fullscreen (losing native
scroll/select/copy/etc.) is higher.

## 7. Consequences

**Gained (by choosing inline):**
- Native terminal scrollback, search, text selection, copy — all simultaneous, zero engineering.
- Trackpad/wheel scroll works for free; no mouse-capture / alternate-scroll engineering.
- Transcript persists after exit; pipeable to files/CI; composes with tmux/SSH.
- One renderer to build, test, and profile. Mainstream Ink-ecosystem alignment.

**Given up (the honest trade):**
- The OpenCode-style **full-height docked sidebar** is not attainable in Ink-inline. The sidebar
  becomes a footer-mounted panel + full live-region browser, bounded by §6.
- Overlays (absolute overpaint) are limited to the live region; `<Static>` content belongs to the
  terminal and cannot be overpainted (`rewind-panel.tsx:2`: "fullscreen renderer only").

**Unchanged:**
- The prompt-echo bug (`app.tsx:3459`) — the real source of perceived lag — is orthogonal to the
  renderer choice and gets fixed regardless (`pr-prompt-echo.md`).
- The fullscreen code stays in-tree as legacy opt-in; `make tui-verify` continues to exercise it
  (explicitly, per `pr-default-renderer.md`).

## 8. Why this is the right call, in one paragraph

Minima is an Ink-based streaming chat harness. The thing its users do — long streamed turns, code
blocks, tool output, scroll back through yesterday's run, copy a snippet — is exactly what inline
+ native scrollback is optimal for, and exactly what every other major Ink AI CLI chose. Fullscreen
exists to host frame-anchored panels, but those panels are deliverable inline (Bubble Tea's "mix"),
and the one product we wanted to copy (OpenCode) only has its panels because it runs a custom
renderer we are not building. Choosing inline keeps the native stack intact, dissolves the
trackpad problem outright, halves the maintenance surface, and costs us only the full-height
docked sidebar — a cosmetic we can approximate with a footer panel. The trade is decisively in
inline's favor.
