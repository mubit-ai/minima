# Inline UX Guide — atomic mini projects

> **This file is the source of truth for TUI/UX execution.** It supersedes `PLAN-retired.md`
> (the completed Big Plan build-out) and turns the direction fixed in
> `inline-rendering-brief.md` + `decision-inline-renderer.md` into **atomic mini projects
> (MPs)** — each buildable by one agent session in one sitting, each verified before the next
> begins. Decisions here came from the 2026-07-16 60-question Q&A; they are recorded in §2 and
> are **binding**. New evidence → edit this file, don't fork.
>
> **Worktree:** `/Users/eldaru/Mubit/Minima/minima-j1` · **Branch:** `feat/BP-UX` (PR #131 →
> main, open) · **Line refs:** validated at `4e7d989` — re-pin at execution time.

---

## 1. The protocol (how each MP runs)

One MP at a time, in this loop:

1. **Pick the next MP** (dependency graph §4). Its Linear issue is listed in §10.
2. **Branch** `mp<N>-<slug>` off `feat/BP-UX` (after PR #131 merges: off `main`).
3. **Hand the agent this file**: §2 (decisions) + §3 (budgets/matrix) + the MP's section.
   Each MP section is written to be a self-contained agent brief.
4. **Verification first — mandatory.** The agent's first commit-worthy artifact is the
   *check*, not the code: a failing bun test, a PTY spec, or a baseline shot the change must
   visibly diff against. Red before green — the same discipline GT imposes on the agent.
5. **Agent proves with PNG.** Every MP with visible UX ends with `pty_capture.py` shots
   (PNG + frames JSONL where timing matters) committed under `docs/BigPlan/shots/<mp>-*.png`.
   Fresh `MINIMA_HARNESS_DIR` per scenario (mode-ring persistence carries over otherwise).
6. **You test manually** using the MP's "Manual test" script (primary terminal, §3).
7. **Gate** (every MP): `cd packages/tui && bun test && bun run check &&
   ./node_modules/.bin/biome check src` + `make tui-verify` (budgets intact) + shots committed.
8. One PR per MP → merge → **compact the session** → next MP.

**Sizes:** S ≈ ≤3h · M ≈ half-day · L ≈ full day (agent may split into 2 commits, never 2 PRs).

---

## 2. Binding decisions (2026-07-16 Q&A)

**Renderer & disposal**

- **Inline is the only renderer.** Fullscreen is removed *entirely* — flags, alt-screen,
  viewport path, mouse capture, docked sidebars (tried, felt broken; ADR
  `decision-inline-renderer.md` + amendment). Not "legacy opt-in" — deleted (MP3).
- **The SidebarChassis approach is dead.** No borderless docked panels, no cwd/version panel
  footer. The UI language is **Claude Code inline**: transcript in native scrollback, compact
  footer, panels live in the live region only.
- PR #131 merges as-is (history is history); removal lands as MPs on top.
- `PLAN-retired.md` is the record of what was built; unfinished rows A5–A7/B6 stay Track A
  backlog; J1's E2E-demo intent lives on as MP19.
- New **inline visual baseline** replaces the sidebar-era shots (MP0); every later MP diffs
  against it.

**The hard invariant (unchanged, now the only one)**

> The inline live region must stay **strictly below `rows`** or Ink calls `clearTerminal`
> (CSI 3 J) and wipes all `<Static>` scrollback. `app.tsx:3600`. Every panel height in this
> guide is derived from this.

**Prompt placement (THE RULE, added 2026-07-16; anchor ledger 2026-07-20)**

- The prompt section (composer + status footer) is **mounted at the terminal bottom** — from
  frame 1 and permanently. Supersedes the earlier "render from the top (CC-style)" choice.
  Mechanism: a one-time `rows−1` newline reserve at startup (`main.ts`) seats the first
  paint; the **anchor ledger** (`layout.ts nextLiveFrameHeight`, wired in `app.tsx`) keeps
  every later frame there by giving the live box an EXPLICIT height satisfying
  `H ≥ H_prev − K` (K = rows committed to `<Static>` this frame) and
  `H ≤ rows − SCROLLBACK_SAFETY_ROWS`. log-update rewrites frames top-anchored, so the
  floor keeps the frame bottom at/below the old bottom (terminal scroll re-pins it) across
  EVERY shrink path — perm/question teardown, busy teardown, stream commits, panel close —
  and the inequalities telescope across Ink's 32ms write throttle. The cap is structural:
  Ink's wipe threshold reads the root's Yoga height and `<Static>` is position-absolute
  (excluded), so our own frames can never reach `rows`. Estimate errors degrade to
  transient flex-end padding (over-count) or a top-clip under `overflow="hidden"`
  (under-count) — never a strand, never a wipe. Resets: a `<Static>` remount (/clear,
  rewind, resume) seeds content-sized; a resize seeds one full-height frame that re-anchors
  within `SCROLLBACK_SAFETY_ROWS` (exact again at the next commit) — including after Ink's
  one unavoidable old-tree-vs-new-rows resize wipe. The pre-ledger estimate-decay
  `minHeight` survives behind `MINIMA_TUI_ANCHOR_LEGACY=1` until the ledger has soaked.
- **Boot resets inherited scroll margins** (`CSI r` + `CSI ?69l` lead the clear write,
  `main.ts`; root-caused live 2026-07-20, evidence in `shots/anchor-ledger/stale-margins/`):
  a prior CLI that pinned its UI with DECSTBM and died uncleanly leaves the region in the
  window forever — margins survive `2J`/`3J`/`H` and resizes, imprison the newline reserve
  (DSR reported row 24 of 60 after 59 newlines), and seat the composer mid-screen with the
  ledger faithfully preserving the bad seat. The mount deliberately does NOT cap-seed as a
  defense (tried, PNG-refuted: it parks early turns at the screen top, 40+ rows from the
  composer) — the reserve stays the seat, made trustworthy by the margin reset. PTY
  regression: `tui_verify.sh` scenario `stale-margins`. Field diagnosis:
  `MINIMA_TUI_DEBUG_ANCHOR=<file>` (reserve line + per-render ledger line + stdout/stderr
  write-tap + `<file>.raw` byte dump + a DSR cursor probe) and
  `scripts/real_term_capture.sh` (AppleScript-driven REAL iTerm2/Terminal.app captures —
  pyte has no pending-wrap and cannot stand in for a real emulator at exact-width rows).
- **`<Static>` must never sit under a flex-end ancestor** — it is position-absolute in Ink,
  and a flex-end parent offsets it past its own render canvas: committed messages silently
  clip to nothing. It mounts on the flex-start root, the ledger box is its sibling. Inside
  the ledger box the content sits in a `flexShrink={0}` wrapper — Yoga's default shrink
  would compress children into the fixed height instead of top-clipping them.
- Every conditional live element must be booked in `contentRows` (pickers via colocated
  max-row constants, banner via `BANNER_TAGLINES`, stream tail via `markdownBodyHeight`) —
  an unbooked element top-clips. And every per-line markdown render branch armors empty
  text (`|| " "`): Ink collapses an empty `<Text>` to ZERO rows while the ruler counts ≥1
  per source line — that divergence alone floated the composer 6 rows on blank-line-heavy
  replies (the wide-terminal stream-commit float).
- Enforced (not guidance): `render-buffer.test.ts` + `anchor-ledger.test.ts` source pins,
  the simulated log-update property test (`anchor-ledger.test.ts`), and `tui-verify`'s
  `bottom-anchor` checks at **slack 1** (echo, modes, tasks-footer, panel-toc, both stream
  scenarios, overlay-anchor, panel-early, big-200x50; slack 2 on plan-council and the
  post-resize window of resize-reanchor). Before/after evidence:
  `docs/BigPlan/shots/anchor-ledger/`. D3b's height math (`rows − footerChrome`) builds on
  this rule.

**Panel system (D3)**

- **D3a** = compact footer task panel, CC-parity: renders whenever todos exist, read straight
  from `todowrite` state (the `state` param seam, `src/tools/todowrite.ts` — "Pass `state` to
  observe the list from outside (e.g. a TUI panel)"). GT is an *enrichment*, never the gate.
- D3a: fixed cap ~3 rows (progress + current step, + next only if it fits) + conditional
  alert row + trailing cost-so-far. Zero rows when empty. On by default, auto-shows on first
  todo; **Ctrl+B** toggle + `/tasks` command; explicit override persisted per-project in
  `ui-modes.json` (`mode_prefs.ts`). Alerts (🔴 live block, DRIFT>0) as **colored ASCII text**,
  no emoji in D3a; full tier icons are Ctrl+G's job.
- D3a **replaces** the GT planStrip banner + drift rows (`app.tsx:4174`) — one plan surface.
  The `gateFocus` answer modal (`app.tsx:942`) coexists (triggered interaction, not a surface);
  D3a's 🔴 alert routes to it.
- D3a sits at the **top** of the footer stack; busy + suggestions move to hug the input.
- **The user can REJECT the task list** (added 2026-07-17, CC's plan-reject parity):
  `/tasks cancel` clears the todowrite list, closes the active GT plan
  (`status='cancelled'` — never resurrected, unlike `done`), disarms the gate modal, and
  pushes a model-facing user turn ("do not re-create these tasks…") that rides the next
  prompt — the notice is load-bearing: clearing state alone just gets re-seeded by the
  model's next todowrite.
- **D3b** = the same panel expanded (Ctrl+T = ToC, Ctrl+G = GT overview) filling
  `rows − (input + status bar)`; suggestions/busy suppressed, D3a hidden while open.
  **Snapshot at open** (re-read on reopen); stale/refresh = v1.5; live-subscribe = v2.
  **Auto-closes when a stream starts** (Q17a) — the streaming path is never shared.
- D3b keys: j/k, ↑/↓, PgUp/PgDn, gg/G → one cursor primitive. **Inline never captures the
  mouse.** The wheel scrolls the terminal's scrollback — that's the feature.
- **Enter = read in panel** (Q27b): ToC Enter opens the section's messages *inside* the panel
  (jump-as-scroll is impossible inline). GT Enter opens the step card (U3 model). No Ctrl+J —
  jump-to-message is folded into D3b's reader.
- Chords keep U2/U3 semantics: Ctrl+T toggle, Ctrl+G swap, Esc → composer (draft survives via
  the `suspended` TextInput); an unanswered 🔴 gate wins the Ctrl+G chord.
- ToC anchors = **user prompts only**; sections carry failed-gate markers.

**Transcript (D2)**

- User block: **frozen as-is** (decision documented — the accent-bar restyle is rejected;
  D2 targets assistant/tool/code surfaces only).
- Code blocks: **wrapping first, no syntax highlighting in v1** (dependency + per-frame cost).
- Tool output: **truncate at commit** with a `… N more lines` indicator; expand-by-reprint is
  rejected (scrollback pollution); future expand = panel-reader.
- Min readable width = **60 cols** (`TOC_MIN_COLS`, `layout.ts:540`); below → one-shot text
  snapshot degrade. 45 is dead.

**Plan workflow**

- Council: **streamline, don't remove** — stream per-role progress, run researcher + critic
  concurrently (synth last), convene the full council only on plan-stakes turns.
- **Universal approve/revise/cancel gate** on plan-mode exit, GT on or off (lift the GT-only
  `exit_plan` registration, `src/tools/exit_plan.ts` + `plan_finalize.ts`). v1 = 3 options,
  no inline step editing.
- **Verify commands get per-command consent at first run** via the existing permission overlay,
  keyed to the *exact command string* (sticky-but-overwriteable `verify`, `todowrite.ts` —
  a changed string re-prompts). Commands also listed in D3b at plan approval. Not
  trust-the-gate; not once-at-approval.
- D3b GT panel is the **primary `/why` surface** (text `/why` stays for headless).
- Per-step cost + model port into D3b **as-is** (U3's v8 stamp work).

**Scope guard**

- Loop/ledger/routing changes are in scope only as **validation** (MP13, MP19) and the
  council/consent/approval work above. No other loop behavior changes ride this guide.

---

## 3. Budgets & test matrix

Four gated budgets, all PTY/`MINIMA_TUI_PERF`-assertable (wired in MP0/MP1, extended in MP7):

| budget | assertion |
|---|---|
| frame cost | `MINIMA_TUI_PERF` per-frame budget (backbone; numbers baselined in MP0) |
| prompt echo | echo visible ≤1 frame after Enter (regression guard for the shipped fix) |
| panel open/close | Ctrl+T/Ctrl+G/Ctrl+B transitions ≤1 frame |
| zero wipe | no `CSI 3 J` (`\x1b[3J`) in the raw PTY stream during stream + panel ops |

Cold-start is tracked (recorded in MP0) but **not** a gating budget. "Flicker" is only ever
asserted via its proxy (zero wipe + frame budget).

**Test matrix:** primary = **iTerm2 @ 120×36** *(user-confirmed 2026-07-16)*; bookends =
**60-col floor** (degrade boundary) and a **tmux narrow
split** (simulated as a 55-col PTY — established practice). Terminal.app is **out**. Byte-level checks run on the pyte
harness forever (automated); outcome/feel gets **one live iTerm2 pass per MP** (manual test).

---

## 4. Mini-project map

```
Stage 0        Stage 1 (align tests → delete)     Stage 2      Track P (panels)
[MP0]──────────[MP1]──[MP2]──[MP3]────────────────[MP4]────────[MP5]─[MP6]─[MP7]─[MP8]─[MP9]
 baseline       verify  sidebar fullscreen          spike        D3a   D3a+GT D3b   reader D3b-GT
                inline  delete  delete              gate                                 │
Track D (after MP3):   [MP10 audit]──[MP11 code-wrap]──[MP12 tool-truncate]             │
Track W:  [MP13 loop audit]──[MP14 council stream]──[MP15 council parallel]             │
          [MP16 draft visibility]──[MP17 exit gate]──[MP18 verify consent]──────────[MP19 E2E]
                (MP16 needs MP7+MP9 · MP17 needs MP16 · MP18 after MP9 recommended)
```

Recommended serial order: MP0→MP1→MP2→MP3→MP4, then interleave Track P with D/W as you like;
MP19 is always last. MP13 is independent — it can run any time after MP0 (early is better:
its findings may add MPs).

---

## 5. Stage 0 — verify current truth

### MP0 — Echo regression proof + inline baseline set *(S)*

**Goal:** confirm the shipped prompt-echo fix, freeze the inline visual baseline, and record
perf numbers — the reference every later MP diffs against.

**Why:** your rule #2 — never build on unverified rendering. The sidebar-era shots in
`docs/BigPlan/shots/` are no longer the reference.

**Verify first:** write the PTY specs before capturing — they *are* the artifact.

**Build:**
- Echo proof: mock-provider run (slow-reply mock, `scratchpad/mock_openai.ts` pattern), frames
  JSONL; assert the user block renders in the first frame after Enter, before any reply frame.
  This retires the D1 question (shipped in PR #133) with evidence, and becomes the ≤1-frame
  echo budget scenario.
- Baseline shots (inline, no flags) at 120×36 and 60×24 + one tmux-narrow: plain chat,
  code-heavy reply, tool-heavy turn, GT run (plan banner as it exists today), Ctrl+T/Ctrl+G
  one-shot text blocks. Commit to `docs/BigPlan/shots/inline-baseline/` with a README + the
  capture specs.
- Record `MINIMA_TUI_PERF` numbers + cold-start time into the README (frame-cost baseline).

**Agent proof:** the committed shots + a frames-JSONL echo-timing table in the README.
**Manual test:** run `minima-loc --wt minima-j1`, submit a prompt, see it echo instantly;
eyeball each baseline shot against your live terminal.
**Gate:** §1.7 + shots committed. No product code changes in this MP.
**Execution notes (landed):** live replies come from the committed mock
`packages/tui/scripts/mock_openai_sse.ts` (:8399; `SLOW`/`CODE` prompt markers — the faux
provider is tests-only and unreachable from the CLI); the GT-banner/overview shots seed via
the in-app `/gt-seed` (run-scoped, no DB surgery); evidence + warts live in
`shots/inline-baseline/README.md`.

---

## 6. Stage 1 — align the tests, then delete

> Order is deliberate: tests move to inline **first** (a test that depends on a renderer says
> so — and the decided renderer is inline), so the deletions in MP2/MP3 land against a suite
> that never asserts a corpse. Gate for both deletions: **the inline default path is
> byte-identical to MP0's baseline.** A deletion that changes inline behavior is a bug.

### MP1 — Re-base `tui-verify` on inline + wire the budgets *(M)*

**Goal:** rewrite `packages/tui/scripts/tui_verify.sh` (five specs, all `--fullscreen` today)
as inline scenarios asserting §3's budgets.

**Build:**
- Scenarios: (1) echo ≤1 frame (from MP0's spec); (2) streaming turn → zero `CSI 3 J` + frame
  budget; (3) 500-msg resume fixture → native scrollback intact after exit (no `?1049` in the
  byte stream, transcript persists in main buffer); (4) inline never emits mouse-capture
  sequences (`?1000h`/`?1002h`/`?1006h` absent); (5) 60-col degrade renders the text-snapshot
  path. Update `tui_assert.py` as needed.
- Delete the fullscreen scenarios and the header rationale; new header states the inline
  contract. Budgets read from MP0's baseline numbers.

**Agent proof:** `make tui-verify` green; committed run log.
**Manual test:** run `make tui-verify` yourself; skim the assertions.
**Gate:** §1.7. This MP touches only scripts/tests.
**Execution notes (landed):** the suite self-starts the committed mock on **:8451** (never
collides with a dev's :8399) and adds ported inline versions of the renderer-agnostic
fullscreen-era scenarios (clipboard/modes/shortcuts) so coverage survives MP3. Two facts the
scenarios pin: inline startup itself writes one `ESC[2J 3J H` (`main.ts`), so the zero-wipe
budget is *exactly one* `3J` ever; and inline Ctrl+T has **no width gate today** — the 55-col
scenario pins "text block renders below the floor", and inherits the §2 text-snapshot degrade
rule when D3b lands. Echo budget wired at ≤0.35s (observed 0.01s). Run log:
`docs/BigPlan/shots/mp1-tui-verify-run.log`.

### MP2 — Remove the sidebar system *(M)*

**Goal:** delete the fullscreen dock/overlay sidebar wholesale (Q2 = d).

**Build:**
- Delete `src/tui/sidebar-chassis.tsx`, `toc-panel.tsx`, `gt-panel.tsx`; remove
  `sidebarGeometry`/`sidebarOverlayGeometry`/`SIDEBAR_*` from `layout.ts:571+`.
  **Keep** `toc.ts` + `gt_overview.ts` (pure content builders — D3b reuses them),
  `clipPanelLines` (`layout.ts:634` — D3b's windowing), `TOC_MIN_COLS`, and
  `tocPanelGeometry`/`PanelGeometry` (rewind overlay still uses them until MP3).
- `app.tsx`: remove sidebarGeom/docked/overlaid branching (`contentCols` → `cols`), the
  two-column fullscreen root, the ≥100-cols auto-open effect, `sidebarPanels`.
  `requestTocSidebar` (`:1628`) / `requestGtSidebar` (`:1644`) now always take the one-shot
  text-block path (today's inline behavior) — the interim UX until MP7/MP9.
- Tests: delete sidebar pins (behavior two-column describe, layout sidebar/overlay tests,
  `sidebar-chassis.test.ts`); `string-width`/`padDisplay` go if now unused.

**Agent proof:** inline shots byte-identical to MP0 baseline; suite green.
**Manual test:** Ctrl+T / Ctrl+G print text blocks; nothing else changed.
**Gate:** §1.7 + baseline diff clean.
**Execution notes (landed):** the byte-identical gate runs via `docs/BigPlan/shots/ab/`
(`ab_capture.sh` → frames per scenario, `ab_compare.py` → final-grid diff); the only masked
rows are `/gt-seed`'s random UUIDs (`Seeded plan |seed-rec-`), proven volatile by a two-run
control at the same commit. That control also surfaced a hermeticity wart: tips rotation
state writes to the real `~/.minima-harness` regardless of `MINIMA_HARNESS_DIR`
(`tips.ts` — `setTipsStateDir` exists but is never wired), so capture scripts must isolate
`HOME`; a src fix is a follow-up, not part of the deletions.

### MP3 — Remove the fullscreen renderer *(L)*

**Goal:** inline is the only code path. Every `fullscreen` conditional dies.

**Build (compile-guided; two commits OK):**
- `src/cli/main.ts`: drop `--fullscreen`/`--no-fullscreen`/`--inline`, `MINIMA_TUI_FULLSCREEN`,
  `MINIMA_TUI_INLINE`, `MINIMA_TUI_VIEWPORT`; simplify `parseArgs` + help.
- `app.tsx`: remove the `fullscreen` prop and every branch on it — alt-screen lifecycle,
  the line-viewport path (`viewport.ts`, `lines.ts`, `offsetForMessage`), wheel capture +
  `/mouse` (`mouseEnabled`, `:1245-1334` — inline never captures), PgUp/PgDn viewport keys,
  fullscreen keys-legend variants, `suspendToShell`'s mouse/fullscreen args.
- Rewind: delete `rewind-panel.tsx` + `rewind_picker.ts`'s overlay path +
  `tocPanelGeometry`/`PanelGeometry` (now orphaned); `/rewind` = numbered list everywhere
  (decision: stays; revisit after D3b ships).
- Tests: delete the renderer-default describe in `cli.test.ts`, viewport/lines tests,
  rewind-overlay pins; sweep `render-buffer.test.ts` wording.
- Exit sweep: `rg -in "fullscreen|1049|viewport|altscreen|mouse" src tests scripts` returns
  only intentional survivors (documented in the PR body).

**Agent proof:** sweep output in PR body; inline shots still byte-identical to MP0; suite green.
**Manual test:** `minima-loc` daily-drive for a session; confirm nothing feels different.
**Gate:** §1.7 + baseline diff clean. **This closes the disposal work.**
**Execution notes (landed):** `rewind_picker.ts` (the numbered list) survives whole — the
overlay lived in `rewind-panel.tsx` + app.tsx call sites; `/mouse` is removed as a command
(not stubbed); `clipPanelLines` + `computeMsgHeight` are kept in `layout.ts` for D3b
(temporarily test-only); `input-filter.ts` keeps its defensive mouse-byte stripping — it
already ran on the inline path, so deleting it would have changed inline behavior. The
`panelCapture` guard/`suspended` seam stays as `false` for D3b to re-populate.

---

## 7. Stage 2 — the gate

### MP4 — Spike: near-full inline panel vs the scrollback wipe *(S/M)*

**Goal:** prove a `rows − (input + status)` panel can mount in the live region, scroll
internally, and unmount — without ever triggering `clearTerminal`. **No D3 code before this
is green.**

**Build:**
- Temporary `MINIMA_TUI_SPIKE_PANEL=1` mounts a `<TestPanel>` (500-line list, j/k +
  PgUp/PgDn via `clipPanelLines`) above the input; height = `rows − (input rows + status bar)`.
- **Bytes → pyte (automate forever):** spec drives open → 200 scroll steps → close; assert
  zero `\x1b[3J`, pre-open scrollback lines still present after close, panel never paints row
  `rows`. This becomes a permanent tui-verify scenario (kept after the spike code is removed).
- **Perf (free, do it):** record `MINIMA_TUI_PERF` during the run — a near-full live region is
  the repaint-cost class we left fullscreen to escape. Treat the number as a lower bound;
  compare against MP0's baseline. Mitigation if hot: `React.memo` + update-on-change rows.
- **Outcome + feel → one live iTerm2 pass (confirm once):** open/scroll/close by hand.

**Outcome taxonomy (Q19):**
- **Pass** → green-light MP5–MP9.
- **Partial** (wipe only at exact heights) → clamp to the safe height constant, re-measure,
  record the constant here.
- **Expected-fail** (any near-full panel wipes) → D3b pivots to the print-once snapshot
  branch; D3a (≤3 rows) is unaffected. Edit §2 + MP7 accordingly.
- **Surprising-fail** (garbling, Static overpaint, perf cliff) → stop the line; replan
  together before any D3 work.

**Deliverable:** `docs/BigPlan/spike-inline-panel.md` (spec, numbers, verdict) + the permanent
scenario. Spike component itself is deleted in MP7's first commit.
**Execution notes (landed): VERDICT = PASS** — see `spike-inline-panel.md`. Open 0.01s,
zero extra `3J`, last grid row blank across every settled panel frame, perf median 2.55ms
(vs 1.4ms baseline — no mitigation needed). The geometry is an *identity*, not an estimate:
`panelOuterHeight()` + `PANEL_STATUS_ROWS` in layout.ts, explicit heights + truncate rows +
suppressed footer extras ⇒ frame ≡ rows−2. One real finding: **panel close over a long
transcript stranded the composer at the screen top** (log-update rewrites the shrunken
frame at the old top; bottomMountMinRows was inert). Fixed at the time by
`closePanelReseat` — closing moved the static-estimate basis so THE RULE's decay restarted
from a fresh screen; since 2026-07-20 the anchor ledger (§2) subsumes this for free (the
panel frame IS the rows−2 identity, so the close floor keeps a full-height frame that
decays per commit — the basis reset survives only behind `MINIMA_TUI_ANCHOR_LEGACY=1`);
pinned by the scenario's post-close bottom-anchor. Also learned: Ink
delivers coalesced stdin as ONE input string — `panelReduce` iterates characters, so key
storms and `gg` both work regardless of chunking. `tui_assert.py` gained `--before` (frame
windows that must exclude the post-exit state).

---

## 8. Track P — the panel system

### MP5 — D3a task panel (CC parity) + footer restack *(M)*

**Goal:** the compact always-available task panel + the footer-order fix.

**Build:**
- New `src/tui/task-panel.tsx` reading todos via `todowrite`'s `state` param (thread the
  observable list from agent construction to the TUI — discovery step: find where
  `todowriteTool(...)` is instantiated and expose `state` to `app.tsx`).
- Fixed cap `TASK_PANEL_ROWS = 3`: `tasks 2/5 · ▸ current task title` (+ next task row only if
  it fits). Zero rows when no todos. Truncate by display width.
- Footer restack: D3a at top of the footer stack; busy + suggestions move to hug the input
  (fixing the separation around `app.tsx:1430`/footer block). Every element keeps a fixed
  row budget — footerChrome stays predictable (the wipe invariant).
- Ctrl+B toggle + `/tasks` command (both directions); auto-show on first todo; explicit
  override persisted per-project via `mode_prefs.ts` (`ui-modes.json`); discoverability =
  startup tip (`tips.ts`) + status-bar key hint — never a permanent empty row.

**Agent proof:** scripted mock run where the agent todowrites → shots: panel appears, updates
on status change, Ctrl+B hides, restart honors the persisted hide.
**Manual test:** real GT-off run with todos; toggle; restart; check the footer order feels
stable (nothing jumps when busy/suggestions appear).
**Gate:** §1.7 + budgets (footer restack must not move frame cost).
**Execution notes (landed):** data thread = the `todoState` array seam (`builtin.ts` →
`toolsFor` → `todos` AppProp; `spawn.ts` untouched, so sub-agent todos can't leak).
`tool_execution_end` carries **no toolName** — the re-read is an unconditional gen bump,
same pattern as the GT strip refresh. Persistence = a SUFFIXED key
(`<projectKey>::task-panel`) in the existing flat `ui-modes.json` — invisible to old
readers; only the explicit hide persists. The mock gained a `TODO` marker that emits a
real `tool_calls` stream (two-phase: a transcript containing a tool result gets plain
text, or the loop would spin); scenario timing must approve the todowrite permission
prompt AFTER it appears (~2.1s post-submit — the "a" step sits at 8.0s). A/B vs MP4:
the only no-todos diff is the intended `ctrl+b Tasks` keys-legend hint (one row, every
scenario); `tasks-footer` + `tasks-footer-restart` joined tui-verify permanently.

### MP6 — D3a GT enrichment — replace the plan banner *(M)*

**Goal:** one plan surface. The GT planStrip banner + drift rows fold into D3a.

**Build:**
- GT on: D3a's rows enrich — current step from the ledger projection (`planStripInfo`,
  `app.tsx:933/:1560`), progress x/N, trailing compact `cost-so-far` (Minima is cost-focused;
  status bar only has per-turn cost — discovery: pull run total from the meter/ledger).
- Conditional alert row (only when active): 🔴 live block / DRIFT>0 as **colored ASCII text**
  (`!! gate blocked — ^G` / `drift: 2 files`), no emoji, no per-row width risk. The 🔴 alert
  routes to the existing `gateFocus` modal (`app.tsx:942`) — which stays as-is.
- Delete the old planStrip banner rows (`app.tsx:4174` region) + their fit bookkeeping
  (`gtFit.strip`). Excluded from D3a by decision: model name (status bar has it), per-step
  tier icons (Ctrl+G's job).

**Agent proof:** seeded-ledger shots: enriched rows, alert row on a fixture 🔴, banner gone.
**Manual test:** `MINIMA_TUI_GROUND_TRUTH=1` run: watch a step go in-progress → done; trigger
a gate block; confirm ^G answers it.
**Gate:** §1.7 + GT-off path unchanged vs MP5 shots.
**Execution notes (landed):** the A/B gate came out ideal — all four GT-off scenarios
byte-IDENTICAL vs MP5, and the `gt` scenario's diff is exactly the three-row swap (D3a
header replaces the `▸ plan …` banner row; `drift: 1 file off-plan` replaces the inline
⚠ suffix; the 🟡 note row folds away — full tiers are Ctrl+G's per Q25). `PlanStripInfo`
gained `planId` + `totalCostUsd` (null hides the cost segment — never `$0.0000`);
`planStripLabel`/`planStripDrift` were deleted (app-orphaned once the banner died — the
one-rendered-row newline collapse now lives in `task_footer.oneLine`, tested there).
`grantTaskRows` grants alert → header → next, display order preserved. The 🟡 note text
(`gtBehavior.footerNote`) intentionally has no D3a row; `gt-footer.test.ts` was rewritten
in the same commit onto the successor invariants (banner strings ABSENT, taskShown
lockstep, taskBudget constants, refresh cadence, fail-open).

### MP7 — D3b expanded panel + ToC list *(L · needs MP4 pass)*

**Goal:** Ctrl+T expands to the full live-region ToC browser.

**Build:**
- First commit: delete MP4's spike component; keep its scenario.
- New `src/tui/expand-panel.tsx` (the panel chassis): height `rows − (input + status)`;
  suggestions/busy suppressed and D3a hidden while open (D3b *is* D3a expanded); plain CC-style
  header row (`tasks · contents · plan` breadcrumb) — **no SidebarChassis look**.
- Content v1 = ToC list via `toc.ts` sections (snapshot at open; re-read on reopen); failed-gate
  markers on sections (join gates→prompt ordinal, the U2/U3 join rule); cursor via one
  primitive handling j/k, ↑/↓, PgUp/PgDn, gg/G over `clipPanelLines`.
- Semantics: Ctrl+T toggles; Esc → composer (TextInput `suspended`, draft survives);
  **auto-close on stream start** (subscribe to `message_start`); no mouse.
- Add the ≤1-frame open/close budget scenario to tui-verify.

**Agent proof:** shots: open over a long transcript, scroll to bottom/top, gg/G, auto-close
when a mock stream starts, zero-wipe scenario green.
**Manual test:** long real session → Ctrl+T, browse, Esc, confirm draft survived and
scrollback is intact (scroll the terminal up).
**Gate:** §1.7 + all four budgets.
**Execution notes (landed):** no separate expand-panel chassis file was needed — MP4's
`expand_panel.tsx` + `panel_state.ts` ARE the chassis; the spike view was replaced by the
`toc` view (generic `lines` + `stops` cursor: stops = section-title rows; PgUp/PgDn jump
lines then snap directionally; reader views pass `stops: null`). Snapshot-at-open holds
the `messages` REFERENCE (immutable-updated → free). "Auto-close on stream start" is the
`busy`-keyed effect from MP4 — the guide's `message_start` hint is stale (that event
carries `message: null`, loop.ts). Failed-gate markers ride the EXISTING milestone-error
join (a refused todowrite completion is an erroring tool → the section's `⚠`), no new db
query. Ctrl+G inside the panel closes + falls back to the one-shot overview text until
MP9. `resume-scrollback` was updated in the same commit (idle Ctrl+T now opens the panel).
Open/close latency both 0.01s against the 0.35s budget.

### MP8 — D3b reader mode *(M)*

**Goal:** Enter on a ToC section reads it **inside the panel** (the Q27b decision — inline
cannot scroll the terminal's scrollback, so reading happens in-panel).

**Build:**
- Enter → panel body swaps to the section's messages as rendered text lines (windowed by the
  same cursor primitive); Esc/`h`/←  back to the list (Esc from list = close, unchanged).
- v1 rendering: plain committed-text lines (reuse the transcript's line formatting, not a
  re-mount of MessageRow); code blocks wrapped per the transcript rules.
- Breadcrumb shows `contents ▸ <section title>`.

**Agent proof:** shots: list → Enter → reader scrolled → back → close; budgets green.
**Manual test:** find yesterday's decision in a long session using only Ctrl+T.
**Gate:** §1.7.
**Execution notes (landed):** the keystone extraction is `wrapLineToWidth` in layout.ts —
the WRAP PRODUCER; `wrapRows` (every height estimate) is now DEFINED as its `.length`, so
the reader and the reservations cannot diverge (property-pinned across widths incl. CJK
hard-breaks, where the char-accurate producer is a hair more conservative than the old
ceil() — the safe direction). `reader.ts sectionReaderLines` mirrors the transcript
headers (`▸ you` / `◆ assistant` / `⚙ tool:` / `🧠`), clamps tool bodies with the honest
`… +N more lines` marker, and mirrors `markdownBodyHeight`'s three cases. Reader views are
`stops: null` (plain line scroll) on the same cursor primitive; `h`/`←` back is a reducer
rule (inert on the top-level list). The panel-toc scenario grew the reader leg
(Enter → `contents ▸` breadcrumb → h back → Esc close, all inside the same byte gates).

### MP9 — D3b GT overview + step cards *(M)*

**Goal:** Ctrl+G = the GT plan overview in the same panel; primary `/why` surface.

**Build:**
- Ctrl+G opens (or swaps to) GT view: `gt_overview.ts` snapshot — plan title, step X/N,
  per-step ⬜🟦✅ + 🟢🟡🔴 tier icons (there's room here — this is where the full tiered view
  lives), verify cmd per step, DRIFT, per-step cost + model **as-is** (v8 stamp work).
- Enter → step card (`stepCardLines`) in-panel; Esc back. Unanswered 🔴 gate wins the Ctrl+G
  chord (existing rule, `app.tsx:1771`); answering hands the chord back.
- `/why` in a TTY opens this panel on the step (text output stays for headless/`-p`).
- GT off: Ctrl+G shows the one-line "Ground-Truth is OFF" notice (existing behavior).

**Agent proof:** seeded-ledger shots: overview, step card, gate-wins-chord, /why-opens-panel.
**Manual test:** full GT run; use only Ctrl+G to follow execution; `/why` after a gate.
**Gate:** §1.7. **Track P complete — Ctrl+T/Ctrl+G one-shot text blocks retire here** (the
<60-col degrade keeps the text-snapshot path; the busy path also keeps them — Q17a's
sibling decision, 2026-07-17).
**Execution notes (landed):** the `gt` view rides the same lines+stops primitive; step
cards reuse `readerView` (breadcrumb `plan ▸ step N`, 1-based). Gate-wins is enforced at
BOTH chord sites — the global guard falls through to the gate-answer arm, and the
in-panel Ctrl+G closes + arms the SAME `gateFocus`. `/why` opens the panel (with `/why
<n>` pushing the card); the text path survives for GT-off/narrow/out-of-range — headless
never had slash commands. **Two real defects the panel-gt scenario caught:** (1)
`stepCardLines` entries can carry embedded newlines — every panel view now FLATTENS its
lines (a multi-row line breaks the height identity: log-update desyncs, a ghost row leaks
into scrollback permanently, one more row would wipe); (2) terminals and Ink disagree by
±1 cell on some emoji widths (the U+1F7Ex tier circles/squares — the Q12 emoji-width
risk, live) — on a full-width row that pushes the right border past the last column and
the terminal WRAPS it. Fix: `ExpandPanel` carries `marginRight={2}` width armor (2 cells
of slack absorb the mismatch) and panel content builders take `cols − 6`. Both defects
were invisible in bun tests and in Ink's own output — only the PTY byte gates saw them.

---

## 9. Track D — transcript rendering (after MP3)

### MP10 — Transcript rendering audit *(S)*

**Goal:** replace "IDK" with a ranked defect list (the Q35 answer we don't have yet).

**Build:** fixture sessions (markdown-heavy, code-heavy at several indent widths, tool-heavy
with long outputs, mixed) shot at 120×36 and 60×24. Agent annotates every rendering defect
(wrap, spacing, headers, markdown fidelity, streaming artifacts); you review the shots and
rank. Output: a ranked list **appended to this section**, top items become/refine MP11+MP12
acceptance criteria (or spawn MP-extras). Constraint honored: the **user block is frozen** —
audit covers assistant/tool/code surfaces only.

**Gate:** the committed audit doc + shots. No product code.

**Execution notes (landed 2026-07-17):** fixtures = `gen-fixture-session.ts --profile
md|code|tool|mixed` (fully scripted deterministic sessions; default path untouched); shots +
full-scrollback `.txt` dumps (byte-diff targets for MP11/MP12 after-shots) in
`shots/mp10-render-audit/` — 10 resume shots across the §3 matrix + one live-stream capture
with frames. PNG rasterizer note: CJK/emoji render as tofu boxes in PNGs (Menlo fallback in
`render_png`), NOT a TUI defect — the pyte grid and `.txt` dumps hold the correct glyphs.

**Ranked defect list (agent-ranked per user's 2026-07-17 delegation; re-ranks → follow-up MPs):**

| # | defect | evidence | severity | absorbed by |
|---|---|---|---|---|
| R1 | **Composer strands mid-screen after a TALL streamed reply commits** — during the stream the prompt box is bottom-anchored (row 28/36); at commit the live region shrinks and repaints at the old frame top: prompt jumps to row 10, 19 blank rows below, never re-anchors (no later repaint). Same shrink-repaint class MP4 fixed for panel close via `closePanelReseat()`; the stream-commit path has no reseat, and the `bottom-anchor` gate only rides short-reply scenarios (echo/modes) where `minHeight` still fills the screen. | `stream-code.png`, `stream-code.frames.jsonl` (prompt row 28→10 at t=3.32) | **P0 — every reply taller than the tail budget on a short transcript** | **MP20 (new, spawned by this audit)** |
| R2 | **Fenced code blocks garble** — ``` delimiters eaten by the inline-backtick toggle (language tag left behind, styled); `#` code lines render as bold-cyan headings with a phantom marginTop row (python comments, yaml comments); `- ` code lines render as bullets with indent structure destroyed; `**kwargs` loses its asterisks and bolds `kwargs` — copy-paste from scrollback is corrupted. | `code-tall.png`, `code-120/80/60.png` | P1 — every code-bearing reply | MP11 |
| R3 | **Tool-truncation marker format** — honesty already exists (`… +216 more lines`, gray) but live path prefixes 2 spaces, reader none, and the `+` diverges from CC's `… N more lines`. | `tool-120.png` | P3 — cosmetic | MP12 |
| R4 | **List nesting flattened + false bullets** — all list depths render at one marginLeft with the same bullet glyph; `-tight-dash` (no space) renders as a bullet, eating the dash. | `md-120.png` | P2 — false bullets corrupt content; flat nesting is only lossy | false-bullet → MP11 (classifier requires `"- "`/`"* "`); depth rendering → v2 |
| R5 | **Markdown fidelity passthroughs** — `*italic*`, `~~strike~~`, tables, blockquotes render as raw text (honest, readable, unstyled). | `md-120.png` | P4 | wontfix-v1 (CC-parity styling = v2) |
| R6 | **Footer keys legend loses separators at 60 cols** (`ctrlModelctrlRoute…`) — not a transcript surface. | `code-60.png` bottom row | P4 — cosmetic, floor width only | MP-extra candidate, Track A backlog |

**MP11 acceptance refined by R2** (before-shots = `code-*.png`/`.txt`): after-shots must show
dim ``` delimiter rows with the language tag visible; `# comment` inside a fence NOT a
heading (no phantom row); yaml `- name:` lines verbatim with indent intact; `**kwargs`
literal; the overlong call + URL hard-wrapped without garble at 60/80/120; the unclosed
bash fence rendered verbatim to EOF.

### MP11 — Code-block wrapping at 60–120 cols *(M)*

**Goal:** code blocks never garble at any width ≥60. No syntax highlighting (v1 decision).

**Build:** wrap/indent strategy for fenced blocks in `messages.tsx` rendering (continuation
markers or hard-wrap at panel width — audit MP10 decides which); identical treatment in D3b's
reader. Acceptance = MP10's code-heavy fixtures render clean at 60, 80, 120 cols.
**Agent proof:** before/after shots of the MP10 code fixtures at all three widths.
**Manual test:** paste a gnarly nested snippet, check it at your daily size + a 60-col split.
**Gate:** §1.7 + budgets (wrapping is per-frame work in the live region — frame cost holds).

**Execution notes (landed 2026-07-17):** wrap style = **hard-wrap CC-style** (user decision
2026-07-17, supersedes "audit decides": wrap at width, no continuation glyphs). One shared
pure classifier `classifyMarkdownLines(text): MdLine[]` in `layout.ts` now feeds all three
sites — `MarkdownRenderer`, `markdownBodyHeight`, `sectionReaderLines` — so the mirror IS
shared code. Fence rule v1: trim-starts-with-``` opens/closes; EOF-in-fence = code
(streaming free by construction); tilde/indented fences out of scope. Delimiters render
verbatim dim (exact height lockstep + language tag + scrollback stays valid markdown); code
rows verbatim default-fg, empty code rows forced to " " (Ink collapses empty <Text>). List
rule unified to `"- "`/`"* "` WITH space (the reader's rule; `-x`/`---`/`--flag` stop
bulletizing). Two pre-existing bugs fixed en route: (1) `wrapLineToWidth` dropped LEADING
SPACES from width math while Ink wraps trim:false — a live under-estimate on indented code
(8sp+76ch@80 = 2 real rows, counted 1); indent is now peeled, seeded, and hard-broken when
wider than a row; (2) `tailToFit` slices that started mid-fence lost their opener and
re-classified code as prose — it now classifies the FULL text, re-anchors slices on the real
opener via `openerIdx`, and measures the exact final string (estimate == render by
construction). A/B gate: all five ab_capture scenarios byte-identical vs pre-MP11 (fence-free
content untouched). New tui-verify bookends `stream-code-80`/`stream-code-60` + a
```bash-verbatim assert on `stream-wipe-perf`. Shots: `shots/mp11-code-wrap/` (after) vs
`shots/mp10-render-audit/code-*` (before), .txt dumps byte-diffable.

### MP12 — Tool-output truncation indicator *(S)*

**Goal:** truncation-at-commit honesty: `… 214 more lines` instead of a silent cut.

**Build:** wherever tool results are trimmed before `<Static>` commit, append the counted
indicator row (dim). No expand mechanism (rejected: reprint pollutes scrollback; future
expand = D3b reader). Indicator styling matches CC's.
**Agent proof:** tool-heavy fixture before/after shots.
**Gate:** §1.7.

**Execution notes (landed 2026-07-17):** the audit (R3) found the premise stale — the
indicator already existed on BOTH surfaces (`messages.tsx` gray `  … +N more lines`,
`reader.ts` `… +N more lines`), diverging in format and indent. MP12 = one shared producer:
`toolHiddenMarker(hidden)` in `layout.ts` returns the CC-style `… N more lines` (dim; call
sites add their own indent), consumed by both `MessageRow` and `sectionReaderLines` — pinned
by `tool_marker.test.ts` (helper format, both-sites-consume, no inline template rebuilds,
`clampToolText` stays the only trim site, `computeMsgHeight`'s +1 indicator reservation).
`_io.ts`'s read-tool pagination hint is a different (model-facing) surface — untouched.
Shots: `shots/mp12-tool-truncate/` (`… 216 more lines` on the 244-line fixture) vs MP10's
`tool-*.txt` before-dumps.

### MP20 — Stream-commit bottom-mount reseat *(S · spawned by MP10's R1)*

**Goal:** the composer never strands mid-screen after a tall streamed reply commits.

**Problem (audit R1, 2026-07-17):** while streaming, the live region (stream tail + composer +
status) is bottom-anchored; when the reply commits to `<Static>` the live region shrinks to
~6 rows and log-update repaints it at the old frame TOP — prompt jumps from row 28 to row 10
at 120×36 with 19 blank rows below, and nothing ever re-anchors it. Exact same
shrink-repaint stranding MP4 found on panel close; `closePanelReseat()` fixed that path by
reseating `staticBasisIdx` so `bottomMountMinRows` refills the screen. The stream-commit
path needs the equivalent reseat at the commit site (fires only when the committed live
region was tall — short replies already hold via `minHeight`).

**Build:** reseat on tall stream-commit in `app.tsx` (mirror `closePanelReseat`); extend the
`bottom-anchor` assertion to the `stream-wipe-perf` scenario (tall `CODE` reply — the class
the current echo/modes wiring can't see). Evidence: re-run the MP10 `stream-code` capture —
final frames must show the prompt within 1 row of the grid bottom.
**Gate:** §1.7 + zero-wipe + the new bottom-anchor wiring green.

**Execution notes (landed 2026-07-17):** frame archaeology overturned the reseat sketch — the
root cause is COMMIT ORDER, not a missing reseat. `message_end` pushed the reply to
`messages` and only then cleared `streaming`; those setStates flush as separate Ink renders,
so render A printed the static reply while the live frame was still stream-tall, and render
B's log-update erase walked that tall height back UP from the screen bottom, repainting the
shrunken composer at the old frame top (prompt 28 → 10, 19 dead rows). A
`closePanelReseat`-style basis reset (built first) DID anchor the composer but blanked the
reply off the settled screen — the fence-verbatim gate caught it, and any live-region filler
content would be erased (not scrolled) on the next commit, corrupting scrollback. The landed
fix is the two-line inversion: tear the live stream down FIRST, then commit — the shrink is
erased in place and the static print scrolls the reply in above the short frame (CC's
post-reply look; reply tail visible, composer on the bottom rows, zero-wipe intact).
Residual, documented at the time: at turn end the busy row's teardown (2 rows) shrank the
saturated frame once more — the "generic to any saturated late shrink" class this deferred.
**Resolved 2026-07-20 by the anchor ledger** (§2): the ledger's floor absorbs every
saturated late shrink as in-frame padding — busy teardown, perm/question teardown, and the
wide-terminal stream commit where the reply wraps to FEWER rows than the stream-frame
shrink (a case the commit-order inversion alone could not fix; before-evidence
`shots/anchor-ledger/`: low row 42/50 sustained at 200×50). The MP20 ordering stays as UX
(reply tail adjacent to the composer — the fence-verbatim gates), demoted from correctness.
The stream gates now assert `bottom-anchor --bottom-slack 1` (were 3). Gates:
`stream-wipe-perf` + `stream-code-80/60` + `big-200x50`; evidence
`shots/mp20-stream-reseat/` (the MP20 state) and `shots/anchor-ledger/` (before/after the
ledger) vs `shots/mp10-render-audit/stream-code.*` (the original strand).

---

## 10. Track W — plan workflow

### MP13 — Plan-loop E2E audit: loop / ledger / routing *(M · early, independent)*

**Goal:** validate the whole plan → execute → verify → learn pipeline *as built* — your Q51
ask — before polishing its UX.

**Build:** scripted GT run against the faux provider driving the full loop: `/plan` council →
draft → finalize → todowrite w/ verify → baseline red → execute → red→green → gate 🟢 →
`attachGroundedOutcome` → feedback (mock captures the realized-usage payload). Assert every
ledger row (plans, plan_steps, gates, file_changes, `routing_decisions.step_id`, gt_outcome
stamps) in bun tests, not prose. Then the *judgment* deliverable:
`docs/BigPlan/plan-loop-audit.md` — a narrative walkthrough with the actual rows, flagging
anything that doesn't make sense end-to-end (dead columns, double-writes, feedback-truth
violations, judge/gate precedence surprises). **Findings become new MPs appended to this
track.**

**Gate:** audit doc + assertion tests committed. Read-only on product code.

**Execution notes (landed 2026-07-17):** `tests/plan-loop-audit.test.ts` (3 tests, 109
asserts) drives finalize→seed→baseline-red→blocked-completion→escalation→red→green→
milestone→feedback against the faux provider and pins every ledger row; the judgment doc is
`docs/BigPlan/plan-loop-audit.md` (findings AUD-1..11 with the actual rows). Headlines —
two real bugs: **AUD-1** the closing rung's `routing_decisions.step_id` is NULL (plan closes
in the after-hook before `persistDecision` reads the active step → `stepCosts` undercounts
every plan's final rung) and **AUD-2** the milestone rollup lands `unchecked` when ANY step
is verify-less, even with genuine red→green evidence on the checked steps. Also pinned:
zero-consent headless verify execution (AUD-7 → MP18), `|| undefined` dropping zero token
counts from feedback (AUD-3), `parent_rec_id` flat-star (AUD-4), `gates.confidence`
NULL-on-write for step_check rows (AUD-5), write-only `synced`/`schema_v` (AUD-10).
Disposition per the doc: AUD-1+2 = one small fix MP; AUD-3/4/5/6/10 = one ledger-hygiene MP;
AUD-8 (sub-agent consent scope) needs a product decision — all appended to this track's
backlog, not built in MP13.

### MP14 — Council progress streaming *(M)*

**Goal:** kill the *perceived* council latency — the single most-felt pain: every plan turn
blocks on researcher→keeper→critic→synth with one spinner and no incremental signal.

**Build:** `plan_turn.ts` (`conveneCouncil`, `:66`) emits per-role progress events; the TUI
busy area renders `council: researcher ✓ · keeper ✓ · critic … · synth ·` updating as roles
complete (roles' text stays internal — this is progress, not content). Works with D3a present
(fixed footer budget).
**Agent proof:** frames JSONL showing the line advancing role-by-role during a mock council.
**Manual test:** `/plan` a real feature; the wait should *feel* alive.
**Gate:** §1.7.

**Execution notes (landed 2026-07-17):** `councilProgressLine(phase)` (pure, `busy.tsx`)
renders `council: researcher ✓ · keeper ✓ · critic … · synth ·` INSIDE the existing single
busy row via a new `BusyIndicator.statusLine` prop that replaces the rotating verb + tip —
footer row budget unchanged (2). `scope` folds into the researcher tick (sub-second prep,
not a fifth role). Wiring: `runCouncilRound`'s existing `onEvent` → `councilPhase` state →
the prop; cleared at `promptPlanner` start and belt-cleared in `onSubmit`'s finally.
**Decision: the per-phase `· phase: note` transcript pushes are DROPPED** — fixed strings
with no post-hoc information; the round-summary cost/faults note stays as the durable
record. Mock: `mock_openai_sse.ts` now answers council meta calls with canned per-role
replies keyed on the SYSTEM prompt's role phrases (`MOCK_COUNCIL_STAGE_MS` dwell, default
400ms); PTY scenarios must set `MINIMA_JUDGE_MODEL=mock-model` or every meta call fails
fast on the keyless default judge model and the phases blink by (that failure mode is
itself asserted via a minimum round duration). Gate: `tui_verify.sh` scenario
`plan-council` (first-seen phase ordering strict, transcript pushes absent, round-summary
present, zero-wipe, no-mouse sweep). Shots: `shots/mp14-council-progress/` (busy-research,
busy-synth PNGs + `council-line.frames.jsonl`). Known observation for MP19: the researcher
SUB-AGENT falls back instantly in PTY runs (its child model defaults to a keyless catalog
model) — research contributes no wall-clock; the full-loop demo will need the child model
pointed at the mock too.

### MP15 — Council parallelization + conditional convening *(M)*

**Goal:** kill the *actual* latency.

**Build:** run researcher + critic concurrently (`Promise.all`), synth after; convene the
full council **only on plan-stakes turns** (first plan turn, `/plan start`, explicit replan;
follow-up Q&A turns go straight to the planner) — discovery step: define + record the
plan-stakes heuristic here. Measure wall-clock delta on a scripted 3-turn planning session
(mock latencies) — number lands in the PR body.
**Agent proof:** latency table + unchanged council output quality on the fixture.
**Manual test:** a real planning session; second turn should not re-convene.
**Gate:** §1.7.

**Execution notes (landed 2026-07-17):** the recorded **plan-stakes heuristic**
(`shouldConveneFullCouncil`, plan_council.ts): substance (`shouldConveneCouncil` — not an
ack/option-pick/≤6 words) AND stakes (`isPlanStakesTurn` — `session.rounds === 0`, covering
both the `/plan start` goal and the opening ask, OR explicit replan intent per `REPLAN_RE`:
replan/rethink/start over/from scratch/new plan/scrap this plan/different approach). All
other turns: planner reply + **keeper mini-update** (user decision) — ONE cheap meta call
(`runKeeperMiniUpdate`, REPLACE-draft semantics via `applyKeeperUpdate`, rounds NOT bumped,
budgeted at ≤$0.05 with a "plan keeper update" ledger/meter row, silent fail-open: stale
beats wrong). **Parallel shape**: on rounds ≥2 the critic attacks the STANDING draft against
the session's accumulated findings CONCURRENTLY with the researchers (both branches
never-reject, one shared AbortController; keeper post-check stays after the research join
because the draft consumes its flags); the standing faults ride into `draftPlan` as a
`<faults>` block, so no separate revise round-trip. Round 1 (no standing draft) keeps ONE
bounded fresh-draft attack+revise — every session gets at least one adversarial look; the
old multi-pass self-improve loop is deleted (`maxCriticPasses`: 0 = critic off, ≥1 = the
single pass). **Measured** (scripts/plan_latency_bench.ts, meta=400ms research=1500ms,
3-turn scripted session, base ec34f74 vs branch): base 3.91s/3.91s/3.91s = 11.74s (3
rounds); MP15 3.92s/0.81s/0.81s = 5.52s — **−53% total, −79% per follow-up turn**.
Council-output quality: the round fixtures assert unchanged CouncilRoundResult contents
(migrated to the single-pass call order). Gate: `plan-council` scenario extended to a
follow-up turn — no council busy line and exactly ONE round summary after it, anchored to
the ACTUAL submission frame with a retried send (keys typed while busy are eaten; under
load a wall-clock window false-positives on turn 1's own busy line). **Hermeticity hole
found and closed by this gate**: `spawn.ts` unpins children, so the PTY researcher ran the
catalog default model — and keychain hydration supplies a REAL key on a dev machine (a real
network call inside the gate, nondeterministic seconds of latency). Council scenarios now
pin every provider key EMPTY in the spec env (empty-but-defined blocks hydration; the child
fails fast; the digest falls back). Real research-through-the-mock is MP19's job — it must
point the CHILD at the mock, not just the meta model.

### MP16 — Plan-draft visibility *(M · needs MP7+MP9)*

**Goal:** the plan is visible **while it's being drafted** — not only after `/plan finalize`
writes GROUND_TRUTH.md (pain #2: "you can't tell whether the plan is converging").

**Build:** the evolving draft (planner's current step list + rationale, accumulated in the
plan session store — discovery: where the draft lives pre-finalize) becomes a D3b GT-view
mode: during plan mode, Ctrl+G shows `plan (draft)` — steps so far, open questions, council
verdicts; snapshot-at-open semantics. After finalize it's the normal overview.
**Agent proof:** shots mid-council: draft view after turn 1, richer after turn 2, final after
finalize.
**Manual test:** plan something real; check convergence is visible turn-over-turn.
**Gate:** §1.7.

**Execution notes (landed 2026-07-17):** discovery answer — the pre-finalize draft lives in
the in-memory `PlanSessionStore` (never the DB; finalize seeds the ledger). The view is a
new `PanelView` variant `{kind:"draft"}` + pure builders in `src/tui/plan_draft_view.ts`:
`draftRows(store, innerWidth)` flattens `store.toMarkdown()` through the SHARED
`classifyMarkdownLines` + `wrapLineToWidth` pair (MP11 lockstep — every row exactly one
terminal row, the panel frame-height identity), heading first-rows = cursor stops, Enter
inert; `draftPanelState` titles the view `plan (draft) · round N` — the round count IS the
convergence signal. Wiring: in plan mode with a live session, Ctrl+G (global + in-panel)
opens the draft; after finalize the session is nulled and the SAME chord falls through to
`buildGtOverview` — the before/after switch is structural, no flag. Busy/narrow fallback:
`requestGtSidebar` pushes a terse `store.summary()` instead of the misleading "No
Ground-Truth plan recorded". Hermetic evidence path: `/plan-seed` (precedent `/gt-seed`)
applies canned `SEED_ROUND_1/2` council rounds — zero model calls. Gate: `panel-draft`
scenario (round 1 → nav (cursor moves) → round 2 → `/plan finalize --force` flips the chord
to the GT overview; zero-wipe; no-mouse sweep; cwd sandboxed so finalize's GROUND_TRUTH.md
lands in scratch). Shots: `shots/mp16-plan-draft/` (draft-round1, draft-round2,
final-overview). v1 wart (accepted): the panel is a plain-text surface — `**bold**`/`_em_`
in the doc render raw, like the reader.

### MP17 — Universal plan-exit gate: approve / revise / cancel *(M · needs MP16)*

**Goal:** CC-ExitPlanMode-style explicit exit, GT on or off — the plan and its approval in
one surface.

**Build:** lift the GT-only registration of `exitPlanTool` (`src/tools/exit_plan.ts`,
`plan_finalize.ts`) so plan-mode exit always fires the 3-option overlay; approving from the
overlay opens/uses the D3b draft view (MP16) so you approve what you can see. v1 = three
options only (inline step-editing = v2). Shift+Tab exit routes through the same gate.
**Agent proof:** scripted shots: GT-off plan → exit → 3-option gate → approve → build mode;
revise loops back to planning; cancel discards.
**Manual test:** both GT-on and GT-off plan sessions.
**Gate:** §1.7.

**Execution notes (landed 2026-07-17):** the tool now registers whenever `mode === "plan"`
(GT on or off). GT-off contract (user decision, CC's ExitPlanMode shape): `exit_plan` gains
a `plan` markdown argument — REQUIRED when no GT session exists (missing → an error asking
the model to resend); `showPlan` pushes it into the transcript so the user approves exactly
what they can see (the D3b panel cannot coexist with the question overlay — scrollback is
the review surface); approve = the mode flip back to build, no GROUND_TRUTH.md. GT-on keeps
the store/finalize path and ignores the argument. **Ring semantics (recorded):** Shift+Tab
OUT of plan mode routes through the same 3-option gate — approve and cancel both land on
build, Esc stays in plan; the fast path (sessionless AND no completed plan turn,
`planTurnSeenRef`) keeps quick flipping, the modes scenario, and GT-off A/B byte-identity
cycle-identical; with bypass enabled the ring's plan→bypass hop is sacrificed (bypass stays
reachable via the next lap or /mode). GT-on Shift+Tab shows the draft doc in the transcript
before the ask. The plan-mode system append now instructs calling `exit_plan` with the
`plan` argument (PLAN_ESCAPE_HATCH sentence untouched, pinned). Mock: `EXITPLAN` marker →
a two-phase exit_plan(plan) tool call (cross-turn note: any prior tool result suppresses
re-issue — per-session, use fresh sessions or the Shift+Tab gate for repeats). Gate:
`plan-exit-gate` scenario (tool overlay + plan md + approve clears the badge; Shift+Tab
gate + Esc-stays + cancel discards); behavior pins migrated to the new registration +
handler. Shots: `shots/mp17-plan-exit/`.

**AMENDMENT (user decision, 2026-07-20): Shift+Tab is a SILENT clean exit — the chord
never opens the gate.** Claude Code parity: the ring just advances (build → accept-edits →
plan → build, bypass when enabled), leaving plan mode discards any live council session via
the mode-exit cleanup effect (transcript notice; the discard aborts the council — a council
cannot outlive its session) and a PLAIN streaming turn is left to finish (non-disruptive
switch; the chord never calls `agent.abort()`). Plan APPROVAL lives ONLY in the `exit_plan`
tool and `/plan finalize` — the 3-option overlay on the chord, the `planTurnSeenRef`
fast-path, and `requestPlanExitGate` are deleted. Mid-turn exits defer `exit_plan`'s
unregistration to the turn's end (retire-list swept in the turn's `finally`; `isActive()`
answers a late call with a graceful "not active") so a turn that advertised the tool never
hits an unknown-tool error. The ring's plan→bypass sacrifice note above still holds. Gate:
`plan-exit-gate` scenario re-pinned (tool overlay + approve; Shift+Tab = silent exit, fluid
ring, the gate text must never appear on the chord).

### MP18 — Verify-command consent at first run *(M · after MP9 recommended)*

**Goal:** LLM-authored `verify` shell gets bash-class scrutiny (not trust-the-gate, not
batch rubber-stamp).

**Build:** first execution of each verify command routes through the existing permission
overlay keyed to the **exact command string**: allow-once / allow-always (sticks per exact
string, per project) / deny; a *changed* verify (sticky-but-overwriteable, `todowrite.ts`)
re-prompts. Consent state lives beside existing permission grants. D3b plan views (MP9/MP16)
list each step's verify command so approval is informed. Headless `-p`: unconsented verify =
fail-closed with a clear error.
**Agent proof:** scripted run: first verify prompts → allow-always → silent thereafter →
agent mutates the verify → re-prompt. Shots of each.
**Manual test:** GT run; confirm the prompts feel right and don't nag.
**Gate:** §1.7 + a test that the gate cannot be bypassed by verify mutation.

**Execution notes (landed 2026-07-17):** **AMENDMENT (user decision): consent is
session-only, in-memory** — the spec's "per project" persistence clause is dropped
(approved shell-command strings never touch disk; a new session re-prompts once per
verify). The audit (AUD-7) showed the TUI prompt path already existed
(`approvedVerifies` exact-string consent, mutation re-prompt, commands verbatim in the
overlay); MP18's real scope was ENFORCEMENT AT EXECUTION TIME: a `VerifyConsent` predicate
threads into BOTH runCheck sites — baseline capture (unconsented → skip, baseline stays
NULL: signal withheld, never fabricated) and the done-gate (unconsented → fail-CLOSED
`unrunnable` gate row + block with `VERIFY_CONSENT_BLOCK`). Consent keys on
`flip.verify` — the EFFECTIVE execution-time command — so the approve-A-then-swap-to-B
dodge is structurally closed (pinned by test, with the swap also honestly voiding the
baseline). Wiring: undefined = allow (library default, all embeddings unchanged);
`main.ts` starts the seam at `headlessVerifyConsent` (deny-all unless
`MINIMA_TUI_ALLOW_VERIFY=1` — headless `-p` now fails closed, breaking zero-consent
automations BY DESIGN with the env escape documented in --help); the TUI swaps in
`bypass-mode || approvedVerifies.has(cmd)` on mount (bypass = blanket consent; acceptEdits
still prompts — todowrite is not in its auto bundle, pinned). Finalize-seeded checks:
plan approval (which displays every verify) IS their consent — `PlanFinalizeOutcome.ok`
gains `seededVerifies`, fed into the consent store by `runPlanFinalize`. Mock: TODOV /
TODOVSWAP / TODOVDONE markers + a fix that mattered: two-phase detection is now
TURN-scoped (tool-result after the LAST user message) — any-tool-result-in-history froze
every marker after the first tool turn (the MP17 scenario's second EXITPLAN send is now a
plain prompt for exactly that reason). Scenarios set `MINIMA_TUI_STOP_STRIKES=0` (an armed
in_progress step otherwise spirals the plan-not-done nag through scripted sends). Gates:
`verify-consent` (prompt → silent → mutation re-prompt) + `headless-verify-consent` (DB
gate rows: unrunnable without the env, verified with it); `verify-consent.test.ts` (both
runCheck sites, mutation-dodge, library default, env checker). Shots:
`shots/mp18-verify-consent/`.

### MP19 — Final E2E acceptance demo *(M/L · last)*

**Goal:** the whole story, proven — J1's demo intent, re-scoped to this guide.

**Build:** one scripted acceptance run, committed as a bun test + shot series: plan (streamed
council, MP14) → draft visible (MP16) → approve gate (MP17) → execute with D3a live (MP5/6)
→ verify consent (MP18) → a step fails red → 🔴 alert → fix → red→green → gate 🟢 → outcome
stamped + feedback sent with realized usage (mock captures it) → Ctrl+T ToC shows the
failed-then-fixed section marker (MP7) → Ctrl+G/`/why` shows the evidence (MP9). Every budget
green during the run.
**Gate:** the demo test + shot series committed. **This closes the guide.**

**Execution notes (landed 2026-07-17):** the story runs TWICE — once in-process
(`tests/acceptance-e2e.test.ts`: canned council round → MP16 draft rows → `exit_plan`
approve → finalize seeds ledger + MP18 consent → the REAL done-gate loop red→block→fix→
green→milestone → `/v1/feedback` captured with realized usage → `buildGtOverview` +
`whyText` evidence, all with the STRICT consent checker installed) and once through a real
PTY (`tui_verify.sh` scenario `acceptance`, 42s, ordered-beat asserts + zero-wipe +
no-mouse + perf budgets): `/plan start` → council line ticking (MP14) → planner reply →
Ctrl+G `plan (draft)` (MP16) → `/plan finalize` approves (amended 2026-07-20 with the
silent-exit chord — the MP17 gate rides `exit_plan`/`/plan finalize` only; finalize via the
mock's RESOLVE/GT answers seeds the single-step plan + its verify consent, MP18) → `PLANDEMO`
executes phase-scripted: in_progress todowrite (permission overlay shows the verify;
baseline red) → completing while red → **the done-gate blocks** → `write` fixes → completing
again → **red→green verified, plan closes** (milestone) → Ctrl+T shows the section's
**`⚠→✓` failed-then-fixed marker** (built in this MP: `TocSection.recovered` = a tool
errored mid-section but the LAST tool event was clean and a result exists; an ERRORED
todowrite now falls through to generic tool tracking — previously the todowrite branch
swallowed it and no gate block could ever flag a section — and a clean todowrite clears the
strike) → Ctrl+G overview (✅ step, honest tier) → step card → `/why`. Mock additions:
single-step `COUNCIL_GT` (a one-step plan can CLOSE, exercising the milestone) and the
`PLANDEMO` phase-counter script (phase = tool results this turn). Observed honesty note:
the verified step's tier lands 🟡 (coverage "unknown" on a `test -f` check) — the tier
ladder's strictness, already documented in the MP13 audit; the demo asserts reality.
Shots: `shots/mp19-acceptance/` numbered 1-council … 7-step-card. **Track W complete —
the guide is closed** (remaining follow-ups live in the MP13 audit's disposition and the
§12 backlog, not here).

---

## 11. What NOT to do

- **No fullscreen resurrection** — no alt-screen, no `?1049`, no frame-anchored UI. The bar
  to reverse is in `decision-inline-renderer.md` §5 (+ amendment).
- **No mouse capture in inline. Ever.** The wheel belongs to the terminal.
- **Never let the live region reach `rows`.** Every new footer/panel element states its row
  budget; unbounded elements are rejected in review.
- **No SidebarChassis revival** — no cwd/version panel chrome; CC inline language only.
- **No bundling MPs** — one MP, one branch, one PR, one compact.
- **No new rendering-strategy docs** — evidence lands as edits here or in the ADR.
- **No skipping the verification-first step** — an MP that starts with implementation is
  restarted.

## 12. Linear mapping

One issue per MP in [Minima – Big Plan](https://linear.app/mubit/project/minima-big-plan-af98e58f1f1a/overview);
statuses live in Linear, not here (this file stays append-only for decisions/evidence).

| MP | issue | | MP | issue |
|---|---|---|---|---|
| MP0 | MUB-143 | | MP10 | MUB-153 |
| MP1 | MUB-144 | | MP11 | MUB-154 |
| MP2 | MUB-145 | | MP12 | MUB-155 |
| MP3 | MUB-146 | | MP13 | MUB-156 |
| MP4 | MUB-147 | | MP14 | MUB-157 |
| MP5 | MUB-148 | | MP15 | MUB-158 |
| MP6 | MUB-149 | | MP16 | MUB-159 |
| MP7 | MUB-150 | | MP17 | MUB-160 |
| MP8 | MUB-151 | | MP18 | MUB-161 |
| MP9 | MUB-152 | | MP19 | MUB-162 |
| MP20 | MUB-165 | | | |
