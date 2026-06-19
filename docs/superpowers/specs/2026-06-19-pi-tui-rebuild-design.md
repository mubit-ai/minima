# PI TUI Rebuild on Textual (Phases T0–T5)

- **Status:** approved 2026-06-19; executing T0
- **Approach:** B — faithful PI *UX* rebuilt on Textual's engine (not a 1:1 port of PI's bespoke `pi-tui` internals)
- **Reference:** `@earendil-works/pi` `packages/tui` + `packages/coding-agent` (MIT) — see `src/minima_harness/LICENSE_PI`

## Why rebuild

The Phase-1 TUI is a thin Textual shell: single-line `Input`, post-turn rendering from
`state.messages` (no live streaming), plain-text (no markdown), no overlays/autocomplete.
PI's `packages/tui` is a bespoke ~300KB immediate-mode framework (custom differential
renderer, a 77KB editor, markdown, overlays, autocomplete). PI is **not** Ink.

## Approach decision (B)

Reuse Textual for the hard primitives PI hand-built (diff rendering, synchronized output,
scroll, focus, modal screens). Rebuild PI's *components/UX* as Textual widgets. Verified
Textual 8.2.7 provides: `Markdown`, `OptionList`, `Tree`, `TextArea`, `ScrollableContainer`,
`ModalScreen`/`push_screen`, `Option`. **Not** available: `textual.autocomplete` (→ custom
autocomplete widget) and `textual.image` (→ optional, T5).

## Keep / replace

- **Keep:** harness layer (`MinimaAgent`, tools, session store); `bridge.py`; `commands.py`;
  `theme.py`; `editor.py` (submission parsing); `cli.py`; packaging.
- **Replace:** `app.py` post-turn render model; `widgets/transcript.py` (RichLog);
  single-line `Input`.

## Phases (each independently verifiable)

- **T0 — Streaming foundation.** `ChatLog(ScrollableContainer)` of message `Static`s; active
  assistant bubble `update()`s per token via `bridge.on_text` (throttled ~30ms); tool blocks
  render live. Verify: Pilot shows token-by-token growth hermetically.
- **T1 — Editor.** `TextArea`-based multiline; Enter/Shift+Enter; custom `/`-command +
  `Tab` file-complete popups (port `fuzzy.ts`); paste markers; border = thinking level.
- **T2 — Markdown.** Assistant turns via `textual.widgets.Markdown` (Pygments); stream plain,
  swap to markdown at message-end; collapsible tool output (Ctrl+O) + thinking (Ctrl+T).
- **T3 — Overlays + commands.** `/model` OptionList, `/tree` Tree (branch via `set_tip`),
  `/settings`, `/resume`, plus the rest — via `push_screen(ModalScreen)`.
- **T4 — Message queue + steering.** Enter-while-running=steer, Alt+Enter=follow-up,
  Esc=abort+restore; visible queue indicator.
- **T5 — Polish & parity.** CancellableLoader; header; live footer; theme swap; Ctrl+P model
  cycling; image paste (`textual-image`).

## Testing & risks

Hermetic-first: Textual `Pilot` per widget/overlay/command; fake-provider + `FakeMemory`.
Keep `test_app_pilot.py` green as the regression anchor. Risks: TextArea key-capture
(`priority` bindings / `on_key`); streaming perf (throttle + plain-during-stream); custom
autocomplete focus. Scope ~2–4 weeks; T0 delivers the biggest visible win.
