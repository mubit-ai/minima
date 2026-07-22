# Launch-bug retest guide (LB-1..LB-17 · PRs #230–#240)

Companion to `errors-list.md`. One round per PR, in merge order. Every block is
copy-paste; every test says what you should see. Record results the usual way:
`LB-N — ✅/❌ + one line` (+ screenshot if visual) into `playground/manual-testing.md`.

| Round | PR | Branch / worktree | Bugs | Linear |
|---|---|---|---|---|
| 1 | #234 | `minima-lb-a` → fix/lb-renderer-session | LB-1..4 | MUB-167..170 |
| 2 | #230 | `minima-lb-b` → fix/lb-cost-truth | LB-5..7 | MUB-171..173 |
| 3 | #239 | `minima-lb-c` → fix/lb-routing-replay | LB-8..10 | MUB-174..176 |
| 4 | #235 | `minima-lb-d` → fix/lb-permissions | LB-11..13 | MUB-177..179 |
| 5 | #240 | `minima-lb-e` → fix/lb-plan-gates | LB-14..15 | MUB-180..181 |
| 6 | #236 | `minima-lb-f` → fix/lb-reasoning-compat | LB-16 | MUB-182 |
| 7 | #237 | `minima-lb-g` → fix/lb-prompt-queue | LB-17 | MUB-183 |

---

## ROUND 2 ADDENDUM (2026-07-22, after the first retest) — read before re-running

⚠ LANDING CHANGE: while round 2 was in flight, all seven round-1 PRs were squash-merged
into **main** (v0.14.0 shipped) — so round-2 fixes land as FIVE NEW PRs against main:
**#252** (visual queue) · **#253** (bypass ring default) · **#254** (/why session cost) ·
**#255** (plan supersede + harness noise) · **#256** (top-anchor + overlay + echo dedup).
Round-1 changes are already on main — retest round-2 items pre-merge with
`minima-loc --wt minima-lb-<x>` (worktrees now sit on the `-r2` branches: a=renderer,
b=/why cost, d=bypass ring, e=plan gates, g=queue), or post-merge from a main checkout.
NOTE: the main worktree still sits on the now-obsolete `fix/post-BP` — switch it to
`main` before using plain `minima-loc`. Merge-order: #255 and #256 both touch app.tsx —
merge either first, the other may need a trivial rebase. What changed per round:

