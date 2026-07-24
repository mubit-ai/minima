# P4 — Checkpoint/rewind: implementation plan

> Wave 2 feature plan (roadmap §E.P4). Branch `feat/boost-p4-rewind`, worktree
> `minima-boost-p4-rewind`, forked from `feat/boosting` @ `49ef395`. All paths below are
> relative to `packages/tui/` unless prefixed with `docs/`. Policy: zero new deps, no code
> copied from oh-my-pi (`docs/boosting/research/oh-my-pi-analysis.md` is reference only).

## 1. Scope + non-goals

**Scope.** A model-callable `checkpoint` / `rewind(report)` tool pair. The model calls
`checkpoint` before an exploration burst; a later `rewind(report)` prunes everything between
the checkpoint anchor and the rewind call from the **projected context** (the in-memory
`AgentState.messages` array that `prepareMessages` in `src/agent/loop.ts:351` serializes to
the provider each turn), keeping only the model-authored report. The DB transcript
(`events` + `tool_calls`, written by `src/db/sink.ts`) keeps every pruned message — the
rewind manipulates the projection only, never deletes or mutates rows. A `context_rewind`
event is appended to the spine (recommended-yes adopted): it is both the audit record of
what the model stopped seeing and the replay marker that makes the prune survive restart
(`rehydrateRun` applies it, mirroring the existing `rewind` marker at
`src/db/rehydrate.ts:130-136`).

**How the projection is represented / where the prune is enforced.** The projection is
`state.messages: Message[]` (`src/agent/state.ts:25`); each turn the loop derives the wire
context via `prepareMessages` → `convertToLlm`. Precedent for turn-boundary projection
mutation: compaction (`src/tui/compact.ts`, applied via `agent.agentState.messages = ...`)
and replay truncation (`src/session/rewind.ts`). P4 enforces the prune **in the loop, at the
turn boundary**: the rewind tool validates and stages `state.pendingContextRewind`; the loop
applies it after the turn's toolResults are appended and before `yield turnEnd` — harness
code, never prompt text. Gates, `routing_decisions`, meter rows are untouched (feedback
truth: spend and outcomes happened).

**Naming collision (critical).** An unrelated user-facing system already owns
`src/session/checkpoint.ts` (git-shadow worktree snapshots, /ckpt), `src/session/rewind.ts` +
the `rewind` event type (B4/B5 prompt rewind — `rehydrateRun` truncates on it), and tests
`tests/checkpoint.test.ts` / `tests/rewind.test.ts` / `tests/rewind_picker.test.ts`. P4 must
NOT reuse the `rewind` event type (it would corrupt B4 replay) and must not touch those
files. New event type: `context_rewind`. New files use distinct names (below).

