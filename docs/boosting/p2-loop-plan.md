# P2 — Loop robustness: implementation plan

> Wave 2 feature plan, branch `feat/boost-p2-loop` (forked from `feat/boosting` @ `49ef395`).
> Spec authority: `docs/boosting/boosting-roadmap.md` §A + §E (P2); collision map:
> `docs/boosting/wave2-preflight.md`. Reference only (zero code copied):
> `docs/boosting/research/oh-my-pi-analysis.md`. All paths below are `packages/tui/…`
> unless absolute. All commands run in `packages/tui`.

## 1. Scope + non-goals

In scope (the locked core trio):
1. **Bash-interceptor rule table** — a `beforeToolCall` hook, registered by harness code on the
   existing hook stack, that blocks `cat/head/tail/grep/find/sed -i` bash invocations with a steer
   message naming the native tool (`read`/`grep`/`glob`/`edit`). Enforcement in the dispatcher —
   the hook's `block:true` becomes the tool-error result at `src/agent/loop.ts:405-411` — never
   prompt text.
2. **Retry classifier** — a precise "observable output" classifier enforced at the one code path
   that silently replays a turn today (the recovery ladder's context rollback,
   `src/minima/runtime.ts:787`): a rung that dispatched tool calls is never erased-and-replayed.
3. **Tool-scoped abort placeholders** — per-tool-call `AbortController` plumbing + a registry +
   `Agent.abortToolCall(id)`. Plumbing only; exact ship-list in §2c.

Non-goals: **TTSR is explicitly OUT** (stays a stretch goal, roadmap §E). No embedded shell, no
`cd`-extraction, no per-role fallback chains, no credential rotation, no synthesized abort results,
no UI/keybinding for tool-scoped abort, no tool JSON-schema changes, no new deps, no DB migration.

## 2. Design

### 2a. Bash interceptor (`src/minima/bash_steer.ts`, new)

Pure + total module (mirror `src/minima/tool_permissions.ts` style): `bashSteerDecision(command:
string): { block: true; nativeTool: string; reason: string } | null`, plus
`makeBashSteerHook(cfg: HarnessConfig): BeforeToolCall` which returns `null` unless
`cfg.steer === true` (call-time check), `ctx.toolCall.name === "bash"`, and `ctx.args.command` is a
string that matches a rule.

**Conservative matching algorithm** (false positives are worse than misses):
1. **Metacharacter guard**: if the trimmed command contains any of `\n`, `|`, `&`, `;`, `>`, `<`
   (covers `&&`, `||`, backticks and `$(…)` also guard, heredocs `<<`, redirects) → PASS.
   Only a single simple command is ever analyzed.
2. Split on whitespace. If the first token contains `=` (env-var prefix) or `/` (explicit path
   like `/usr/bin/grep`) → PASS. Rules key on the first token EXACTLY.
3. Rule table (first token → rule; "non-flag arg" = token not starting with `-`):

| First token | Blocks when | Steers to | Passes through (examples) |
|---|---|---|---|
| `grep` | ≥2 non-flag args (pattern + path) | `grep` | `grep foo` (stdin, harmless), `git grep foo`, `grep "a\|b" src/` (quoted pipe trips guard — accepted miss) |
| `cat` | exactly 1 non-flag arg | `read` | `cat a.txt b.txt` (concatenation), `cat` (stdin), `cat <<EOF`, `cat f > g` |
| `head` / `tail` | ≥1 non-flag arg and no `-f`/`--follow` token | `read` | `tail -f server.log`, `head` (stdin) |
| `find` | every `-flag` token ∈ {`-name`,`-iname`,`-type`,`-path`,`-ipath`,`-maxdepth`,`-mindepth`} | `glob` | `find . -name '*.o' -delete`, `find . -exec …`, any unknown flag → PASS |
| `sed` | a token is `-i`, starts with `-i` (e.g. `-i.bak`), or is `--in-place` | `edit` | `sed 's/a/b/' f.txt` (no `-i`), `sed -n 5p f` |

`bash("grep foo src/")` → blocked (placeholder acceptance); `bash("make test")`, `bash("git
status")`, `bash("bash scripts/dev.sh grep foo")` → untouched.

**Steer message — exact format** (stable machine-checkable prefix `bash steer:`):
```
bash steer: `<first-token>` was blocked before executing — use the native `<tool>` tool instead of shelling out. <one-line benefit>. Re-issue this as a `<tool>` tool call. Ordinary shell commands (builds, tests, git, pipelines) are never blocked. (Opt out: MINIMA_TUI_STEER=0.)
```
Benefit lines: grep→"It returns file:line matches, respects .gitignore, and bounds output";
cat/head/tail→"read(offset, limit) pages any window with numbered, bounded output"; find→"glob
matches patterns with gitignore filtering and deterministic ordering"; sed→"edit makes exact,
reviewable replacements".

