# W4.2 — TTSR: stream tripwire rules (abort → inject → retry) — MUB-204 — Wave 4, merges 3rd

> Plan pass against feat/boosting @ ba6eb32. Harness: `packages/tui`. Line numbers are anchors — re-verify at build time.
> **R2 RESULT (binding): W4.1/bgjobs touches `src/agent/loop.ts` in ZERO hunks. TTSR owns the loop stream region outright — no partition negotiation.**
> **Layering (verified): `src/agent/` imports nothing from `src/minima/`; `src/minima/` already imports `agent/state.ts` interfaces. → TTSR interfaces in `state.ts`, impl in `minima/ttsr.ts`, `loop.ts` imports only `./state.ts`.**

## 1. Scope + non-goals

**Scope.** Dormant, harness-defined regex rules matched against the LIVE assistant token stream inside `agentLoop`. On a match mid-stream: abort the provider request, discard the un-committed partial, inject the rule's enforcement reminder as a harness-authored `user` message, retry the same turn with that reminder in context. Zero context tax and zero regex work until the flag is armed AND a rule fires. Behind `MINIMA_TUI_TTSR` (default OFF, opt-in via `optInFlag`, umbrella-covered). Flag-off / unarmed path byte-identical (matcher never installed; a single `if (tripwire)` guard gates all regex work).

**Non-goals.** No changes to the runtime recovery ladder or `replay_guard.ts` (the "never replay an effectful rung" invariant is preserved by NON-INTERFERENCE, not modification) · no user-facing rule configuration (rules are a code-level const table — enforcement, not prompt text, not env-injectable regex) · no new tool/migration/deps · no sub-agent-specific behavior (children inherit TTSR through the shared `MinimaAgent` constructor when the flag is on) · TUI dim-rendering + live-buffer cleanup are OPTIONAL polish (deferrable, not gate-backed).

## 2. Full write-set

**Core (required, gate-backed):**

| File | Layer | Change |
|---|---|---|
| `src/agent/state.ts` | agent | Add TTSR interfaces `TtsrHit`/`TtsrTurnMatcher`/`TtsrController` (HERE so `loop.ts` depends only on its own layer). Add `ttsr?: TtsrController\|null` to `AgentLoopConfig` (mirroring `streamIdleTimeoutMs`). Add `ttsrRetries = 0` telemetry field to `AgentState`. |
| `src/agent/loop.ts` | agent | Two hunks (§5): import TTSR types from `./state.ts`; wrap the stream-consumption region (94-134) in a per-turn retry loop with the match hook + abort/inject/retry branch. Dispatch region (142-201) content-identical, only line-shifted. |
| `src/agent/agent.ts` | agent | Add `ttsr?: TtsrController\|null` to `AgentOptions`, store + forward in `buildConfig` — mirroring `streamIdleTimeoutMs`. |
| `src/minima/ttsr.ts` | minima | NEW. `TtsrRule` type; `DEFAULT_TTSR_RULES` const table; `compileTtsr(rules)` → concrete `TtsrController` (`arm()`→per-turn matcher with per-rule counters; `test()`→sliding-window match; `onFired()`→cap bookkeeping; `reminder()`→harness `user` Message); `TTSR_REMINDER_PREFIX`; `isTtsrReminder(text)`. Imports interfaces from `../agent/state.ts`. |
| `src/minima/config.ts` | minima | `ttsr: boolean` on `HarnessConfig` (doc-comment by `observer`), default `false`, `cfg.ttsr = optInFlag(process.env.MINIMA_TUI_TTSR, cfg.experimental);` in the opt-in cluster. Optional cap override `MINIMA_TUI_TTSR_CAP`. |
| `src/minima/runtime.ts` | minima | ONE hunk in the `MinimaAgent` constructor `super({...})` call (~270-274): `ttsr: agentOpts.ttsr ?? (config.ttsr ? compileTtsr(DEFAULT_TTSR_RULES) : null),` — mirrors `streamIdleTimeoutMs`. Far from the recovery ladder (486-830), which is untouched. |
| `src/tui/compact.ts` | tui | Preserve TTSR reminders verbatim through compaction (§5). **Collision with compact2** — see §Collisions. |
| `tests/ttsr.test.ts` | test | NEW — the §7 ACs (hermetic, scripted faux stream). |
| `tests/ttsr-config.test.ts` | test | NEW — flag default + byte-identity + config plumbing (behavioral reds). |
| `tests/config_env.test.ts` | test | MOD — one `MINIMA_TUI_TTSR` env triplet. |

