# MUB-208 — LSP diagnostics pathfinder (Wave 5) — ONE PR, Wave-0 discipline

> Plan pass 2026-07-24 against feat/boosting @ fd1ef5e (Waves 0–4 merged). Harness: `packages/tui`. Line numbers are anchors — re-verify at build time.
> Greenfield: grep for `jsonrpc|Content-Length|publishDiagnostics|lsp` over `src/` = zero hits. Client is fully hand-rolled (reimplement-only trivially satisfied).

## 0. Grounding (verified against fd1ef5e)

- **Hook fold** (`src/agent/loop.ts` `runOneTool`): `afterToolCall` is awaited after execute; `if (ar.details) result = {...result, details:{...result.details, ...ar.details}}`, `if (ar.content) result = {...result, content: ar.content}`; a throwing hook is caught → "degrade to the raw tool result". This is the additive/fail-open lever.
- **Hook registration** (`Agent.addAfterToolCall`, ordered fold stack): `main.ts` already registers `makeArtifactReadTouchHook` (~:766); `_artifact_gc.ts`'s hook is the reference shape (reads `ctx.toolCall.arguments.path`, guards `!ctx.isError && !ctx.result.details?.error`, returns `null`).
- **Result shapes**: `edit` → `details:{replacements}`, `arguments.path`; `write` → `details:{bytes}`, `arguments.path`; `apply_patch` → `details:{writes:string[],deletes:string[]}`, `arguments.patch` (no path). Touched paths = `arguments.path` OR `details.writes`.
- **Discovery ref** (`resolveRg(override?)`, `_rg.ts`): `override!==undefined` short-circuits (test seam), else cached `Bun.which`; null override forces fallback. Mirror this tri-state exactly.
- **Long-lived child** (`_bgjobs.ts` `BgJobRegistry`): `Bun.spawn` piped, live handles in a Map, killed at `shutdown()` called from `closeDb` (`main.ts:939`); `killProcessGroup` in `check.ts` (needs `detached:true`).
- **Feedback-truth** (`runtime.ts` ~:1289): `verifiedInProduction = evidenceSource==="gate"`, `"gate"` only when `deterministic.confidence==="green"`. Observer's `observer_flagged` (signals-map only, never outcome/quality/evidence_source) is how advisory evidence stays out of the truth path.
- **Flag shape**: `optInFlag(env, experimental)` is the mandated helper for default-off umbrella-covered features (ttsr/observer/interview).

## 1. Scope + non-goals

**In scope (this PR):** spawn a locally-installed stdio LSP server; hand-rolled Content-Length JSON-RPC framing; initialize/initialized handshake; `didOpen`/`didChange` (full-sync); correlate the server-pushed `publishDiagnostics` for the just-edited file within a hard timeout; surface diagnostics ADDITIVELY in the tool result of `edit`/`write`/`apply_patch` via ONE `afterToolCall` hook. Discovery mirrors `resolveRg`. Session-end teardown kills every spawned server. tsserver-first.

**Non-goals (FROZEN OUT until seam review):** rename, references, code-actions, hover, completion, formatting, symbols; the PULL model (`textDocument/diagnostic`); any DAP; any persisted gate/DB row for diagnostics; any migration; flag promotion to default-ON. pyright/gopls ride the same seam but are not the acceptance target.

## 2. Full write-set

| File | Change |
|---|---|
| `src/tools/_lsp.ts` | **NEW** — framing layer + `LspManager` (discovery, lifecycle, `LspClient`) + `makeLspDiagnosticsHook`. |
| `src/minima/config.ts` | `lsp: boolean` field, default `false`, `cfg.lsp = optInFlag(process.env.MINIMA_TUI_LSP, cfg.experimental)`; optional `MINIMA_TUI_LSP_TIMEOUT_MS` parse. |
| `src/cli/main.ts` | Construct `LspManager` (guarded by `config.lsp`), register `makeLspDiagnosticsHook` via `agent.addAfterToolCall`, call `lsp?.shutdown()` inside `closeDb`. |
| `tests/fixtures/lsp-stub-server.ts` | **NEW** — hermetic Bun stub speaking real Content-Length JSON-RPC, scripted via env. |
| `tests/lsp-diagnostics.test.ts` | **NEW** — acceptance + framing unit tests. |

