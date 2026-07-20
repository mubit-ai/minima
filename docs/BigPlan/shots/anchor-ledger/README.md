# Anchor-ledger evidence — bottom-anchor defect class (reported 2026-07-20)

User report: composer/status/footer float mid-screen with dead rows below (both iTerm2 and
Terminal.app, dev build + brew, ~200×50 terminal); after an Ink overflow wipe the whole UI
sits squeezed in the top of the screen; giant blank gaps inside the live region.

`capture-specs.sh [before|after]` drives the matrix in a real PTY against the committed mock
provider (same pattern as tui_verify.sh). Classification per capture: `ESC[3J` count == 1
plus a bottom-anchor FAIL ⇒ **float class** (frame shrink log-update never compensates);
count > 1 ⇒ **wipe class** (live frame reached `rows`, Ink clearTerminal destroyed the
scrollback). raw.bin streams are not committed — re-run the script to regenerate.

## before (pre-fix, main @ 3bfd040)

| scenario | wipes | bottom-anchor | finding |
|---|---|---|---|
| overlay-teardown (120×36) | 1 | FAIL — low row 32/36 at t=20.6 | perm-overlay teardown float over a saturated estimate |
| overlay-teardown-200x50 | 1 | FAIL — low row 46/50 at t=20.6 | same, at the reporter's geometry; earlier runs also caught the wide-terminal stream-commit float (low 42/50 from t=10: at 200 cols the committed reply wraps to FEWER rows than the stream-frame shrink, so the MP20 commit-order fix alone cannot re-anchor) |
| panel-early (120×36) | 1 | PASS | idle panel open/close on a short transcript self-anchors — closePanelReseat covers close; OPEN needs no reseat |
| panel-stream (120×36) | 1 | PASS | always-panel (PR #186) over a live stream + Esc close self-anchors |
| resize-shrink (40→32 rows) | 1 | FAIL — low row 28/32, PERMANENT (no output after t=9.1) | the app repaints once at the new size and never re-anchors |
| resize-panel-wipe (panel open, 40→32) | **2** | recovers only via the panel-close reseat | Ink re-renders the old 38-row frame against 32 rows → clearTerminal wipe, scrollback destroyed |