**Registration (harness code, on the existing stack)**: `src/cli/main.ts` immediately after the
agent is constructed at `main.ts:717-723`: `agent.addBeforeToolCall(makeBashSteerHook(config));`
(unconditional registration; the flag is checked at call time so tests/`/config` can toggle).
Because this runs before the TUI mounts, it sits FIRST on the stack — ahead of the TUI permission
hook (`src/tui/app.tsx:1468-1512`) and the headless checkpoint/done-gate hooks
(`main.ts:1104-1116`); first block wins (`src/agent/agent.ts:244-250`), so a steered command never
raises a pointless permission overlay. Sub-agents: same one-liner in `src/minima/spawn.ts` beside
`child.addAfterToolCall` (~`spawn.ts:167-196`), using `parent.config`.

### 2b. Retry classifier (`src/minima/replay_guard.ts`, new)

**"Observable output", precisely.** For a rung window `messages.slice(runStartIdx)`
(`runStartIdx` = `src/minima/runtime.ts:615`), `classifyRungOutput(messages, fromIdx)` returns:
- `"effectful"` — any message with `role === "toolResult"` in the window. A tool call reached the
  dispatcher (executed → possible world side effects; hook-blocked → still a model-visible error
  result). Conservative: all toolResults count.
- `"text_only"` — no toolResult, but some assistant message carries a non-empty `text`/`thinking`
  block (streamed to the user) — including a `stop_reason === "error"` assistant with non-empty
  partial text.
- `"clean"` — everything else (empty window, or only empty-content error assistants — the provider
  hard-fail shape `content: [text("")], stop_reason: "error"`).

**Replay-path map (every path that can re-run a turn today) + enforcement:**
1. **Recovery ladder** — `src/minima/runtime.ts:471` (attempt loop), `:626-630` (re-issue via
   `super.prompt`, LB-21 `ladder_reprompt` flag), `:734` (`canRecover`), `:787` (silent context
   rollback `this.agentState.messages.length = preRunIdx`). **The only silent-replay site — the
   choke point.** Change `:786-787` to:
   ```ts
   const rungClass = classifyRungOutput(this.agentState.messages, runStartIdx);
   if (!this.config.steer || rungClass !== "effectful") this.agentState.messages.length = runStartIdx;
   ```
   `runStartIdx` replaces `preRunIdx` (identical value today; required once an effectful rung is
   retained so a later clean rung's rollback can't erase kept evidence). Effectful rungs are never
   replayed against an erased context: the evidence stays, the flagged re-prompt continues on top
   (history stays well-formed — the window ends with toolResult/assistant; error-assistants are
   already stripped for the wire by `dropFailedCalls`, `src/agent/loop.ts:347-349`).
   `clean`/`text_only` keep today's rollback: nothing world-side re-executes, the DB sink recorded
   every message (state in the DB, projection in the context), and the retry is user-visible
   (LB-21), i.e. not silent.
2. **/redo** — `src/minima/redo.ts:55` consumed at `src/tui/app.tsx:3346-3358`: re-submits via
   `onSubmit(result.task)` as a NEW prompt; no history truncation, user-initiated. Compliant by
   construction; no change.
3. **Provider layer (`src/ai`)** — audited: NO retry/replay exists. `stream.ts` and
   `providers/{anthropic,openai_compat,google,faux}.ts` contain no retry loops;
   `model_fallback.ts` substitutes meta-call models at construction (not a turn replay).
   `StreamIdleTimeoutError` (`src/agent/loop.ts:279`) surfaces as a rung hard error → path 1.
4. **Resume/rewind** — `src/db/rehydrate.ts` / `src/session/rewind.ts` rebuild context from the
   DB; they never re-issue a turn. Out of scope.

Existing ladder tests stay green: `tests/ladder.test.ts` runs with `tools: []` (never effectful);
its rollback assertion (`ladder.test.ts:228-231`) is the `clean` case. Risk note: run the full
suite; `tests/big-plan-e2e.test.ts:158` escalates with tools in play but asserts DB rows, not
`agentState.messages` — verified unaffected.

### 2c. Tool-scoped abort placeholders