**UNTOUCHED**: `edit.ts`, `write.ts`, `apply_patch.ts`, `types.ts` (`FsToolOptions`). The hook reads paths from `ctx.toolCall.arguments`/`ctx.result.details` — the mutating tools carry NO LSP awareness (cleanest additive seam; trivial flag-off byte-identity).

## 3. The FROZEN client seam (the heart of this PR)

```ts
export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";
export interface Diagnostic { severity: DiagnosticSeverity; message: string; line: number; character: number; source?: string; code?: string | number; }
// provenance the projection reports HONESTLY — empty is never "clean" unless status==="ok"
export type DiagnosticsStatus = "ok" | "no-server" | "timeout" | "unsupported" | "error";
export interface DiagnosticsResult { path: string; uri: string; status: DiagnosticsStatus; diagnostics: Diagnostic[]; }

// discovery mirrors resolveRg's override contract EXACTLY: undefined→cached probe; null→force no-server; spec→force (test seam)
export interface LspServerSpec { id: "tsserver" | "pyright" | "gopls"; bin: string; args: string[]; extensions: ReadonlySet<string>; }
export function resolveLspServer(ext: string, override?: LspServerSpec | null): LspServerSpec | null;

// the client surface a future op-slice builds on (frozen, diagnostics-only for now)
export interface LspClient {
  diagnosticsFor(absPath: string, opts?: { timeoutMs?: number }): Promise<DiagnosticsResult>;
  shutdown(): void;  // idempotent; kills every spawned server
}

// injected-spawn seam (hermetic tests)
export interface SpawnedConnection { send(msg: object): void; onMessage(fn: (msg: any) => void): void; kill(): void; readonly alive: boolean; }
export type LspSpawn = (spec: LspServerSpec, cwd: string) => SpawnedConnection;

export class LspManager implements LspClient {
  constructor(opts: { workdir: string; resolve?: (ext: string) => LspServerSpec | null; spawn?: LspSpawn; timeoutMs?: number; });
  diagnosticsFor(absPath: string, opts?: { timeoutMs?: number }): Promise<DiagnosticsResult>;
  shutdown(): void;
}

export function makeLspDiagnosticsHook(client: LspClient, opts: { workdir: string }): AfterToolCall;
```

Why minimal-but-forward-looking: `diagnosticsFor` is the only op exposed. A rename slice adds `rename(path,pos,newName)`, references adds `references(path,pos)` — both need the id-correlated request/response half (which the pathfinder builds internally for `initialize` but only exercises the notification correlator for `publishDiagnostics`). Freezing `LspClient` as an INTERFACE lets follow-ups widen it without breaking callers. `SpawnedConnection`/`LspSpawn` are the test leverage point. `resolveLspServer` copies `resolveRg`'s tri-state so test seam and prod cache are one function.

## 4. Flag: `MINIMA_TUI_LSP`, default OFF (opt-in, umbrella-covered)

Companion `MINIMA_TUI_LSP_TIMEOUT_MS` (diagnostic switch, not umbrella). **Default-OFF justification:** fail-open makes default-ON safe for CORRECTNESS (§7) but not right for a pathfinder. It's a new external-process surface — flag-on, any session in a repo with `typescript-language-server`/`pyright`/`gopls` installed silently spawns a long-lived child and adds up to the timeout budget to EVERY edit (real latency tax + un-asked side effect). Repo precedent for new-side-effect/mis-fire-risky surfaces is opt-in-until-field-validated (ttsr, observer, fetchLocal). Wave-0 discipline: the seam must be reviewed before it's on every machine; OFF→ON promotion is an explicit seam-freeze decision (§11), not this PR's claim. **Flag-off byte-identity:** `config.lsp===false` → `main.ts` never constructs `LspManager`, never registers the hook → the fold sees no LSP contribution → results byte-for-byte today's; no process spawned (same guarantee as `bgJobs===null`).

## 5. Never-block design (problem 2)