**Non-goals.** No sub-agent registration (`src/minima/spawn.ts` untouched); no UI affordance
(no picker/panel); no auto-checkpointing; no interaction with git-shadow snapshots or
/undo //rewind; no system-prompt changes (tool descriptions carry usage guidance); no spill
integration (P1's); no new table, no new deps; no changes to `_bounds.ts`/`_rg.ts`
signatures (frozen seam — `boundText` is consumed as-is).

## 2. Write-set (exhaustive)

| File | Change |
|---|---|
| `src/agent/context_prune.ts` | NEW — pure helpers: `CONTEXT_REWIND_EVENT = "context_rewind"`, `findRewindAnchor(messages)`, `truncateAfterAnchor(messages, anchorToolCallId)`, `applyPendingContextRewind(state)`, `parseContextRewindMarker(payload)`, `PendingContextRewind` type. Imports only `../ai/types.ts` + `./state.ts` types (no cycles). |
| `src/tools/checkpoint_rewind.ts` | NEW — `checkpointTool(deps)`, `rewindTool(deps)`; `deps = { getState: () => AgentState; db: MinimaDb \| null; getRunId: () => string \| null }`. |
| `src/agent/state.ts` | MOD — one field on `AgentState`: `pendingContextRewind: PendingContextRewind \| null = null` (field block, lines 20–36). |
| `src/agent/loop.ts` | MOD — one import + one ~4-line block between the toolResult append loop (ends line 159) and `yield turnEnd` (line 161). Nothing else. |
| `src/db/rehydrate.ts` | MOD — one `else if (ev.type === CONTEXT_REWIND_EVENT)` branch directly after the existing `rewind` branch (lines 130–136). |
| `src/minima/config.ts` | MOD — `contextRewind: boolean` on `HarnessConfig` + default `true` + env parse next to `memoryLedger` (line 233 region). |
| `src/cli/main.ts` | MOD — gated registration next to `questionTool` push (line ~1013). |
| `tests/context-prune.test.ts` | NEW (hermetic, pure). |
| `tests/rewind-tool.test.ts` | NEW (hermetic, faux provider). |
| `tests/rewind-rehydrate.test.ts` | NEW (hermetic, `new MinimaDb(":memory:")`; imports EXISTING modules only — the behavioral red). |
| `tests/tool-schemas.test.ts` | MOD — additionally pin `checkpointTool`/`rewindTool` schemas (constructed with inert deps: `{ getState: () => new AgentState(), db: null, getRunId: () => null }`). |
| `tests/__snapshots__/tool-schemas.test.ts.snap` | MOD — regenerated; additive-only (two new entries; existing entries byte-identical). |

Not modified: `src/tools/builtin.ts` (the tools need runtime deps, so they follow the
`taskTool`/`questionTool` post-construction registration precedent, `src/cli/main.ts:929/1013`),
`src/db/minima_db.ts`, `package.json`, seam files.

## 3. Feature flag

- **Name:** `MINIMA_TUI_REWIND` (per `docs/boosting/wave2-preflight.md`). Config field
  `contextRewind` (avoids clashing with B5 rewind vocabulary).
- **Default:** ON. Opt-out: `cfg.contextRewind = process.env.MINIMA_TUI_REWIND !== "0";` in
  `configFromEnv` (`src/minima/config.ts`, beside `memoryLedger` line 233), doc comment
  mirroring the memory/bigPlan shape.
- **Gates exactly:** tool registration in `src/cli/main.ts` — when off, the two tools are
  never pushed onto `agent.agentState.tools`, so a model call yields the loop's standard
  `Unknown tool: checkpoint` error result. Nothing else is gated: `rehydrateRun` honors
  `context_rewind` markers **regardless of flag** (a marker is data about what the model
  saw; ignoring it would silently resurrect pruned spam on resume — auditability over
  configuration).
- **Schema-snapshot handling for both states (decided):** precedent (`task`, `question`) is
  conditional tools absent from the pin — a gap. P4 closes it: `tests/tool-schemas.test.ts`
  constructs the two tools **directly with inert deps**, independent of registration/flag,
  so the wire surface is pinned identically in both flag states.

## 4. Migration

**None, because** no new queryable state exists. Checkpoint anchors are *derived* from the
transcript (the `checkpoint` tool's own result is persisted as a normal `tool` event by
DbSink and round-trips `tool_call_id`/`tool_name` through `rehydrateRun`), and the rewind
marker is one row in the **existing** `events` table — `events.type` is unconstrained TEXT
(`minima_db.ts:81-89`), appended via the existing `appendEvent` API (`minima_db.ts:1082`).
Older code replaying a newer DB ignores unknown event types (rehydrate's if-chain falls
through) — forward-safe. Existing tables touched at runtime, INSERT-only: `events`
(type `context_rewind`, payload `{ anchor_tool_call_id, report, report_chars }`). Schema
stays at version 18; integration position 20 goes unused, and P4 drops out of the
migration-commutativity check entirely (risk-register item 1).

## 5. Design detail (for the implementer)

**Tool schemas** (via `objectSchema`, `src/tools/schema.ts`):
- `checkpoint` — params `{ label?: string (default "") }`, required `[]`,
  `executionMode: "sequential"`. Execute: returns
  `content: [text("Checkpoint set" + label)]`, `details: { checkpoint: true, label }`. No
  state/db writes — its own persisted tool event IS the durable anchor record.
- `rewind` — params `{ report: string }`, required `["report"]`,
  `executionMode: "sequential"`. Execute: (1) trim-empty report → error result; (2)
  `findRewindAnchor(getState().messages)` → null → error result (guard rails below); (3)
  bound the echo: `boundText(report, { maxChars: 16_000, keep: "headTail" })`; (4) append
  the `context_rewind` event (fail-open try/catch, mirroring `makeCheckpointHook`'s
  log-and-swallow) with the **bounded** report; (5) stage
  `getState().pendingContextRewind = { anchorToolCallId, rewindToolCallId: toolCallId }`;
  (6) return `content: [text("Context rewound to checkpoint. Pruned tool traffic is
  preserved in the session ledger.\n\nReport:\n" + bounded.body)]`.

**Anchor + consume rule** (`findRewindAnchor`): let R = index of the latest non-error
toolResult with `tool_name === "rewind"` (−1 if none); the anchor is the latest non-error
toolResult with `tool_name === "checkpoint"` at an index > R; return its `tool_call_id` or
null. Consequence: **any successful rewind consumes all prior checkpoints** — the next
rewind requires a fresh checkpoint.

**Turn-boundary apply** (`applyPendingContextRewind(state)`, called from `loop.ts` between
lines 159 and 161): if `state.pendingContextRewind` is null return; else locate anchorIdx
(toolResult with the staged `tool_call_id`) and tailIdx (assistant message whose `toolCalls`
include `rewindToolCallId`); set
`state.messages = [...messages.slice(0, anchorIdx + 1), ...messages.slice(tailIdx)]`;
always clear the field. Both slice edges are well-formed pairs (anchor result kept with its
assistant; rewind assistant kept with its just-appended results), so no orphan repair is
needed live; `pruneOrphanToolMessages` still runs on the replay path as today.

**Replay** (`rehydrate.ts` new branch): `parseContextRewindMarker(payload)` → valid →
`messages = truncateAfterAnchor(messages, marker.anchor_tool_call_id) ?? messages` (anchor
missing ⇒ no-op, conservative). The marker is appended at execute time (before the sink's
turn_end flush), so replay order is: …exploration events…, `context_rewind`, assistant
(rewind call), tool (rewind result) — truncate-then-append reproduces the live projection
exactly. Crash between execute and turn_end loses the rewind turn's messages but keeps the
marker carrying the report — acceptable; note it in the module docstring.

**Guard rails (each specified + tested):**
1. **Rewind, no checkpoint ever** → error result `no active checkpoint — call checkpoint before rewind`; no event, no prune.
2. **checkpoint + rewind batched in one assistant turn** → anchor toolResult not yet appended (loop pushes results after the batch) → same error path, message notes the checkpoint has not committed yet.
3. **Nested checkpoints** → latest unconsumed anchor wins; rewind consumes all earlier ones (rule above).
4. **Rewind after compaction** (`compactMessages` replaced the anchor region with a summary) → `findRewindAnchor` returns null → error result naming compaction as the likely cause; no prune, no event.
5. **Huge report** → echo and event payload bounded to 16 000 chars head+tail via the frozen `boundText` seam (call site only). The full text still exists once in the projection inside the assistant's own tool_use arguments — model-authored content is never rewritten.
6. **Checkpoint/rewind loops** → structurally bounded by the consume rule: every prune requires a fresh checkpoint, and can only remove material the model itself produced after that checkpoint; each cycle costs a normal billed turn recorded in `routing_decisions`. No additional counter needed.
7. **Flag off** → tools unregistered; `Unknown tool` error from the loop (dispatcher-level).

## 6. Acceptance criteria (gate-backed, red→green)

Run all commands from `packages/tui`.

- **AC1 (core contract):** after checkpoint → ≥2 exploration tool calls → rewind(report),
  `agent.agentState.messages` contains the report and the checkpoint anchor but **none** of
  the exploration toolResults, while `db.getRunEvents(runId)` / `tool_calls` retain all of
  them plus one `context_rewind` row. Verify: `bun test tests/rewind-tool.test.ts -t "prunes exploration"`.
  Red on base: missing module (weak red — acceptable, AC2 is the strong one).
- **AC2 (BEHAVIORAL red against existing surfaces):** `rehydrateRun` applies a
  `context_rewind` marker. `tests/rewind-rehydrate.test.ts` imports ONLY existing modules
  (`src/db/minima_db.ts`, `src/db/rehydrate.ts`), seeds `new MinimaDb(":memory:")` via
  `appendEvent` with user/assistant/tool events, a `context_rewind` row, then the rewind
  turn's assistant/tool events, and asserts the replayed `messages` exclude the pruned tool
  results while `getRunEvents` returns every row. On base this **fails behaviorally**
  (unknown event type is ignored; pruned results reappear). Verify:
  `bun test tests/rewind-rehydrate.test.ts -t "context_rewind marker prunes replayed projection"`.
- **AC3 (guard rails):** cases 1–5 above each produce the specified error/bounding with no
  prune and no marker. Verify: `bun test tests/rewind-tool.test.ts -t "guard"`.
- **AC4 (flag):** `MINIMA_TUI_REWIND=0` ⇒ `configFromEnv().contextRewind === false` and the
  registration helper leaves the roster unchanged. Verify: `bun test tests/rewind-tool.test.ts -t "flag"`.
- **AC5 (schema pin, additive-only):** `bun test tests/tool-schemas.test.ts` green after a
  deliberate `bun test tests/tool-schemas.test.ts -u`; `git diff
  tests/__snapshots__/tool-schemas.test.ts.snap` shows only added entries.
- **Gates:** `bun test` · `bun run check` (tsc + terminology — new code/tests must not
  introduce the banned legacy phrasings) · `bun run lint`, all green independently.

## 7. Test plan (hermetic: no network, no spend; faux provider per `tests/agent.test.ts`)

- `tests/context-prune.test.ts` — pure: `findRewindAnchor` (none / latest / consumed by a
  prior rewind result / anchor erased by a compaction-style summary rewrite);
  `truncateAfterAnchor` (found / missing→null); `applyPendingContextRewind` well-formedness
  (no orphan tool_use/toolResult pairs on either slice edge; field cleared);
  `parseContextRewindMarker` (valid / malformed payloads).
- `tests/rewind-tool.test.ts` — loop-level with `registerFauxProvider` + scripted
  `AssistantMessage` tool-call turns and an in-memory `MinimaDb` + `attachDbSink`:
  AC1 end-to-end; guard cases 1–5 (including checkpoint+rewind same-turn batch and the
  16k-bounded echo with omission marker); consume rule (second rewind without a fresh
  checkpoint errors); flag registration on/off; `context_rewind` event payload shape.
- `tests/rewind-rehydrate.test.ts` — AC2 (existing-imports-only, the red-proof test);
  coexistence: a B4 `rewind` (keep_prompts) marker and a `context_rewind` marker in one run
  replay correctly; anchor-missing marker is a no-op.

## 8. Manual-test scenarios (session DB: `~/.minima-harness/minima.db`, or set `MINIMA_DB_PATH=/tmp/p4.db` first; run `bun run src/cli/main.ts` in `packages/tui`)

- **AC1:** prompt: `Call the checkpoint tool. Then use the read tool on package.json and on README.md. Then call rewind with report: "REPORT-MARKER: bun monorepo, tui package holds the harness."` Expect: two read results render, then the rewind result echoing the report. Then prompt: `Quote verbatim any tool output from before your rewind.` Expect: it can only cite the report/checkpoint, not file contents. Verify ledger: `sqlite3 $MINIMA_DB_PATH "SELECT type, substr(payload,1,60) FROM events WHERE run_id=(SELECT run_id FROM runs ORDER BY created DESC LIMIT 1) ORDER BY ts"` → both `tool` rows for read AND one `context_rewind` row present.
- **AC2:** after the AC1 session, quit, relaunch, `/resume` the run, prompt the same quote request — same result (prune survived restart); the sqlite query above still shows every row.
- **AC3:** fresh session, prompt: `Call rewind now with report "x".` Expect a visible tool error naming the missing checkpoint; the events table has no `context_rewind` row.
- **AC4:** `MINIMA_TUI_REWIND=0 bun run src/cli/main.ts`, prompt: `Call the checkpoint tool.` Expect the `Unknown tool: checkpoint` error result in the transcript.
- **AC5:** `bun test tests/tool-schemas.test.ts` green; `git diff tests/__snapshots__/tool-schemas.test.ts.snap` shows additions only.

## 9. Integration notes (for the PR train: P1 → P2 → **P4** → P3)

- **`src/agent/loop.ts` — exact touch region:** one import line, plus a single block
  inserted between the toolResult append loop (currently ends at line 159 `}`) and
  `yield turnEnd(` (line 161). P2 edits the beforeToolCall/interceptor and recovery-ladder
  surfaces — different regions; the merge is mechanical (keep both hunks).
- **`src/agent/state.ts`:** one added field in the `AgentState` field block (lines 20–36).
- **`src/db/rehydrate.ts`:** one added branch immediately after the `rewind` branch (lines
  130–136); no change to existing branches or `pruneOrphanToolMessages`.
- **MIGRATIONS tail (`src/db/minima_db.ts`):** untouched — P4 contributes no batch;
  position 20 is free for reassignment and P4 is exempt from the commutativity audit.
- **Schema snapshot:** regenerate (never hand-merge) at integration via
  `bun test tests/tool-schemas.test.ts -u`; confirm additive-only against the union of
  P1/P2/P4 changes.
- **`src/cli/main.ts`:** registration block beside `questionTool` (line ~1013) — no other
  feature declares that region.
- **Red-proof protocol:** scratch worktree at `origin/feat/boosting`, copy only
  `tests/rewind-rehydrate.test.ts`, `bun install`, run it — expect a behavioral assertion
  failure (pruned results present), not a missing-module error.