Today: one run-level controller (`src/agent/agent.ts:186-187`) → `config.signal`
(`agent.ts:293`) → every tool in a batch shares it (`src/agent/loop.ts:456`). `abort()` is
all-or-nothing. The placeholder ships exactly:
1. `AgentState` gains `readonly toolAbortScopes = new Map<string, AbortController>()`
   (`src/agent/state.ts`, beside `pendingToolCalls` at `state.ts:28`).
2. `runOneTool` (`src/agent/loop.ts:442-461`): mint a per-call controller, register by `p.tc.id`
   before `execute`, pass `AbortSignal.any([config.signal, scope.signal])` (or the scope signal
   alone when `config.signal` is null), delete from the map in a `finally`.
3. `Agent.abortToolCall(toolCallId: string): boolean` (`src/agent/agent.ts`, after `abort()`
   ~`:207`): aborts that scope only; false when unknown/finished. The tool's own signal handling
   produces the result (bash: partial-output `bash: aborted`, `src/tools/bash.ts:129-137`).
No synthesized placeholder results, no UI, no steering integration (the full feature is later).
Not flag-gated: purely additive plumbing with zero behavior change until `abortToolCall` is called
(the flag gates blocking behavior; this blocks nothing).

## 3. Write-set (exhaustive)

New: `src/minima/bash_steer.ts` · `src/minima/replay_guard.ts` · `tests/steer-bash.test.ts` ·
`tests/ladder-replay.test.ts` · `tests/tool-abort-scope.test.ts`.
Modified: `src/minima/config.ts` (flag) · `src/cli/main.ts` (~`:723`, hook registration) ·
`src/minima/spawn.ts` (~`:167-196`, child registration) · `src/minima/runtime.ts` (`:786-787`) ·
`src/agent/state.ts` (one field) · `src/agent/loop.ts` (`runOneTool`) · `src/agent/agent.ts`
(one method).
Untouched, declared: `src/tools/*` (incl. frozen seam `_bounds.ts`/`_rg.ts`), `src/db/minima_db.ts`,
`package.json`/lockfile, `tests/__snapshots__/tool-schemas.test.ts.snap` (byte-identical — we
change **no tool JSON schema**, not even a description).

## 4. Flag

`MINIMA_TUI_STEER` — default **ON**, opt-out `MINIMA_TUI_STEER=0`. Wiring in
`src/minima/config.ts`, mirroring the bigPlan/memoryLedger shape: add `steer: boolean` to
`HarnessConfig` (documented field near `memoryLedger`, `config.ts:126-130`), default `steer: true`
in `harnessConfig()` (~`:195`), and `cfg.steer = process.env.MINIMA_TUI_STEER !== "0";` in
`configFromEnv()` beside `:232-233`. Gates: ALL interceptor blocking (checked at hook call time)
and the ladder's effectful-rung retention (`runtime.ts` guard above). Flag off = byte-for-byte
current behavior. Abort plumbing is not gated (inert without a caller). Terminology guard: no
"ground truth" / spaced-plan phrasing anywhere (`bun run check` enforces).

## 5. Migration

**None.** No schema change, no new tables, no existing table touched; schema stays at version 18.
(If review ever forces one, follow the repo rules: ONE idempotent batch appended at the END of
`MIGRATIONS` in `src/db/minima_db.ts`, no hardcoded version indices, replay-safe statements,
declared table touch-list — but this plan requires none.)

## 6. Acceptance criteria (each gate-backed, red→green)

| # | Criterion | Verify (from `packages/tui`) | Pre-impl red mode |
|---|---|---|---|
| AC1 | `bash("grep foo src/")` is blocked: tool result `is_error`, content starts `bash steer:`, names the `grep` tool; proven hook-level (real `Agent` + faux provider) | `bun test tests/steer-bash.test.ts -t "blocks"` | missing-module (weak, declared) |
| AC2 | Negative matrix all execute untouched: `make test`-style, pipelines, compounds, `git grep`, multi-file `cat`, `sed` without `-i`, `find -delete`, `tail -f`, heredoc, env-prefix, script-arg `grep` | `bun test tests/steer-bash.test.ts -t "pass-through"` | missing-module (weak) |
| AC3 | `steer:false` config → the same `grep foo src/` bash call executes (flag gates all blocking) | `bun test tests/steer-bash.test.ts -t "flag"` | missing-module (weak) |
| AC4 | **Behavioral red.** An effectful failed rung (toolUse turn → toolResult → error turn) escalates WITHOUT erasing context: after recovery, `agent.agentState.messages` still contains the rung-1 toolResult; a clean hard-fail rung still rolls back. Imports ONLY existing surfaces (`MinimaAgent`, faux provider, mock router à la `tests/ladder.test.ts:43-128`) — under the Wave-2 red-proof protocol this file runs against `origin/feat/boosting` and **fails on the retention assertion** (rollback at `runtime.ts:787` erases the toolResult), not on a missing module | `bun test tests/ladder-replay.test.ts` | **behavioral** |
| AC5 | `agent.abortToolCall(slowId)` aborts one call of a parallel batch: slow tool returns its aborted error result, sibling completes normally, run continues; run-level `abort()` unchanged | `bun test tests/tool-abort-scope.test.ts` | `abortToolCall` undefined on existing `Agent` |
| All | Independent gates green | `bun test` · `bun run check` · `bun run lint` | — |