The `afterToolCall` return IS awaited in `runOneTool` → the hook is on the tool-result critical path; append-late is impossible. So the bound is enforced INSIDE the hook:
- **Hard timeout `DIAGNOSTICS_TIMEOUT_MS = 1500`** (module const, overridable by `MINIMA_TUI_LSP_TIMEOUT_MS`). `diagnosticsFor` = `Promise.race([collect(), timer(timeoutMs)])`. Timeout → `status:"timeout"`, empty → hook returns `null` → byte-identical. For `apply_patch` touching N files the budget is SHARED across the batch (one race over the combined collection) — N files never multiply latency.
- **Debounce `DIDCHANGE_DEBOUNCE_MS = 200`**: per-URI monotonic `version`; a newer `didChange` supersedes the older waiter (resolved as skipped), manager awaits only the latest version; 200ms quiet-window collapses a burst into one settle-wait. Single-edit turn: window elapses immediately, adds nothing measurable.
- **Placement**: constants + race live in `_lsp.ts` (`LspManager.diagnosticsFor`), never in edit/write/apply_patch or loop.ts. Hook is a thin adapter.
- Worst-case added latency ≈ 1.5s per mutating call, only flag-on + server present — the reason the flag defaults OFF.

## 6. JSON-RPC framing + handshake + publishDiagnostics correlation (problem 3)

**Framing (zero-dep).** Outbound: `Content-Length: ${byteLength(body)}\r\n\r\n${body}` to child stdin (`TextEncoder` for UTF-8 byte length). Inbound: incremental parser over stdout `getReader()`/`TextDecoder` streaming loop (bash.ts/_bgjobs.ts pattern) — accumulate bytes, scan for `\r\n\r\n`, parse `Content-Length`, wait for ≥N body bytes, slice exactly N, `JSON.parse`, emit, loop on remainder (handles split headers/bodies + two messages per chunk — AC7).
**Handshake** (once per server per session): spawn (`Bun.spawn([bin,...args], {cwd:workdir, stdin:"pipe", stdout:"pipe", stderr:"pipe", detached:true})`), send `initialize` (id:1, rootUri, minimal capabilities: `textDocument.synchronization` + `publishDiagnostics`), await id:1 via the id-correlator, send `initialized`.
**Document sync**: first touch → `didOpen` (`{uri, languageId, version:1, text}` from disk post-edit); subsequent → `didChange` (version++, single full-document change; full-sync, no range math).
**Correlation (the crux):** `publishDiagnostics` is a server→client NOTIFICATION (no id). Manager keeps `Map<uri, pendingWaiter>`. Per touched file: send didOpen/didChange at version V, register a waiter for U; every inbound message routed — responses (have id) resolve the id-correlator, `publishDiagnostics` notifications look up `params.uri`, resolve the waiter with `params.diagnostics` (prefer `params.version===V` when present, else first publish for U after send); waiter bounded by the shared timeout race.
tsserver (`typescript-language-server --stdio`)/pyright/gopls PUSH diagnostics on didOpen/didChange — notification correlator suffices. Pull model out-of-scope-for-now (the id-correlator the pathfinder builds for `initialize` is what a pull slice reuses).

## 7. Fail-open proof (problem 4)

Result differs from today IFF: flag ON ∧ server resolves for ext ∧ ≥1 diagnostic ∧ arrives in-window. Every other path → hook returns `null` → byte-identical:

| Axis | Mechanism | Result |
|---|---|---|
| Flag off | hook never registered | byte-identical |
| No server for ext | resolve→null, `status:"no-server"` | null |
| Spawn throws / crash | caught, connection dead, `status:"error"` | null |
| Non-parseable / silent | timeout wins, `status:"timeout"` | null |
| Clean file (0 diags) | `status:"ok"`, empty | null (common case stays byte-identical) |
| Tool failed / guard-rejected | hook guards `ctx.isError \|\| ctx.result.details?.error` | null |
| Hook throws | loop.ts try/catch → raw result | byte-identical |

When it DOES contribute: `{ details:{lsp: DiagnosticsResult}, content:[...ctx.result.content, text(projection)] }` — original blocks preserved, one compact block appended. Additive-only, never removes/rewrites.

## 8. Acceptance criteria (red→green, from `packages/tui`; base red = no `_lsp.ts`/hook)