- **Round 1 (#234)** — the layout model flipped to Claude-Code-style **top-anchor**:
  after boot the banner sits at the TOP of a cleared screen, the composer at the
  bottom; your first `hi` echoes directly UNDER the banner at the top and replies fill
  DOWNWARD (gap in the middle). `/clear`/`/new` reseat the same way. Also new:
  the prompt box stays visible (dimmed) under a permission overlay; shrinking the
  window below 40×10 keeps an armed permission prompt answerable; a routed retry
  (recovery ladder) no longer re-echoes your prompt twice.
- **Round 2 (#230)** — `/why`/Ctrl+G gains two dim lines under Σ:
  `session total $X · unattributed $Y`. Session total matches the footer $; Σ still
  counts stamped steps only.
- **Round 4 (#235)** — **bypass is in the Shift+Tab ring by default**: fresh boot,
  press Shift+Tab 4× → build → acceptEdits → plan → ⚠ BYPASS → build. No `/mode
  bypass` needed. Still never persisted across relaunch.
- **Round 5 (#240)** — the saga fixes. New expectations to test:
  (a) after `/plan finalize`, a second `/plan start <new goal>` explicitly supersedes
  the old plan ("previous plan '<title>' superseded") and plans fresh — the old steps
  never haunt the stop-gate again; (b) if the model writes a todo list that shares
  NOTHING with the active plan, the panel shows a NEW plan (new title, new steps) —
  never old-title+new-steps; (c) plan-mode denials render as one dim line
  (`⊘ bash — blocked in plan mode`), not a red paragraph; stop-gate/turn-budget
  notices render dim, not as "▸ you" bubbles; (d) todowrite array args no longer error
  "tasks: expected string"; (e) the 30-turn wrap-up and the stop-gate can no longer
  contradict each other in the same rung.
- **Round 7 (#237)** — queued prompts now ALSO render as stacked dim lines directly
  above the prompt box (last 3 + "+N more"), CC-style, in addition to the status note.

Merge-order change: **merge #234 before #240** (both touch app.tsx; #240 rebases after).

---

## 0. How to run

**Never use the brew `minima` (0.12.2) for these retests** — half the original findings
were version skew. Use your `minima-loc` alias (runs the TUI from source, preserves cwd).

Two ways to point it at the right code:

```bash
# BEFORE merging a PR — run that PR's worktree directly:
minima-loc --wt minima-lb-a          # substitute -b, -c, -d, -e, -f, -g per round

# AFTER merging into fix/post-BP — run the main worktree (it's on fix/post-BP):
minima-loc
```

- Test from your sandbox: `cd /Users/eldaru/Mubit/Minima/playground_minima` first
  (cwd matters for permission/ckpt tests; some tests below say to use a subdirectory).
- If a worktree complains about deps: `cd <worktree>/packages/tui && bun install`.
- Any CLI flag passes through: `minima-loc --wt minima-lb-b --model claude-haiku-4-5`.
- **Evidence DB** (safe to query while the TUI runs, WAL):

```bash
sqlite3 -header -column ~/.minima-harness/minima.db \
  "SELECT substr(rec_id,1,8) rec, chosen_model, outcome, round(actual_cost_usd,5) cost, substr(step_id,1,8) step FROM routing_decisions ORDER BY ts DESC LIMIT 10;"
```

Pin haiku (`--model claude-haiku-4-5`) whenever a test doesn't care about routing —
cheaper and quieter.

---

## Round 1 — PR #234 renderer + session (LB-1..LB-4)

```bash
cd /Users/eldaru/Mubit/Minima/playground_minima
minima-loc --wt minima-lb-a --model claude-haiku-4-5
```

**LB-1 — first prompt echo sits at the bottom**
- **Do**: fresh launch, type `hi`, Enter. Watch where the `▸ you / hi` echo lands.
- **Expect**: the echo appears directly above the composer at the **bottom** of the
  terminal — no dead 10-row gap mid-screen (the old image.png failure). The MINIMA
  banner scrolls up into scrollback instead of being erased.
- **Record**: screenshot.

**LB-3 — /clear actually clears**
- **Do**: run 2–3 more short prompts, then:
```
/clear
```
- **Expect**: screen wipes completely (scroll up: old transcript is GONE from
  scrollback), banner re-seats at the terminal bottom, next prompt behaves like a
  fresh session. `/new` behaves the same way.
- **Record**: screenshot after /clear + one after scrolling up.

**LB-4 — /compact reports a real delta**
- **Do**: after ~6+ turns:
```
/compact
```
- **Expect**: message reports an **estimated token delta / freed %** derived from your
  session (numbers vary run to run) — not the old constant `N → 7 messages`. On a
  near-empty session it says there's nothing to compact.

**LB-2 — plain relaunch = new session**
- **Do**: `/quit`, then relaunch the same command. Check the transcript and `/session`.
- **Expect**: brand-new empty session every time (no old transcript). Named resume
  still works: `/name lb-test` → `/quit` → `minima-loc --wt minima-lb-a --resume lb-test`
  → history comes back.
- **Note**: Mubit *recall* may still mention past work — that's memory injection, not a
  resumed session. Session id is the tell.

---

## Round 2 — PR #230 cost truth (LB-5..LB-7)

```bash
cd /Users/eldaru/Mubit/Minima/playground_minima
minima-loc --wt minima-lb-b --model claude-haiku-4-5
```

**LB-5 — /tree shows real child costs + final status**
- **Do**:
```
Use your task tool to delegate two independent subtasks in parallel: (1) count the .py files in this directory, (2) list the top-level directories here. Then summarize both results.
```
  After the summary lands: `/tree`
- **Expect**: each child row shows a **non-zero dollar figure** (matching the
  `($0.00xx)` figures in the task result block) and a **finished** status — not
  `$0.0000` + perpetually "running".
- **Record**: screenshot of the panel.

**LB-6 — websearch fee lands in the ToC**
- **Do**:
```
Use your web_search tool to find the current release version of Bun. One search only.
```
  Approve the search, then **Ctrl+T**.
- **Expect**: the turn's ToC section includes the **search provider fee** and the Σ
  footer includes it. With Exa configured that's **+$0.005 per search** on top of token
  cost; with DuckDuckGo the fee is $0.00 (free) — the point is the booking path exists,
  so Exa is the interesting case. Footer session total also moves.

**LB-7 — /why stamps step costs (needs a completed plan)**
- **Cheap option**: skip now and verify during Round 5's plan run — one council spend
  covers both. **Direct option**: make a tiny sandbox and run a plan:
```bash
mkdir -p /Users/eldaru/Mubit/Minima/playground_minima/lb7-sandbox && cd $_
git init -q
printf 'def add(a, b):\n    return a - b\n' > mathx.py
printf 'import mathx\nassert mathx.add(2, 3) == 5\nprint("ok")\n' > test_mathx.py
git add -A && git commit -qm init
minima-loc --wt minima-lb-b
```
```
/plan start Fix the failing test in this repo
The test fails because add() subtracts. Propose a minimal fix plan with a verify command per step.
/plan finalize
Now implement the plan.
```
  Approve tool/verify prompts; let all steps flip ✅. Then: `/why`
- **Expect**: header says **step N/N** (not `0/N`) and **Σ realized > $0.0000**;
  completed steps carry their own cost figures. DB check:
```bash
sqlite3 -header -column ~/.minima-harness/minima.db \
  "SELECT substr(step_id,1,8) step, round(actual_cost_usd,5) cost FROM routing_decisions WHERE step_id IS NOT NULL ORDER BY ts DESC LIMIT 5;"
```
  → rows with non-null step ids and non-zero cost.

---

## Round 3 — PR #239 routing labels + replay (LB-8..LB-10)

```bash
cd /Users/eldaru/Mubit/Minima/playground_minima
minima-loc --wt minima-lb-c
```

**LB-8 — Esc abort is labeled honestly**
- **Do**:
```
Write a 500-word story about a lighthouse.
```
  Press **Esc** quickly (during "brewing…" / early stream). Repeat 2–3 times to catch
  the routing phase at least once.
- **Expect**: an abort caught during routing prints
  **"aborted during routing — no model ran."** — never
  `routing offline: Minima unreachable … /reconnect`. A genuine offline still says
  offline (test by turning off Wi-Fi for one prompt if you want the negative case).

**LB-9 — resume after tool calls doesn't 400**
- **Do**:
```
Run ls with bash and tell me what you see.
```
  Approve it. Then `/name lb9` → `/quit` → relaunch:
```bash
minima-loc --wt minima-lb-c --resume lb9
```
```
Now count how many of those files are Python files.
```
- **Expect**: the continued turn runs normally. No
  `400 … tool_result.tool_use_id: Field required` (the old image-12 failure).

**LB-10 — /ckpt re-detects git init**
- **Do**:
```bash
mkdir -p /Users/eldaru/Mubit/Minima/playground_minima/lb10-nogit && cd $_
minima-loc --wt minima-lb-c --model claude-haiku-4-5
```
```
/ckpt
Run "git init" with bash.
/ckpt
```
- **Expect**: first `/ckpt` → "checkpoints off — not a git repository". After the
  agent's `git init`, second `/ckpt` → checkpoints **available** (lists/empty state, no
  "not a git repository"). `/undo` and `/rewind` also come alive.

---

## Round 4 — PR #235 permissions (LB-11..LB-13)

```bash
cd /Users/eldaru/Mubit/Minima/playground_minima
minima-loc --wt minima-lb-d --model claude-haiku-4-5
```

**LB-12 — "Always write" no longer escapes the cwd**
- **Do**:
```
Create a file lb12.txt containing "one"
```
  On the permission overlay press **a** (Always). Then:
```
Write a file /tmp/lb12-escape.txt containing "x"
```
  Then:
```
Append "two" to lb12.txt
```
- **Expect**: the `/tmp` write **PROMPTS** despite the Always grant (this was the
  silent escape in image-1). The in-cwd append stays silent (grant still honored inside
  cwd). Works the same in `/mode accept` and build mode.
- **Record**: which of the three prompted.

**LB-13 — Finalize & auto-accept covers reads, bash still asks, bypass joins the ring**
- **Do**: `/plan start Add a README note` → one short planning turn → when the
  exit-plan overlay appears pick **"Finalize & auto-accept edits"** (or `/plan finalize`
  then choose it). Then:
```
Read lb12.txt and tell me what it says.
Run "ls" with bash.
```
  Then press **Shift+Tab** a few times.
- **Expect**: the in-cwd **read runs with no prompt**; **bash still prompts**; the
  Shift+Tab ring now includes **⚠ BYPASS** (build → acceptEdits → plan → bypass).
  Relaunch afterwards → bypass is gone from the ring (never persisted).

**LB-11 — /mode bypass ring (was not reproducible — confirm)**
- **Do**: `/mode bypass`, then Shift+Tab 4× with **no overlay open**. `/quit`, relaunch.
- **Expect**: red `⚠ BYPASS` badge; ring cycles all 4 modes; after relaunch bypass is
  neither active nor in the ring. If this FAILS on source, capture exactly what overlay
  (if any) was on screen — that was the suspected original false-negative.

---

## Round 5 — PR #240 plan gates (LB-14..LB-15)

Use the Round-2 sandbox (or make it now — see LB-7 block):

```bash
cd /Users/eldaru/Mubit/Minima/playground_minima/lb7-sandbox
minima-loc --wt minima-lb-e
```

**LB-14 — /plan start is idempotent + the goal is used**
- **Do**:
```
/plan start Fix the failing test in this repo
/plan start Do something completely different
```
- **Expect**: second start does **not** silently restart planning — you get an
  "already ON / goal unchanged" style notice, and the first goal survives. Then run the
  plan through finalize (as in LB-7) and check `BigPlan.md`:
```bash
cat BigPlan.md | head -20
```
  → the `## Goal` section carries **your** goal text ("Fix the failing test…").

**LB-15 — no stop-gate nag after the plan is done**
- **Do**: with all steps ✅ (plan closed), keep chatting:
```
Use your question tool to ask me what I want to do next, with "just chat" as an option.
```
  Pick "just chat" (or type it). Then:
```
Tell me a one-line joke.
```
- **Expect**: **no** `⛔ You are ending the turn, but the plan is not done — N step(s)`
  (the image-10 misfire). The gate still fires for a genuinely incomplete plan — if you
  want the negative case: `/plan start`, finalize a 2-step plan, then say
  `Stop working now. Do not complete the plan.` → the strike message appears.

---

## Round 6 — PR #236 reasoning compat (LB-16)

```bash
cd /Users/eldaru/Mubit/Minima/playground_minima
minima-loc --wt minima-lb-f --model claude-sonnet-5
```

**LB-16a — adaptive thinking format (no more 400)**
- **Do**: press **Ctrl+E** until the footer shows `reason: high`, then `/thoughts on`,
  then:
```
What is 17 * 23 + 101? Think it through.
```
- **Expect**: reasoning streams and the answer lands. **No**
  `400 "thinking.type.enabled" is not supported…` (the image-5 failure). Adaptive
  format applies to claude-sonnet-5 / opus-4-7+ / Fable / Mythos; older models
  (haiku-4-5) still use the classic format — repeat with
  `--model claude-haiku-4-5` if you want the classic path confirmed too.

**LB-16b — routing avoids non-reasoning models under reason:high**
- **Do**: quit, relaunch WITHOUT a pinned model (`minima-loc --wt minima-lb-f`),
  Ctrl+E to `reason: high`, run 2–3 mixed prompts, then:
```bash
sqlite3 -header -column ~/.minima-harness/minima.db \
  "SELECT chosen_model, outcome FROM routing_decisions ORDER BY ts DESC LIMIT 5;"
```
- **Expect**: every chosen model is reasoning-capable; no 400s. If your key set has NO
  reasoning-capable candidates, the turn still runs and a muted
  `reasoning_filter_skipped…` note appears instead of an empty pool.

---

## Round 7 — PR #237 prompt queue (LB-17)

```bash
cd /Users/eldaru/Mubit/Minima/playground_minima
minima-loc --wt minima-lb-g --model claude-haiku-4-5
```

**LB-17 — type while it runs**
- **Do**:
```
Write a 300-word story about a robot.
```
  While it streams: type `/tree` + Enter. Then type `and now a haiku about rain` +
  Enter. Watch the status bar. When the story finishes, wait.
- **Expect**: `/tree` opens **immediately** mid-run (composer is live, no "(busy…)"
  lock). The typed prompt does NOT interrupt the stream — status bar shows
  **"1 queued"** — and it **auto-submits** as the next turn when the story completes.
- **Then**: queue another prompt mid-run and press **Esc** → the turn aborts and the
  queue is **held** (nothing auto-fires; status shows held). Press **Esc again while
  idle** → queue cleared with a notice.
- Local commands that dispatch immediately while busy: `/tree`, `/tasks`, `/why`,
  `/bp`, `/session`, `/cost`, `/perms`, `/memory list`, `/help`. Everything else queues.

---

## After each round

1. Record `LB-N — ✅/❌ + one line` in `playground/manual-testing.md`.
2. On ✅: merge the PR into `fix/post-BP`, move its MUB issue(s) to Done, and from then
   on test the merged state with plain `minima-loc` (main worktree).
3. On ❌: comment the repro on the PR + Linear issue; don't merge.
4. After ALL rounds: clean up —
```bash
cd /Users/eldaru/Mubit/Minima/minima
for w in a b c d e f g; do git worktree remove ../minima-lb-$w; done
git worktree prune
```
