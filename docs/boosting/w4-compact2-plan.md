# MUB-207 — Compaction v2: artifact-backed, lossless (Wave 4, merges last)

> Plan pass 2026-07-24 against feat/boosting @ ba6eb32 (Wave 3 merged; W3.3 artifact GC in-tree).
> Contract authority for the implementation agent. Line numbers are anchors — re-verify at build time.

## 1. Scope + non-goals

**Scope.** Make compaction lossless when the P1 artifact store is live: before pruning, `compactMessages` serializes the pruned message window to one content-addressed artifact via the already-attached `ArtifactStore`, and the compaction summary message carries the artifact's absolute path. The model recovers any pruned message verbatim through the existing `read` tool (P1's artifact-root allowance, `src/tools/read.ts` ~34–39) with offset/limit paging — no new tool. Both entry points funnel through `compactMessages`: `/compact` (`src/tui/app.tsx`, `case "compact"` ~2884) and auto-compaction (`maybeAutoCompact`, called ~4413; ≥80% threshold logic stays in `src/tui/compact.ts`).

**Non-goals.**
- No change to the compaction trigger (`KEEP_RECENT = 6`, identity guard, 80% threshold), `approxContextTokens`, or `compactReport`.
- v1 spills each pruned message's `textContent` (same basis as today's one-liners + token estimate — `Message.textContent`, `src/ai/types.ts` ~156–161). Non-text blocks (toolCall args, thinking, images) are NOT serialized; the DB transcript remains the full-fidelity record ("state in DB"). Loss boundary stated honestly.
- No resume/rehydrate changes: the compaction summary is a live-projection construct, not persisted; that stays. A compaction artifact from a *previous* run becomes GC-eligible once a new run attaches — accepted (identical to how tool-spill refs age out; DB transcript stays complete).
- No child-agent compaction (only `app.tsx` + `tests/compact.test.ts` call the compaction fns — grep-verified).
- Frozen surfaces untouched: `_artifacts.ts`, `_artifact_gc.ts`, `read.ts` consume-only. No missing signature — no seam-freeze reopen.

## 2. Full write-set

| File | Change |
|---|---|
| `src/tui/compact.ts` | Core: compact2 branch in `compactMessages` (serialize + spill + pointer summary); legacy branch byte-identical. |
| `src/minima/config.ts` | `compact2: boolean` + default `true` in `harnessConfig()` + env parse in `configFromEnv()`. |
| `src/minima/runtime.ts` | **Deviation (flagged):** one late-bound public field on `MinimaAgent`: `artifacts: ToolArtifacts \| null = null` (type-only import). |
| `src/cli/main.ts` | **Deviation (flagged):** one wiring line `agent.artifacts = artifactStore;` beside the existing late-binds (~759 / ~844, before any compaction can fire). |
| `tests/compact2.test.ts` | New hermetic acceptance suite (red first). |
| `tests/config_env.test.ts` | Append the standard flag test (`withEnv`, mirrors the `MINIMA_TUI_ARTIFACTS` test ~209–218). |

**Deviation rationale (orchestrator-accepted).** The `ArtifactStore` instance lives only inside `main.ts`; neither `HarnessApp` props nor `MinimaAgent` reference it, and `compactMessages` reaches state only via its `agent` param. Chosen shape = the established house pattern (late-bound public fields on `MinimaAgent`: `db`/`runId`/`classifier`/`memory`, runtime.ts ~184–225), leaving `app.tsx` with ZERO changes. Alternatives (new HarnessApp prop + compactMessages param; module-level registry) were more churn / off-pattern. `runtime.ts`+`main.ts` are not frozen surfaces but exceed the predicted set → recorded in preflight.

## 3. Flag: name, default, TWO flag-off paths

- `MINIMA_TUI_COMPACT2`, field `compact2`, **default ON**: `cfg.compact2 = process.env.MINIMA_TUI_COMPACT2 !== "0";` in `configFromEnv()` (beside `cfg.artifacts` ~278), `compact2: true` in `harnessConfig()` (beside `artifactGcMb` ~234). Doc comment required. NOT umbrella-resolved (`optInFlag` is default-OFF only).
- Gate in `compactMessages`: compact2 iff `agent.artifacts` non-null AND `agent.config?.compact2 !== false`.
  - **Path A — own flag off** (`=0`): legacy branch, output byte-identical to `` `[Compacted ${n} messages]\n${parts}` `` with the 200/200/100 slices; no file written.
  - **Path B — artifacts off** (`MINIMA_TUI_ARTIFACTS=0`): `main.ts` never constructs the store (guard ~683), `agent.artifacts` stays null → legacy branch regardless of `compact2`. Same for `:memory:` DBs.
  - **Runtime degrade (unflagged):** `sink(...)` returns `null` (fail-open store) → legacy byte-identical output for that compaction. Never emit a pointer to an unwritten file.
  - The optional-chain makes existing `tests/compact.test.ts` fake agents (no config/artifacts) hit legacy → the whole existing suite is a zero-edit byte-identical pin.

## 4. Spill entry point + GC run_id-exemption inheritance proof (R1/R4)

**Entry point:** `ArtifactStore.sink(tool)` → `store.sink("compact")(serialized)` → `{ ref: absPath } | null` (`_artifacts.ts` `sink()` ~159–180). Synchronous (writeFileSync), matches the sync compaction call sites. No new method.