## 7. Test plan (hermetic — faux provider, no network, no spend)

- `tests/steer-bash.test.ts` — (a) pure `bashSteerDecision` unit matrix: every blocking row of §2a
  AND every pass-through example (the full negative matrix is a table-driven loop); (b) hook-level:
  `Agent` + `registerFauxProvider` + the REAL `bashTool` (pattern: `tests/hooks.test.ts`), scripted
  toolUse turns — blocked call yields `tool_execution_end` `isError:true` with the `bash steer:`
  prefix and bash never spawns; `bash("echo untouched")` runs to `[exit 0]`; (c) flag: same agent,
  `cfg.steer=false` → pass-through; `configFromEnv` respects `MINIMA_TUI_STEER=0`/unset.
- `tests/ladder-replay.test.ts` — runtime choke-point behavior (AC4), plus: `text_only` judge-fail
  rung still rolls back (guards ladder UX), and rollback target is the rung's own start after a
  retained rung. Existing-imports-only (this is the strong red file).
- `tests/tool-abort-scope.test.ts` — pure classifier unit tests for `replay_guard`
  (clean/text_only/effectful shapes incl. empty-text error assistants) may live here or in
  `ladder-replay`'s sibling describe **only if** imported lazily; keep `ladder-replay` free of new
  imports. Abort: two-tool parallel batch (one blocks on signal, one instant), registry
  add/remove lifecycle, `abortToolCall` on unknown id returns false, Esc-path regression.

## 8. Manual-test scenarios

- **AC1/AC2/AC3**: `bun run src/cli/main.ts` in a scratch repo. Prompt: `Using the bash tool and
  nothing else, run exactly: grep TODO src/`. Expect: a red tool result starting `bash steer:`
  naming the grep tool, then the model re-issuing via native grep. Then prompt `Run the test suite
  with bash: bun test tests/steer-bash.test.ts` — expect it to execute unblocked. Re-launch with
  `MINIMA_TUI_STEER=0` and repeat prompt 1 — expect bash to execute the grep. Verify: transcript
  tool cells.
- **AC4**: with routing live and bigPlan on, give a task whose plan step verify is `false` (a red
  check) after a real bash side effect (`touch p2-probe.txt`). After the ladder escalates, ask:
  `Without running any tool, what commands did you already execute this session?` — expect the
  rung-2 model to name the touch (context retained). Under `MINIMA_TUI_STEER=0` it cannot.
  Cross-check both rungs in the DB (`decisions` rows, `parent_rec_id` link).
- **AC5**: no user-facing surface by design (placeholder). Regression-check run-level abort:
  prompt `run: sleep 30 with bash`, press Esc — expect `bash: aborted` with partial output and a
  clean next prompt.

## 9. Integration notes (declared regions — P4 also edits the loop)

- `src/agent/loop.ts`: ONLY `runOneTool` (`:442-461`). P4's projection work
  (`prepareMessages`/`transformContext`, `:351-357`) is disjoint.
- `src/agent/agent.ts`: additive method after `abort()` (`:204-214`); no change to hook
  composition (`:244-274`) or `buildConfig` (`:276-295`).
- `src/agent/state.ts`: one additive field beside `pendingToolCalls` (`:28`).
- `src/minima/runtime.ts`: the rollback statement only (`:786-787`) + one import. The attempt
  loop, feedback, and gates are untouched.
- `src/cli/main.ts` `:717-723` and `src/minima/spawn.ts` `:167-196`: one registration line each.
- `src/minima/config.ts`: additive field + one `configFromEnv` line — all four Wave-2 features
  touch this file; merges are textual.
- Hook order contract: bash-steer registers FIRST (before TUI permission, checkpoint, done-gate);
  first block wins — document in the registration comment for the P4 merge.
- PR-train order (preflight §6): P1 → **P2** → P4 → P3; P2 carries no migration and no snapshot
  change, so it rebases trivially.
