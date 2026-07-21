# Minima TUI — manual testing plan

Step-by-step manual verification of the `minima` TUI (`packages/tui`, Ink on Bun) as of the
Big Plan integration branch (`feat/BP-UX`: U1–U3, B1–B5, A1–A7, J1). Work top to bottom —
later sections assume the setup from §0. Automated coverage lives in `packages/tui/tests/`
(`bun test`) and the PTY-shot suite (`docs/BigPlan/shots/`); this plan is for the things a
human eye still verifies best: feel, timing, rendering, and end-to-end flows on a real
terminal.

Conventions: `▢` = check it off · **Expect:** what a pass looks like · every session uses a
scratch DB so your real history is never polluted.

---

## 0. Setup

```bash
cd packages/tui && bun install
export MINIMA_DB_PATH=/tmp/minima-manual.db     # scratch spine — delete between sweeps
alias mtui='bun run src/cli/main.ts'
```

- ▢ **Offline UI-only session**: `mtui --offline` — no keys needed; routing bypassed.
- ▢ **Zero-spend REAL turns** (tool calls, permissions, checkpoints) — run the mock provider
  from Appendix A in another terminal, then:
  `mtui --offline --model mock-model --provider mock --provider-url http://127.0.0.1:8399/v1`
- ▢ **Live session** (spends real money — keep it to one or two turns):
  `set -a; source .env.harness; set +a` from the repo root, then
  `mtui --offline --model claude-haiku-4-5 --provider anthropic`.
- ▢ **Big Plan sweep** (§7): Big Plan is on by default; use `MINIMA_TUI_BIG_PLAN=0` only
  for the explicit off-path checks.
- ▢ Run every sweep once in a **git repo** cwd and once in a **non-git** dir (checkpoint
  degrade paths differ — §6).

---

## 1. Startup & renderers

1. ▢ `mtui --offline` — **Expect:** fullscreen alternate-screen UI; prompt box glued to the
   bottom; status bar shows model, `route: auto`, `ctx 0% · ↑0 ↓0 · $0.0000`; keys row shows
   `ctrl+l Model · ctrl+r Route · ⇧tab Mode · ctrl+e Reason · esc Abort · ctrl+p palette`.
2. ▢ Quit with double `Ctrl+C` — **Expect:** "Ctrl+C again to quit" armed hint first; the
   terminal restores cleanly (no stuck alternate screen, cursor visible).
3. ▢ `mtui --offline --no-fullscreen` (or `MINIMA_TUI_INLINE=1`) — **Expect:** inline
   renderer; transcript commits to the terminal's native scrollback; wheel/select/copy are
   the terminal's own; prompt seated at the bottom on first paint.
4. ▢ Resize the terminal below ~60 columns and back — **Expect:** no crash; layout reflows;
   any open sidebar (§5/§7) closes itself when the width can't host it.
5. ▢ `mtui --help` — **Expect:** flags documented incl. `--resume`, `--provider-url`,
   `--budget`, `--slider`.

## 2. Conversation basics

1. ▢ With the mock provider: type `please update demo.txt to v2` + Enter — **Expect:**
   streaming reply; a `⚙ write` permission overlay (see §8); after the turn the footer
   updates `↑ ↓` tokens and `$`.
2. ▢ Mid-stream, press `Esc` — **Expect:** turn aborts gracefully; UI returns to ready;
   a second `Ctrl+C` within 2.5s force-quits (only needed on a wedged stream).
3. ▢ History recall: press `↑` / `↓` in the composer — **Expect:** previous prompts recalled;
   the in-progress draft survives a down-arrow return.
4. ▢ `/help` — **Expect:** command list including `undo`, `ckpt`, `rewind`, `verify`, `why`,
   `plan`, `resume`, `budget`.
5. ▢ Type `/` then `Tab` — **Expect:** command autocompletion. `Ctrl+P` — palette opens;
   `Esc` closes it.

## 3. Plan ↔ Build modes (B2)

1. ▢ Press `Shift+Tab` — **Expect:** prompt border turns magenta, label `plan mode`,
   footer badge `[PLAN]` on the right; `Shift+Tab` again returns to build (badge clears).
2. ▢ `/plan` — **Expect:** same toggle as Shift+Tab (Big Plan off: simple mode toggle with the
   "write/edit/bash/apply_patch ask first" notice).
3. ▢ In plan mode (mock provider), ask for a file edit — **Expect:** the permission overlay
   asks with prefix `plan mode — asks every time:`; answering `a` (always) still re-asks on
   the NEXT edit while plan mode is on (ask outranks always, by design).
