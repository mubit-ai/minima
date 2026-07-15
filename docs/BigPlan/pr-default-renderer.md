# Plan A — Renderer default: decision + verify decoupling

> **Status:** decision doc (read before Plan B). **Execution order:** lands alongside or
> before Plan C; its tiny code change is a prerequisite for Plan B's "no default flip" stance.
> **Worktree:** `/Users/eldaru/Mubit/Minima/minima-j1` · **Branch:** `feat/BP-UX` ·
> **Validated at SHA:** `1bd27b3` (line refs drift — re-pin at execution time).

This is the "settle the fullscreen-vs-inline default in isolation" step from the review. It is
**not** a feature. It records the decision, aligns the one verify harness that broke, and
explicitly does **not** flip the product default. Plan B (the sidebar) is built on this decision.

---

## The decision (one paragraph, argued on merit)

**Inline stays the default renderer.** The inline renderer draws into the terminal's main buffer
(`packages/tui/src/cli/main.ts:208`, `fullscreen: MINIMA_TUI_FULLSCREEN === "1" && MINIMA_TUI_INLINE !== "1"`),
so finished output commits to the terminal's **native scrollback** — wheel-scroll, click-drag-select,
and copy are the terminal's own, simultaneously, with no mouse capture (`main.ts:184-191, 633-636`).
That matches the project's stated reference model — the comment at `main.ts:633` labels inline
*"like Claude Code's REPL"* — and preserves the UX most terminal users expect (selectable output,
tmux-friendliness, transcript surviving exit, no `/mouse` toggle needed). The **only** advantage of
the fullscreen (alternate-screen) renderer is hosting frame-anchored overlays; that is a feature
fit problem (solved in Plan B by rendering the sidebar as an overlay in inline too), not a reason
to revert a deliberate default. Flipping the default to make a feature visible is backwards: decide
the renderer on merit, then make features fit it. **The default is correct as shipped; it stays.**

---

## Why this plan exists (what it replaces)

A prior plan ("OpenCode-style sidebars + instant user-prompt echo") proposed flipping the default
to fullscreen for two reasons, both rejected here:

1. *"The sidebar needs fullscreen to be visible by default."* — Rejected: Plan B renders the
   sidebar as an overlay in inline mode using the existing `tocPanelGeometry` overlay contract
   (`layout.ts:590`, already used by the rewind picker). No default change needed.
2. *"It also fixes the `make tui-verify` storm."* — Rejected as a **justification**: the verify
   harness broke because it relies on the default instead of passing an explicit renderer flag.
   The correct fix is to make the verify explicit about which renderer it tests (below), decoupling
   it from the default entirely. A stale spec must not dictate product behavior; decide the intended
   default, then align the spec to it.

---

## Steps (size: **S** — one harness edit + comment refresh)

**All paths relative to repo root.** Gate per change: `make tui-verify` green; `bun test` +
`bun run check` + `biome check src` clean (the TUI gate from `AGENTS.md`/`PLAN.md`).

**A1. Make `tui-verify` explicit about the renderer it tests.**
`packages/tui/scripts/tui_verify.sh` — its `cmd` array runs
`["bun", "run", "$TUI/src/cli/main.ts", "--offline", "--resume", "fixture-500"]` with **no
renderer flag**, so it silently inherits whichever default is current. Its header comment says
*"PTY verification for the fullscreen TUI"* and `tui_assert.py` asserts fullscreen invariants
(`prompt-stable`, `single-prompt`, `advancing`, `final-nonblank`). Add `"--fullscreen"` to the
`cmd` array so the scenario is deterministic regardless of the default. This is the whole fix for
the "storm": the default can be inline and the verify still tests fullscreen, because it now says
so explicitly. (Decision principle: a test that depends on a renderer **says so**, never inherits
it.)

**A2. (Optional, same commit) Align the assert's self-description.**
If `tui_assert.py` or the `.sh` header implies the default is fullscreen, correct the wording to
"tests the fullscreen renderer (invoked explicitly via `--fullscreen`)". No assertion logic changes
— only comments/help text that could re-mislead a future reader.

**A3. No change to `main.ts` default logic.** `main.ts:208` stays as-is. The `--fullscreen` /
`--no-fullscreen` / `--inline` flags and `MINIMA_TUI_FULLSCREEN` / `MINIMA_TUI_INLINE` env vars
are already correct and documented (`main.ts:185-191, 308-310`). Do not touch.

---

## Tests

- `tests/cli.test.ts` (default → inline / `--fullscreen` → fullscreen / env overrides) should
  already pin the inline default — confirm it still passes unchanged. If any case asserts the
  fullscreen default, that is the bug: fix the test to assert inline.
- `make tui-verify` must go green after A1 (it now drives fullscreen explicitly).
- `tests/render-buffer.test.ts` wording pin (if it references the default) — confirm consistent
  with inline-as-default.

## Verification

1. `cd packages/tui && bun test && bun run check && ./node_modules/.bin/biome check src`
2. `make tui-verify` — expected green (was the "storm").
3. One commit: `test(tui-verify): drive fullscreen explicitly so the default no longer affects the PTY suite` + push `feat/BP-UX`.

## Risks

- None material. If a *second* harness elsewhere inherits the default, surface it the same way
  (explicit flag). The principle generalizes: **never let a test depend on the product default.**
