# MP4 spike — near-full inline panel vs the scrollback wipe (MUB-147)

**Verdict: PASS.** A `rows − (input + status)` panel mounts in the inline live region,
scrolls internally through 200+ cursor steps, and unmounts — with **zero** extra
`ESC[3J` (Ink clearTerminal) in the whole byte stream, the last grid row never painted,
and the pre-open 500-message transcript intact in native scrollback after close.
**MP5–MP9 are green-lit on the panel model** (guide §7 outcome taxonomy: Pass).

## What was proven, and how

Permanent gate: the `spike-panel` scenario in `packages/tui/scripts/tui_verify.sh`
(120×36 PTY over the committed 500-msg fixture resume, `MINIMA_TUI_SPIKE_PANEL=1`,
mock provider only — hermetic). Steps: Ctrl+T open → 200 × `j` (sent as 20 ten-key
chunks — Ink delivers a coalesced chunk as ONE input string, which panel_state.ts
iterates) → PgDn → PgUp → `G` → `gg` → Esc → Ctrl+D.

| assertion | result |
|---|---|
| `ESC[3J` count in raw stream | exactly 1 (the startup clear) |
| `?1049` (alt screen) | never |
| panel open latency after Ctrl+T | **0.01s** (budget 0.35s) |
| cursor after 200 j / PgDn+PgUp / G / gg | line 201 / line 201 / line 500 / line 001 |
| last grid row while panel open | blank across all 24 settled frames |
| post-close (pre-exit) frames | bottom-anchored (THE RULE holds) |
| transcript after close + clean Ctrl+D exit | present in main buffer |

## The height identity (why the wipe is unreachable)

`layout.ts`: `panelOuterHeight(rows, inputBoxHeight) = rows − SCROLLBACK_SAFETY_ROWS −
PANEL_STATUS_ROWS − inputBoxHeight`, with `PANEL_STATUS_ROWS = 4` (StatusBar margin + its
2 truncated rows + keys legend). Unlike the chatRegion path (conservative estimates), the
panel frame is **exact**: explicit `height` + `flexShrink={0}`, every row
`wrap="truncate"`, `clipPanelLines` pads short content, and suggestions / busy / GT rows /
ChildTree are suppressed while the panel is visible. So the live frame is *identically*
`rows − 2` — Ink's `outputHeight >= rows` wipe branch cannot fire. Pinned by the
layout.test.ts property loop (rows 12–60 × input growth × plan mode) and the PTY scenario.

## Perf (Q18 — the repaint-cost question)

`MINIMA_TUI_PERF` during the scenario: **median 2.55ms, p95 4.1ms**, max 321.9ms (the
one-time resume mount), 28 renders, 1 stdin listener, spawns flat. MP0 inline baseline
was p50 1.4ms — a near-full live region costs ~1ms extra per render. No mitigation
(React.memo etc.) needed.

## The one real finding: close-strand, and the fix

Closing the panel over a long transcript left the composer stranded at the TOP of the
screen: log-update rewrites a shrunken frame at the old frame's top row, and with the
transcript longer than the screen THE RULE's `bottomMountMinRows` was 0 (inert), so
nothing re-seated it. Fix (`app.tsx closePanelReseat`): closing moves the static-estimate
**basis** to the current message count — the panel covered the whole screen, so the
post-close frame starts from an effectively fresh screen; `bottomMountMinRows` goes full
and decays per committed message, exactly THE RULE's normal math. The post-close
bottom-anchor assertion in the scenario pins this.

## Evidence

- `docs/BigPlan/shots/mp4-spike/` — `mp4-open.png` (panel over the resume, ❯ line 001),
  `mp4-scrolled.png` (❯ line 500 after G), `mp4-closed.png` (composer back on the bottom
  rows) + `capture.sh` to reproduce.
- A/B flag-off gate: `ab_capture.sh`/`ab_compare.py` on this branch vs
  `inline-prompt-bottom` — all 5 scenarios (plain/toc/gt/b60/n55) byte-identical
  (only the standing `/gt-seed` UUID mask).

## What MP7 inherits

The spike view in `panel_state.ts`/`expand_panel.tsx` is deleted in MP7's first commit;
the chassis, reducer, `panelOuterHeight`, `closePanelReseat`, and the scenario's byte
assertions (rewritten over the real ToC as `panel-toc`) all stay.