4. ▢ In build mode, repeat — **Expect:** `a` (always) is honored; subsequent writes run
   without asking (`/perms` lists the grant).
5. ▢ `Ctrl+E` — **Expect:** thinking level cycles (status/notice), composer untouched.

## 4. Sessions & resume (B1)

1. ▢ `/name demo-session` then `/session` — **Expect:** name persisted and shown;
   `/rename demo2` renames; `/rename` with no arg shows the current name.
2. ▢ Run one mock turn, quit, relaunch with `--resume demo2` — **Expect:** transcript
   restored before first paint; resume notice with message count; footer `ctx% · ↑ ↓ · $`
   shows the REAL restored values (non-zero).
3. ▢ `--resume nosuch` — **Expect:** exits with code 2 listing near-matches; never silently
   starts a fresh session.
4. ▢ `/resume` in-session — **Expect:** session picker lists runs; selecting one loads it
   and records lineage (`/session` shows the parent).

## 5. Usage ledger & ToC (U1/U2)

1. ▢ After 2–3 mock turns, press `Ctrl+T` (fullscreen) — **Expect:** right-anchored sidebar
   OVER the transcript: one section per real prompt (slash echoes attach to the previous),
   per-section `$ · tok`, milestones (⚙ tools, ◆ result), Σ footer labeled `lead agent`;
   the transcript's characters-per-line underneath do NOT reflow.
2. ▢ Navigate `j/k`, press `Enter` on an old section — **Expect:** transcript jumps to that
   prompt; panel stays open; `Esc`/`Ctrl+T` closes; a draft typed BEFORE opening survives.
3. ▢ `Ctrl+T` while a turn is streaming — **Expect:** allowed (read-only browse).
4. ▢ Inline renderer: `Ctrl+T` — **Expect:** one-shot text ToC block instead of a panel.

## 6. Checkpoints, /undo, /rewind (B3/B4/B5) — run in a scratch GIT repo

Setup: `mkdir /tmp/undo-demo && cd /tmp/undo-demo && git init && git commit --allow-empty -m init`,
create `demo.txt`, commit, then start the mock-provider TUI here.

1. ▢ Run a mutating turn (mock writes `demo.txt`), then `/ckpt` — **Expect:** one `• after
   prompt 0 · turn · <sha7>` row; `git status` in another terminal shows YOUR index/worktree
   untouched apart from the agent's file change; `git for-each-ref refs/minima/ckpt/` shows
   exactly one ref.
2. ▢ `/undo` — **Expect:** file content reverted on disk; the undone turn disappears from
   the transcript; notice mentions the safety checkpoint; **composer prefilled with the
   undone prompt** ready to edit; footer stats recomputed.
3. ▢ Run two mutating turns, `/undo` twice — **Expect:** stacked walk-back (v2 → v1 → v0);
   a third `/undo` says there is no checkpoint left.
4. ▢ `/rewind` (fullscreen) — **Expect:** turn picker overlay, ✓ on code-restorable turns;
   on a selected turn `c`/`f`/`b` execute conversation/files/both; `Esc` closes.
   `/rewind 1 code` — files return to prompt 1's submission state, conversation intact.
5. ▢ Quit, relaunch, `--resume` the session — **Expect:** the rewound timeline replays
   (undone turns stay gone); `/ckpt` still lists all checkpoints incl. safety rows.
6. ▢ `/ckpt gc` — **Expect:** keeps current + 5 recent runs' refs; reports pruned count.
7. ▢ In a NON-git dir: first mutating turn — **Expect:** one-time notice "checkpoints off —
   not a git repository"; `/undo` and `/rewind <n> code` degrade with clear notices;
   `/rewind <n> convo` still works.

## 7. Big Plan (on by default)

1. ▢ `/bp` — **Expect:** "Big Plan: ON" with the run id. With `MINIMA_TUI_BIG_PLAN=0` —
   the OFF notice, and `Ctrl+G` prints "Big Plan is OFF…".
2. ▢ `/bp-seed` — **Expect:** seeded 3-step plan; footer plan strip `▸ plan 3/3 …` +
   `⚠ 1 off-plan (drift)` + `🟡 1 step flagged` + 🔴 prompt row; the composer is captured by
   the gate modal (`[a]ccept · [r]eject · [s]teer · [v]iew · esc to type`).
3. ▢ Gate modal: `v` — **Expect:** /why detail appears, modal stays armed. `Esc` — modal
   dismissed, typing works, `ctrl+g to answer` hint shows; `Ctrl+G` re-arms. `a` — records
   the signal, 🔴 row clears.