- **AC1 (behavioral RED):** an `edit` introducing a type error into `.ts`, through the real `editTool` then `makeLspDiagnosticsHook` (stub `error` mode) → `details.lsp.diagnostics` non-empty + appended content names the error, same turn. `-t "surfaces a type error in the same turn"`.
- **AC2 (absent-server byte-identity):** `resolve`→null → deep-equal the no-hook baseline (content + details, no `lsp` key). `-t "absent server is byte-identical"`.
- **AC3 (slow-server timeout):** stub `slow` mode → hook returns within ~timeoutMs (assert wall-clock < timeoutMs+slack), byte-identical. `-t "slow server times out and skips"`.
- **AC4 (clean file):** stub `clean` mode → no append, byte-identical. `-t "clean file appends nothing"`.
- **AC5 (apply_patch multi-file, shared budget):** two `.ts` files → diagnostics for touched files within one shared budget. `-t "apply_patch surfaces diagnostics"`.
- **AC6 (lifecycle):** after `shutdown()` the stub child is dead (`process.kill(pid,0)` throws). `-t "shutdown kills the server"`.
- **AC7 (framing unit):** Content-Length stream split across chunks + two messages in one chunk → exact decode. `-t "frames split across chunks"`.
- **AC8 (flag):** `configFromEnv` unset→false, `=1`→true, umbrella→true, explicit `=0` under umbrella→false. `-t "flag resolves through optInFlag"`.
- Regression: `bun run check` + `bun run lint` green (module is dep-free + typed).

## 9. Test plan — hermetic stub (problem 5)

NO real language server is ever a test dependency.
**(a) `tests/fixtures/lsp-stub-server.ts`** — a Bun script reading Content-Length framed JSON-RPC from stdin (its OWN tiny reader, independent of the client's parser, so both directions exercise real framing); responds to `initialize` (id-matched, minimal `{capabilities:{textDocumentSync:1}}`), ACKs `initialized`, and on didOpen/didChange emits a scripted `publishDiagnostics` echoing the uri (+version when present). Scripted via env `LSP_STUB_MODE`: `error` (one error) / `clean` (empty) / `slow` (sleep>timeout or never) / `crash` (`process.exit(1)`).
**(b) Discovery/spawn override:** `new LspManager({ workdir, resolve: () => ({id:"tsserver", bin:"bun", args:[stubPath], extensions:new Set([".ts"])}) })` points discovery at the stub; or inject `spawn` for the in-process framing unit (AC7, no child). Same tri-state as `resolveRg`.
Harness style follows `tests/bgjobs.test.ts` (`mkdtempSync`+`afterEach`, `body(res)` extractor, `alive(pid)` probe, `waitFor`). AC1/AC5 drive the REAL `editTool`/`applyPatchTool` `.execute(...)` on temp files then call the hook on the real `ToolResult` — end-to-end additive path, not a mock.

## 10. Migration: NONE (explicit)

Diagnostics are ephemeral — they live only in the turn's tool-result `content`/`details`. No `gates` row, no table, no ALTER. State-in-DB satisfied trivially (no state to persist). A future slice persisting advisory diagnostics as gate/signal rows would be the FIRST post-v22 migration and needs orchestrator reservation — this PR deliberately does not open it.

## 11. Seam-freeze review (before any follow-up LSP op is planned)

1. The frozen types + `diagnosticsFor` signature (§3) — confirm `LspClient` as an interface admits new ops without breaking callers.
2. **Request/response correlation gap**: the pathfinder exercises only the NOTIFICATION correlator end-to-end; the id-correlated request/response path (only `initialize` here) is what every future op depends on. Decide it's proven, or require an id-correlator acceptance test first.
3. **Real-server framing validation** (out-of-CI, manual): run against real `typescript-language-server --stdio`/`pyright-langserver`/`gopls` once, and CONFIRM the TS-lane binary name (the flagged `tsserver` vs `typescript-language-server` question, §6).
4. **Flag promotion OFF→ON** — only after field-validating latency + lifecycle on real servers.
5. **Advisory gate/signal graduation** — whether diagnostics become an explicit advisory YELLOW signal (observer `observer_flagged` / at-most-one-yellow pattern); touches feedback-truth, must never reach `evidence_source="gate"`/`verified_in_production`. Deferred by design.

## Flagged knowledge claims (validate at seam-freeze, non-blocking — stub makes them so)

- **`tsserver` binary naming (§6):** raw `tsserver` speaks the TSServer protocol (newline-delimited), NOT LSP Content-Length; the LSP TS server is `typescript-language-server --stdio`. No in-repo evidence (greenfield) — production discovery must resolve `typescript-language-server` and confirm before default-ON.
- **Push-vs-pull (§6):** the claim that tsserver/pyright/gopls push `publishDiagnostics` on didOpen/didChange without a pull is LSP knowledge, not repo evidence. The stub encodes push; real-server confirmation is a seam-freeze item.
- Everything else (hook fold, result shapes, discovery/lifecycle, feedback-truth, flag plumbing) is verified against opened files in §0.
