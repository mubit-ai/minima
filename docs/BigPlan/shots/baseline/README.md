# Sidebar/footer PTY baselines — visual diff target for the OpenCode-sidebar restructure

Captured at `1bd27b3` (pre-restructure), 2026-07-15, via `capture-specs.sh` (mock provider
on :8399, fresh `MINIMA_HARNESS_DIR` per scenario, PNGs re-pointed here).

| Shot | Shows (current state) |
| --- | --- |
| `base-toc-wide.png` | 120×36 fullscreen: bordered round ToC panel confined to the chat region, mostly empty body, no footer/cwd/version |
| `base-gt-wide.png` | Ground-Truth panel, same bordered chassis, chat-region height |
| `base-narrow.png` | 55 cols: no panel (one-shot `⚙ toc:` text) AND the keys legend garbles/wraps — the footer-wrap hazard the restructure must fix |
| `base-echo-gap.png` | The prompt-echo bug pre-fix (PR #133): 3s after submit, routing spinner running, prompt rendered nowhere |
| `base-inline-default.png` | Inline default renderer: sidebar unavailable, ToC as text block (stays this way — see `docs/BigPlan/pr-default-renderer.md`) |