4. ▢ `Ctrl+G` (no armed gate) — **Expect:** Plan Overview panel: title + `step X/N`,
   per-step ⬜/🟦/✅ + 🟢/🟡/🔴, verify cmds, drift, Σ realized $; `Enter` opens the step
   card (baseline, check origin, gate history, evidence); `Esc` back, `Esc` close.
5. ▢ `/why` — **Expect:** per-step report + `plan gates:` section. `/why 1` — **Expect:**
   step 1's card with `evidence: red→green vs the captured baseline`.
6. ▢ `/audit` — **Expect:** plan lint report (vague steps, missing checks, allowlist holes).
7. ▢ `/verify` (mock or live provider) — **Expect:** "Refutation pass started…" busy state;
   verdict message (🟡 not refuted / 🔴 REFUTED with reasons); `/why` afterwards shows the
   judge milestone in `plan gates:`. `Esc` during the pass aborts it (nothing recorded).
8. ▢ Plan council: `/plan` with Big Plan on — **Expect:** council subcommands
   (start·status·finalize·cancel) per the /plan help; leaving plan mode via Shift+Tab tears
   the council session down with the "Plan session discarded" notice.
9. ▢ In plan mode with Big Plan on, ask the model to call `todowrite`/`task` — **Expect:** hard
   block with the explanatory reason (an "ask" can't make those safe).

## 8. Permissions

1. ▢ First `write` in build mode — **Expect:** yellow `permission` overlay with tool label,
   target/diff preview; `y` allows once, `n` denies (turn continues with the error), `a`
   grants always (`/perms` shows it).
2. ▢ `read`/`ls` outside granted dirs — **Expect:** prompt lists the directory; approving
   adds a dir grant shown in the footer `r-x N dirs`.
3. ▢ With Big Plan on, a `todowrite` carrying a NEW `verify` command — **Expect:** re-prompts even
   with an "always" grant (approving a verify authorizes running it as shell).

## 9. Budget & routing surface

1. ▢ `mtui --offline -b 1 --budget-enforce`, then `/budget` — **Expect:** limit shown; after
   a mock turn the spend registers; `/cost` lists the meter rows.
2. ▢ `Ctrl+R` — **Expect:** route mode toggles auto ↔ confirm (status bar reflects it).
3. ▢ `Ctrl+L` — **Expect:** model picker; pinning a model shows `▸ pinned` in the status bar.
4. ▢ Live only: run one routed turn without `--model` — **Expect:** `route:` shows the
   recommendation basis; `/cost` shows est vs actual.

## 10. Regression close-out (after any sweep that found a bug)

1. ▢ `bun test` green · `./node_modules/.bin/tsc --noEmit` · `bun run lint`.
2. ▢ Capture the repro as a PTY shot (`make tui-shot SPEC='…'` — see
   `packages/tui/scripts/pty_capture.py` docstring) and attach it to the issue.
3. ▢ Check both renderers before filing rendering bugs — fullscreen and
   `--no-fullscreen` differ by design.

---

## Appendix A — zero-spend mock provider

A ~40-line OpenAI-compatible SSE mock lets every "real turn" case above run without keys or
spend: reply to `/chat/completions` with a `tool_calls` delta chunk (e.g. a `write` of
`demo.txt`) when the LAST message is not a tool result, else a short text chunk; finish with
`data: [DONE]`. Point the TUI at it with
`--model mock-model --provider mock --provider-url http://127.0.0.1:8399/v1`
(an unknown provider name requires no API-key env). The B4/B5 PTY shots in
`docs/BigPlan/shots/` were produced exactly this way; timing gotchas (permission overlay
appears ~0.5s after submit; leave ≥3s between turn end and the next keystroke) are noted in
the pty_capture docstring.

## Appendix B — flag reference

| Env / flag | Effect |
|---|---|
| `MINIMA_DB_PATH` | SQLite spine location (use a scratch path for testing) |
| `MINIMA_TUI_INLINE=1` / `--no-fullscreen` | inline renderer (native scrollback) |
| `MINIMA_TUI_BIG_PLAN=0` | disable the default-on Big Plan spine for compatibility testing |
| `MINIMA_LLM_JUDGE=1` | real LLM judging (spends money; judge abstains by default) |
| `--provider-url URL` | OpenAI-compatible base URL for a custom `--provider` |
| `--resume NAME\|ID` | rehydrate a session before first render |
| `-b USD` / `--budget-enforce` | session budget warn / hard-enforce |
