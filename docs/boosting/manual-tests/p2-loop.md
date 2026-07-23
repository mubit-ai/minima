# P2 manual tests — loop robustness (bash steer + replay guard + abort scopes)

Feature branch: `feat/boost-p2-loop` (worktree `/Users/eldaru/Mubit/Minima/minima-boost-p2-loop`).
Everything here is testable with zero prior context. Each numbered scenario maps to one
acceptance criterion of `docs/boosting/p2-loop-plan.md` §6.

## Prerequisites

1. Install deps in the feature worktree once:

   ```bash
   cd /Users/eldaru/Mubit/Minima/minima-boost-p2-loop/packages/tui && bun install
   ```

2. Launch the TUI from the playground repo, running this worktree's code:

   ```bash
   cd /Users/eldaru/Mubit/Minima/playground_minima && minima-loc --wt minima-boost-p2-loop
   ```

3. The feature flag is `MINIMA_TUI_STEER` — **default ON**. Escape hatch:

   ```bash
   MINIMA_TUI_STEER=0 minima-loc --wt minima-boost-p2-loop
   ```

The steer message is pinned. Wherever a scenario says "the steer message", it means exactly
(for a blocked `grep`; other rules substitute the first token and the named tool/benefit):

```
bash steer: `grep` was blocked before executing — use the native `grep` tool instead of shelling out. It returns file:line matches, respects .gitignore, and bounds output. Re-issue this as a `grep` tool call. Ordinary shell commands (builds, tests, git, pipelines) are never blocked. (Opt out: MINIMA_TUI_STEER=0.)
```

## Scenario 1 — AC1: a shelled-out grep is blocked with the steer message

Prompt (copy-paste):

```
Using the bash tool and nothing else, run exactly: grep TODO src/
```

EXPECTED:
- The bash tool cell renders as a RED (error) tool result whose body is exactly the pinned
  steer message above. No grep output appears — bash never spawned.
- The model typically re-issues the search as a native `grep` tool call on its next turn;
  that call runs normally.

HOW TO VERIFY: read the transcript tool cells — the first bash cell shows the
`bash steer:` body and an error state; any follow-up `grep` tool cell shows real matches
(or "no matches").

## Scenario 2 — AC2: ordinary commands are never blocked (negative matrix)

Prompt each of these separately (each says "using bash, run exactly: …"):

```
Using the bash tool and nothing else, run exactly: git status
```

```
Using the bash tool and nothing else, run exactly: grep TODO src/ | wc -l
```

```
Using the bash tool and nothing else, run exactly: cat README.md LICENSE
```

```
Run the test suite with bash: bun test tests/steer-bash.test.ts
```

(For the last one, launch the TUI from the feature worktree's `packages/tui` directory
instead of the playground, or the file won't exist — the point is only that the command
EXECUTES.)

EXPECTED: every one of these executes — normal (non-red) bash cells with real command
output and an exit code. In particular the pipeline (`| wc -l`) runs even though it
contains the same `grep TODO src/`, and the multi-file `cat` runs (concatenation is not a
read). Nothing shows a `bash steer:` body.

HOW TO VERIFY: transcript tool cells show command output, not the steer message.

## Scenario 3 — AC3: MINIMA_TUI_STEER=0 disables all blocking

Quit the TUI and relaunch with the flag off:

```bash
cd /Users/eldaru/Mubit/Minima/playground_minima && MINIMA_TUI_STEER=0 minima-loc --wt minima-boost-p2-loop
```

Repeat Scenario 1's prompt verbatim.

EXPECTED: bash EXECUTES `grep TODO src/` — the tool cell shows grep's real output/exit
code (matches, `grep: src/: Is a directory`, or `grep: src/: No such file or directory`,
depending on the repo). No `bash steer:` body anywhere in the session.

HOW TO VERIFY: transcript tool cell contains grep's own output.

## Scenario 4 — AC4: an effectful failed rung is retained across ladder escalation

PREREQUISITES (this scenario needs the full live loop; skip to the fallback if any is
missing):
- Live routing: `MUBIT_API_KEY` set and the Minima service reachable (no
  "offline" banner at boot), plus a provider key for at least two candidate models — the
  ladder must be able to escalate to a second model.
- Plan verification ON (default; do not set `MINIMA_TUI_BIG_PLAN=0`).
- Flag ON (do not set `MINIMA_TUI_STEER=0`).

Steps:
1. Give a task that makes a real side effect and then fails its verify, e.g.:

   ```
   Create a plan with one step: run `touch p2-probe.txt` with bash, with verify command `false`. Then execute the step and mark it done.
   ```

   The verify (`false`) is red, so after the done-gate fails the rung, the recovery ladder
   escalates to a new model rung.
2. After the escalation visibly re-prompts (the retry turn), ask:

   ```
   Without running any tool, what commands did you already execute this session?
   ```

EXPECTED:
- The post-escalation model NAMES the `touch p2-probe.txt` execution — its context still
  contains the rung-1 tool results (retention). Under `MINIMA_TUI_STEER=0` the same flow
  cannot: the rolled-back rung-2 model has no record of the touch.
- Cross-check in the DB (`~/.minima-harness/minima.db`, or `$MINIMA_DB_PATH`): the run has
  two `routing_decisions` rows for the task, the second linking to the first via
  `parent_rec_id`:

  ```bash
  sqlite3 ~/.minima-harness/minima.db "SELECT rec_id, chosen_model, outcome, parent_rec_id FROM routing_decisions ORDER BY ts DESC LIMIT 4;"
  ```

DETERMINISTIC FALLBACK (authoritative for AC4 — run this regardless):

```bash
cd /Users/eldaru/Mubit/Minima/minima-boost-p2-loop/packages/tui && bun test tests/ladder-replay.test.ts
```

EXPECTED: 5 pass, 0 fail — including "an effectful failed rung escalates WITHOUT erasing
context" and "steer=false keeps today's rollback".

## Scenario 5 — AC5: run-level abort regression (Esc still works)

Tool-scoped abort ships as plumbing only in P2 — there is NO user-facing surface by
design. At the UI this is a regression check that the existing Esc abort is unchanged.

Prompt:

```
run: sleep 30 with bash
```

Press Esc while the command runs.

EXPECTED: the bash cell ends as an error containing `bash: aborted` (with whatever partial
output was captured), the run stops, and the next prompt works normally.

Authoritative check for the new per-tool-call plumbing (registry, `abortToolCall`,
sibling isolation):

```bash
cd /Users/eldaru/Mubit/Minima/minima-boost-p2-loop/packages/tui && bun test tests/tool-abort-scope.test.ts
```

EXPECTED: 13 pass, 0 fail.

## Teardown / reset

```bash
cd /Users/eldaru/Mubit/Minima/playground_minima && rm -f p2-probe.txt
unset MINIMA_TUI_STEER
```

- Quit any running TUI session (Ctrl+C twice or /quit).
- Scenario 4 leaves ordinary session rows in `~/.minima-harness/minima.db`; nothing needs
  cleaning there (append-only ledger, new sessions are unaffected).
- If you launched with `MINIMA_TUI_STEER=0` in a shell you keep using, make sure the
  variable is unset (step above) so later sessions get the default-ON behavior.
