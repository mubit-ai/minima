# Plan B — OpenCode-style sidebar (built on Plans C + A)

> **Status:** shipped on `feat/opencode-sidebar`. **Depends on:** Plan A's decision (inline
> stays the default; the sidebar is a fullscreen feature) and the committed PTY baselines in
> `docs/BigPlan/shots/baseline/` (the visual diff target).

## Design decisions (user-confirmed 2026-07-15)

1. **Info section in the ToC only** — a `Context` block (model · ctx % · ↑↓ tokens · $ spent,
   same sources as the StatusBar) pinned above the sidebar footer; the GT panel stays pure plan.
2. **Auto-open when wide** — fullscreen sessions on ≥100-col terminals start with the sidebar
   open and UNFOCUSED (Plan overview if the run already has a GT plan, else the ToC). Mount-only;
   Ctrl+T/Ctrl+G own the state afterwards.
3. **User block unchanged** — the `▸ you` styling stays (the echo-timing fix landed in Plan C).
4. **Minima accents kept** — cyan Contents / green Plan overview headers and cursor bars; the
   borderless chassis signals focus via the `▍` header prefix instead of border color.

## What changed

- **`layout.ts`** — `sidebarGeometry(cols, rows)` is FULL-terminal-height and borderless
  (`innerWidth = sidebarWidth − 3`: gutter 2 + right margin 1; null under 60 cols / 10 rows).
  New `sidebarOverlayGeometry` for the 45–59-col band: a full-height right-anchored overlay
  (`contentCols = cols`, no reflow), like OpenCode's narrow view. `SIDEBAR_CHROME_ROWS = 6` is
  the single chassis row budget. `tocPanelGeometry`/`clipPanelLines` untouched (rewind picker).
- **`sidebar-chassis.tsx` (new)** — shared borderless chassis: accent header, exact-budget body
  (`sidebarBodyRows`), optional info section, footer pinned to the terminal's last rows: cwd
  (`~`-abbreviated, last segment bold, display-width left-trim), `● Minima <version>` (from
  `src/version.ts`), key hint. `overlay` geometry → absolute + `alignSelf="flex-end"` overpaint.
- **`toc-panel.tsx` / `gt-panel.tsx`** — bordered Box → `SidebarChassis`; keyboard handling,
  hints, and cursor semantics byte-identical.
- **`app.tsx`** — two-column fullscreen root: LEFT column (chat region + status row + the ONE
  shared `footerBlock`) at `contentCols`, the sidebar beside it spanning every row; overlay
  panels render inside the column. Sidebar geometry moved ABOVE the footer math (it now feeds
  input wrapping + permission/question overlay widths via `contentCols`). Rewind gating moved to
  its own `overlayGeomRef` (its null conditions diverged from the sidebar's). Footer hardening:
  the keys legend is hard-clipped to one row and the plan banner truncates — at narrow
  `contentCols` both previously wrapped into rows `footerHeight` never budgeted (see
  `baseline/base-narrow.png`). Inline renderer untouched (text-block fallback stays).

## Verification

`bun test` (1122) · `tsc` · `biome` · `make tui-verify` (storm invariants on the restructured
tree) all green. After-shots mirroring each baseline: `u2-docked-toc-focused.png`,
`u2-docked-toc-unfocused.png`, `u3-gt-docked.png`, `u2-narrow-overlay.png`,
`b5-rewind-overlay.png`.