**Optional polish (deferrable, NOT gate-backed):** `src/minima/stop_gate.ts` (`isHarnessSteerText` recognizes `TTSR_REMINDER_PREFIX` → dim system line not a "▸ you" bubble) · `src/tui/app.tsx` (clear the live buffer on `message_end(null)`). Both cosmetic; reminder is delivered/persisted correctly without them.

**NOT modified:** `replay_guard.ts`, the runtime recovery-ladder/rollback/accounting code, `faux.ts`, `stream.ts`, `sink.ts`, `events.ts`, `package.json`, `spawn.ts`, DB migrations.

## 3. Flag: `MINIMA_TUI_TTSR`, default OFF (opt-in), byte-identity

`HarnessConfig.ttsr`, resolved via `optInFlag(process.env.MINIMA_TUI_TTSR, cfg.experimental)` (same shape as `classify`/`observer`), NOT the `!== "0"` default-on shape. **Default-OFF justification (the owner decision #3):** TTSR aborts real turns mid-generation; the mature default-ON flags are field-proven, a fresh regex table's precision is not. A too-broad rule aborts legitimate turns + burns a retry's tokens on every affected stream (the cap bounds the loop, not the false-positive disruption). Ship opt-in (umbrella-covered so `MINIMA_TUI_EXPERIMENTAL=1` exercises it), validate the rule table in the field, promote to default-ON in a follow-up. **This deviates from the arc's "all features default ON" convention — surfaced to the owner.** Byte-identity: flag off → `ttsr:null` → the `for(;;)` retry loop runs once, `attemptSignal===streamSignal`, the per-delta `if (tripwire)` branch skipped (zero regex), `assistant = await s.result()`, break — event order / committed messages / usage / abort behavior identical (verified vs `agent.test.ts:73-87` + the user-abort contract).

## 4. Match-location (problem 1)

Hook runs inside the existing `for await` consume loop, right after `partialText += delta` — reads that same growing buffer, no second accumulator. **Bounded sliding window** (not full-buffer): each delta, test `partialText.slice(-TTSR_WINDOW)` (default `TTSR_WINDOW=1024`) → O(n·WINDOW) linear per turn, not O(n²). **Straddle-safety proved by construction:** the only newly-completable matches end within the just-arrived delta, so start ≤ maxMatchLen before the buffer end; with `TTSR_WINDOW ≥ maxMatchLen + maxDeltaLen`, `slice(-TTSR_WINDOW)` always contains any match ending at the current position, across any number of delta boundaries. Authoring contract: **rules must match within `TTSR_WINDOW` (bounded patterns; no unbounded `.*` spanning the whole buffer).** First hit aborts immediately. Rule table `DEFAULT_TTSR_RULES: TtsrRule[]` = code-level const (`{id, pattern:RegExp, reminder:string, retryCap?}`), versioned with the harness; the flag gates the whole table. Per-rule `retryCap` defaults to 1, globally overridable via `MINIMA_TUI_TTSR_CAP`. No env/user rule injection.

## 5. Abort → inject → retry + replay-guard safety + exact rollback (problem 2)

**loop.ts hunks (declared for audit — stream region only, dispatch untouched):** Hunk 1 = imports (add `import type {TtsrController,TtsrTurnMatcher,TtsrHit} from "./state.ts";`). Hunk 2 = current lines 94-134 replaced with a per-attempt retry loop; does NOT touch turn setup (74-93: prepareMessages/ctx/options/watchdog/streamSignal byte-identical), the post-stream error check (135-140), or dispatch (142-201).

Structure (semantics):
```
const tripwire = config.ttsr?.arm() ?? null;   // null → not installed
let assistant = null, aborted = false;
for (;;) {
  const trap = tripwire ? new AbortController() : null;
  const attemptSignal = trap ? (streamSignal ? AbortSignal.any([streamSignal, trap.signal]) : trap.signal) : streamSignal;
  const s = streamFn(state.model, ctx, { options, signal: attemptSignal });
  yield messageStart(null);
  let partialText = "", hit = null;
  const source = watchdog ? withIdleTimeout(s, idleMs, () => watchdog.abort()) : s;
  try {
    for await (const ev of raceAbort(source, config.signal ?? undefined)) {
      if (ev.type === "text_delta") { partialText += ev.delta ?? ""; if (tripwire) hit = tripwire.test(partialText); }
      yield messageUpdate(ev);
      if (hit) { trap?.abort(); break; }
    }
  } catch (err) { if (config.signal?.aborted) aborted = true; else throw err; }
  if (aborted) { /* 113-130 verbatim user-abort stub → push, messageEnd, break */ }
  if (hit) {                                   // NOT a user abort — no marker, no stub
    yield messageEnd(null);                     // discard the partial
    tripwire.onFired(hit); state.ttsrRetries += 1;
    const reminder = tripwire.reminder(hit);
    state.messages.push(reminder); yield messageStart(reminder); yield messageEnd(reminder);
    ctx.messages = await prepareMessages(state, config);
    continue;                                   // retry the same turn
  }
  assistant = await s.result(); break;
}
if (aborted) break;                             // preserves old line-129 turn-loop break
state.streamingMessage = assistant; state.messages.push(assistant); yield messageEnd(assistant);
```

**Exact rollback (the requirement — NOT the `[aborted by user]` path):** the tripped partial is NEVER pushed to `state.messages` and `s.result()` is NEVER called — nothing to erase, "rollback" = not committing. Distinct from the user-abort path (which commits a `[aborted by user]` stub); TTSR takes the `if (hit)` branch, no marker. `yield messageEnd(null)` = discard, verified safe across every subscriber (`DbSink` sink.ts:122 `if (!m) break;` → not persisted; `child_tree.tsx:30` guards `ev.message && isAssistant`; observer uses `turn_end` with `?.`). History after fire+complete: `… user → [TTSR reminder (user)] → assistant(clean)` — well-formed, no dangling user, no partial-tool-call 400 (partial is text-only; dispatch at 142+ never reached on the aborted attempt).

**Replay-guard safety (do not weaken P2):** TTSR operates strictly BEFORE tool dispatch (tools dispatched only after `assistant = await s.result()`); a trip `continue`s before that, so no `toolResult` can exist in a discarded window → the aborted rung is non-`effectful` under `classifyRungOutput` (replay_guard.ts:22-36 returns `"effectful"` iff a `toolResult` is present) → retrying is legal under P2. TTSR does not call/modify/bypass the runtime rollback at `runtime.ts:809-811` (untouched). TTSR's retry is inner-turn; the recovery ladder is outer re-route; they compose without interaction. AC6 proves both (unit: `classifyRungOutput` unchanged; behavioral: tripwire text followed by a tool-call block → tool never dispatched on the aborted attempt, executes once on the retry).

## 6. Accounting decision (problem 3 — OWNER DECISION #2)

**Touchpoint:** `MinimaRuntime.usageSince(runStartIdx)` (runtime.ts:996-1013) sums `AssistantMessage.usage` over committed `state.messages[runStartIdx..]`, consumed at `budget.reconcile` (686), `meter.record` (708-722), `persistDecision` (725-727). Usage is only booked for assistant messages committed to `state.messages`.
- **(a) book the aborted partial too** — honest total, but on a real mid-stream abort the provider's usage-bearing `done` event never arrives (stream.ts:35-41 sets `resultMsg` only on done/error), so there is NO authoritative count → booking requires fabricating an estimate (chars/4) into meter/persistDecision/budget, polluting the honest-label/observed-cost substrate the server learns from.
- **(b) discard the aborted partial's usage** — only the successful retry books.

**Recommendation: (b).** Natural zero-touch (the uncommitted partial is never seen by `usageSince` → accounting path byte-identical to today); no fabricated numbers enter the authoritative substrate; TTSR fires rarely so the under-count is small + bounded (≤ one partial per fired rule per turn, cap-bounded); double-booking impossible (the retry commits exactly one assistant). Tradeoff surfaced: (b) under-books the aborted partial's real tokens; (a) is "honest total" only via estimation. AC4 asserts (b).

## 7. Acceptance criteria (red→green, from `packages/tui`)

Scripted `streamFn` (the `stream-idle-timeout.test.ts:40-61` pattern), rules via `AgentOptions.ttsr = compileTtsr([...])`. Hermetic.
1. **AC1 mid-stream match aborts + injects + retry completes clean.** `bun test tests/ttsr.test.ts -t "AC1"` — attempt-1 streams matching deltas, attempt-2 clean; assert attempt-1 iterator `return()` called, a `user` reminder (`TTSR_REMINDER_PREFIX`) precedes the final assistant, final text is the clean retry, `streamFn` call count===2. RED today (agentLoop ignores TTSR → completes on attempt 1, no reminder, count 1).
2. **AC2 non-matching byte-identical.** `-t "AC2"` — rules armed, stream never matches → `streamFn` called once, zero reminders, assistant===full text, no `message_end(null)`, event-type sequence equals the flag-off run (differential).
3. **AC3 flag default + plumbing + off byte-identity.** `bun test tests/ttsr-config.test.ts -t "AC3"` — `configFromEnv().ttsr===false` (RED today: undefined); `=1`→true; `EXPERIMENTAL=1`→true; explicit `=0` under experimental→false; `ttsr:null` produces the identical committed-message set.
4. **AC4 no double-booking.** `-t "AC4"` — attempt-1 partial carries usage, attempt-2 completes with distinct usage; assert `state.messages` holds exactly one assistant and its usage equals attempt-2 only (discarded partial's tokens absent).
5. **AC5 per-rule cap + termination.** `-t "AC5"` — rule matches every attempt, `retryCap:1` → `streamFn` count===2, `state.ttsrRetries===1`, turn terminates; `retryCap:2` → count 3. RED today (no cap logic).
6. **AC6 effectful rung never replayed (replay_guard regression).** `-t "AC6"` — (a) `classifyRungOutput` unit unchanged; (b) attempt-1 streams tripwire text then a tool-call block → tool `execute` never called on attempt-1 (no toolResult appended), runs exactly once after the clean retry.
7. **AC7 reminder survives compaction.** `-t "AC7"` — reminder in the `oldMessages` window (> KEEP_RECENT), run `compactMessages`; assert the reminder text appears verbatim (not 200-char-truncated), positioned as active context.

Full gates: `bun test && bun run check && bun run lint`, plus `MINIMA_TUI_TTSR=0 bun test` and default (unset) `bun test` green.

## 8. Test plan (hermetic)

Scripted faux stream: `faux.ts:160-173` yields one `textDelta` per text block, so a response can be scripted as multiple blocks to force multi-delta straddle; for abort-teardown probe + second-call divergence use a custom `StreamFnLike` (`stream-idle-timeout.test.ts:40-61`) with `next()`/`return()`/`result()`. Controller injected via `AgentOptions.ttsr` — no env/runtime/DB for loop-level ACs. Straddle test splits a trigger across two deltas (rule `/rm -rf \//`, deltas `"rm -rf"`+`" /"`). Config tests use `withEnv`, import `config.ts` only (behavioral reds). No real providers/servers; all aborts are synchronous stream teardown.

## 9. Migration: NONE

Turn-local state (`arm()`'s per-rule counter Map) + one in-memory telemetry counter (`AgentState.ttsrRetries`). Injected reminders persist through the EXISTING `DbSink` user-message path and rehydrate as ordinary user messages — no new table/event/ALTER.

## Collisions

- **`loop.ts`/`state.ts`/`agent.ts`:** exclusively TTSR (R2 grants bgjobs zero loop.ts hunks; bgjobs also declares state.ts/agent.ts untouched). No negotiation.
- **`config.ts`:** one field + default + env-parse line in the opt-in cluster — textual-merge (disjoint lines).
- **`runtime.ts`:** ONE line in the constructor `super({...})` (~270-274), disjoint from compact2's late-bound-field region (~184-225) and the recovery ladder (486-830).
- **`compact.ts` — REAL COLLISION with compact2 (W4.5).** Both edit `compactMessages`. compact2 rewrites the prune/summarize branch to spill `oldMessages` to an artifact; TTSR adds a preserve-verbatim partition (split `oldMessages` into `preserved` where `isTtsrReminder(m.textContent)` vs the rest, return `[summaryMsg, ...preserved, ...recentMessages]`) so reminders aren't demoted to a spill pointer. Orthogonal in intent, overlap textually. **Train order = TTSR (204) before compact2 (207): TTSR's preserve-partition lands first; compact2 rebases and MUST compose its spill branch WITH the preserve partition (keep both, do not overwrite).** Recorded in wave4-preflight collision matrix.
- **stop_gate.ts / app.tsx (optional polish):** one clause / one branch; bgjobs+compact2 declare app.tsx zero-change — low risk.

## Flags / unconfirmed

- Real-provider partial-usage on abort not traced live (out of scope for a hermetic plan); (b) is the natural hermetic behavior and (a) would need estimation regardless.
- compact2 exact line ranges read from its (uncommitted at plan time) doc — collision is on the stable function `compactMessages`; treat as a rebase-time compose.
- `TTSR_WINDOW`/`maxMatchLen` defaults (1024 / rule-authored) are recommendations — confirm all seed rules satisfy `maxMatchLen + maxDeltaLen ≤ TTSR_WINDOW` at build time.