**Inheritance argument (verified in-file):**
1. `main.ts` ~844 `artifactStore?.attach(db, runId)` with the live run id; `MinimaDb` structurally satisfies `ArtifactIndex`. Compaction only runs mid-session → store always attached by then.
2. `sink()`→`recordRow()` (~197–221): `recordArtifact({runId,...})` → `claimArtifact(sql, sha, runId)` → `gc()`. Claim happens BEFORE the post-spill prune, so even the immediate GC sees the row owned by the current run; also covers content-addressed re-spill re-ownership (W3.3 "re-spill claims run_id" test).
3. `pruneArtifacts` (`_artifact_gc.ts` ~45–73): `if (protectRunId !== null && row.run_id === protectRunId) continue;` → compaction artifact skipped even over budget.
4. Bonus: `makeArtifactReadTouchHook` (main.ts ~759) bumps `last_used` when the model pages the artifact via `read` — path-keyed, applies to `tool_name="compact"` rows free.
5. `tool_name` is unconstrained TEXT (`minima_db.ts:464`) — `"compact"` needs no migration.
AC4 asserts this end-to-end at a tiny byte budget.

## 5. Serialization format + summary shape

Artifact body (v1), parser-recoverable regardless of content:
```
compact/v1 messages=<N>
--- msg <i> role=<user|assistant|toolResult>[ tool=<tool_name>][ error] bytes=<B> ---
<textContent verbatim, exactly B UTF-8 bytes>
```
One `\n` after each body. Recovery consumes exactly `bytes=B` (never delimiter-scanning) → header-lookalike lines, missing trailing newlines, multi-byte unicode all round-trip byte-exactly.

Compact2 summary (flag-on only; flag-off text untouched): line 1 `[Compacted ${N} messages — full transcript at ${ref}; read it with offset/limit to recover any message verbatim]`, then the same 200/200/100 one-liner parts, each prefixed `${i}. ` to correlate a gist line to `msg <i>`. `compactReport` unchanged.

## 6. Acceptance criteria (each gate-backed, red→green; run from `packages/tui`)

Red commit lands `tests/compact2.test.ts` + the `config_env` append first (`test(tui): red — …` then `feat(tui): …`).

- **AC1 (behavioral red — losslessness).** With a real attached `ArtifactStore` (tmpdir `MinimaDb`), the summary's named path exists and parsing recovers EVERY pruned message's `textContent` byte-exactly (delimiter-lookalike, no trailing newline, unicode, empty). Red today: no path, no artifact. `bun test tests/compact2.test.ts -t "recoverable"`.
- **AC2 (artifacts-off byte-identical).** `artifacts: null` → exact-string-equal legacy output, dir stays empty. Pin. `bun test tests/compact2.test.ts -t "byte-identical"` + `bun test tests/compact.test.ts` (green before AND after, zero edits).
- **AC3 (own-flag off).** `config:{compact2:false}` with a live store → byte-identical legacy, no new file; plus fake store whose `sink()` returns `null` → legacy (fail-open).
- **AC4 (R1/R4 GC interplay — integration evidence).** Store `gcBudgetBytes` < the compaction artifact, attached as `run-cur`; seed over-budget `run-old` rows. Compact → old-run rows evicted, compaction artifact file+row survive with `run_id === "run-cur"`. Red today. `bun test tests/compact2.test.ts -t "GC"`.
- **AC5 (recovery via existing read tool).** `readTool({workdir:<unrelated tmpdir>, artifacts:store})` reads the artifact path with offset/limit → expected slice. `-t "read"`.
- **AC6 (auto path).** Over-80% fake agent with store+config → `maybeAutoCompact` true and the new summary carries the path. `-t "auto"`.
- **AC7 (flag shape).** unset→on, `"0"`→off, `"1"`→on (`withEnv`). `bun test tests/config_env.test.ts`.

Full gates: `bun test && bun run check && bun run lint`.

## 7. Test plan (hermetic)

All in `tests/compact2.test.ts`: `mkdtempSync` dirs with `afterEach` rm (shape of `tests/artifact_gc.test.ts`), real `MinimaDb` on a tmp file, real `ArtifactStore`, fake agents as plain objects (`agentState`+`config`+`artifacts`) per `tests/compact.test.ts`. No network, no env leakage (`withEnv`), no wall-clock. A small in-test parser implements the `bytes=B` framing for round-trip asserts.

## 8. Migration

**None.** The `artifacts` table already carries everything; `"compact"` is a new `tool_name` in an unconstrained TEXT column. If a schema change ever seems needed → STOP and escalate.

## 9. Sequencing

1. Red commit: tests + config_env append (AC1/4/5/6/7 red; AC2/3 pins green).
2. Green commit: `config.ts` flag → `runtime.ts` field → `main.ts` wiring line → `compact.ts` branch. Full gates.
3. PR into the Wave-4 train **last**; rebase over earlier Wave-4 merges + re-run gates (frozen surfaces must not have drifted).

**Unconfirmed:** none material. Re-verify `app.tsx` ~2884/~4413 and `main.ts` ~683/~759/~844 at build time (drift-prone).
