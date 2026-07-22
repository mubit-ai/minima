# TUI harness tool-layer audit

> Audited 2026-07-22 at `feat/boosting` = 54fcb68 (0.14.0). All paths relative to
> `packages/tui`. This is the "current state" evidence base for `../boosting-roadmap.md`;
> the fixes are specified in `p0-design-rationale.md`.

## Tool inventory

Default set (11), assembled by `builtinTools()` (`src/tools/builtin.ts:62-79`):
`read, write, edit, apply_patch, bash, ls, glob, grep, todowrite, web_search, web_fetch`.
Separately registered: `task` (`src/tools/task.ts`, added at `src/cli/main.ts:911`),
`question`, `exit_plan`.

| Tool | File | Implementation |
|---|---|---|
| grep | `src/tools/grep.ts:24-85` | Spawns ripgrep via `Bun.spawn(["rg", ...])`; on spawn throw falls back to `grep -rn`. Truncates at 200 lines with `…(N more matches)`. exit 1 → `(no matches)`, exit 2 → error. |
| glob | `src/tools/glob.ts:15-37` | `new Bun.Glob(pattern).scan({cwd, dot:false})`; caps at 200 during scan, then sorts. |
| read | `src/tools/read.ts` + `src/tools/_io.ts:44-62` | `offset`/`limit` params (default 1/2000); `readLines` = `readFile(path,"utf8")` then slice. Per-line cap 2000 chars. Truncation notice present. |
| ls | `src/tools/ls.ts:17-45` | Fully sync `readdirSync` + per-entry `statSync`; dirs-first sort; includes hidden; no cap. |
| write | `src/tools/write.ts` + `_io.ts:64-68` | mkdir-recursive + writeFile utf8, full overwrite. |
| edit | `src/tools/edit.ts:23-56` | Whole-file read; `split(old).length-1` count; errors on 0 or >1 matches without `replace_all`. |
| apply_patch | `src/tools/apply_patch.ts` | Atomic multi-file Codex-format patch; all hunks resolved in memory before any write; fully sync fs. |
| bash | `src/tools/bash.ts:40-134` | `Bun.spawn(["bash","-c",cmd],{detached:true})`; 120s default timeout; process-group kill on abort. |
| todowrite | `src/tools/todowrite.ts` | Per-instance closure state; bigPlan variant is sequential with verify gate. |
| web_search / web_fetch | `src/tools/web_search.ts`, `web_fetch.ts` | Exa → DuckDuckGo fallback; web_fetch truncates at 8000 chars with notice. |

Directory discovery today: `ls` (single-dir) + `glob` (pattern) + `grep` (content). No tree
tool. The bash description steers the model away from `find/cat/sed` toward native tools.

## Confirmed bugs (the P0 backlog)

1. **grep drops line numbers on the ripgrep path.** `grep.ts:35` passes both `-n` and `-N`
   (`--no-line-number`); last flag wins in rg, so output is `file:content` while the tool
   description (`grep.ts:80-81`) promises `file:line:content`. Verified empirically. Only the
   `grep -rn` fallback actually numbers lines.
2. **grep's ".gitignore respected" claim is false for the fallback.** `grep -rn` (`grep.ts:51-57`)
   descends everywhere, including `node_modules` and `.git`.
3. **glob caps before sorting.** 200-cap applied during scan, then `sort()` on that arbitrary
   subset (`glob.ts:28-33`) → non-deterministic omissions. No .gitignore/node_modules filtering
   (big repos flood the cap before reaching source). The cap is silent — no truncation notice.
4. **read loads whole files into memory** regardless of offset/limit (`_io.ts:48`); no max-size
   guard, no binary detection (binary → mojibake), no image handling.
5. **ls is uncapped and crashes on dangling symlinks.** Per-entry `statSync` (`ls.ts:26`)
   throws on a broken symlink with no per-entry try/catch → the whole listing fails. A huge
   directory dumps every entry.
6. **bash output is unbounded** — stdout+stderr fully buffered (`bash.ts:26-38,111`); a noisy
   command floods memory and model context. `onUpdate` fires once at completion despite the
   header comment claiming live streaming (`bash.ts:5-6,114`).
7. **Sync fs in ls and apply_patch** blocks the event loop during parallel tool batches
   (`loop.ts:416-427`).

Truncation signalling today: grep/read/web_fetch tell the model; glob's cap and bash's
unboundedness are silent.

`_io.ts:23-24` documents that `resolveWithin` is "a convenience boundary, not a sandbox" —
the permission layer stays the real gate.

## Test coverage

- `tests/tools.test.ts` covers read/write/edit/bash/ls/builtin-roster/web_search/web_fetch/
  question. `tests/apply_patch.test.ts`, `tests/todowrite.test.ts` cover their tools.
- **grep and glob have ZERO execution-level tests.** Every mention of them in tests
  (`permissions.test.ts`, `tool-permissions.test.ts`, `modes.test.ts`, …) is the name string
  in permission/label/routing tests — none run the tool. This is why bug #1 went uncaught.
- Hermetic pattern for new tests: `mkdtempSync(join(tmpdir(), …))` + `afterEach` rm; network
  via `globalThis.fetch` swap (`mockFetch`/`mockFetchRouted`, `tools.test.ts:189-241`); LLM via
  the faux provider (`src/ai/providers/faux.ts:99-116`) with scripted responses and captured
  requests.

## Registration / dispatch / schema surface

- Registration: plain array from `builtinTools()`; lead agent `cli/main.ts:542`; sub-agents
  `minima/spawn.ts:121` (`exclude:["task"]`).
- Dispatch: `agentLoop` → `executeToolCalls` (`src/agent/loop.ts:371-440`); schema
  `parameters.validate()` gate; parallel `Promise.all` unless a tool is
  `executionMode:"sequential"`; per-tool try/catch → `errorResult`.
- Hooks: ordered `beforeToolCallHooks`/`afterToolCallHooks` (`src/agent/agent.ts:62-63,119-137`);
  first before-hook returning `block:true` wins; after-hooks fold. The permission layer is
  itself a beforeToolCall hook (`src/tui/permissions.ts`, `app.tsx:1450`) — model-agnostic,
  wraps all tools uniformly. This is where a P2 bash interceptor belongs.
- Schema surface: tools declare params via `objectSchema` (`src/tools/schema.ts:34-78`) →
  one jsonSchema converted per provider (anthropic.ts:236, openai_compat.ts:146,
  google.ts:228-307). Schema changes must be strictly additive.
- Swapping grep's engine behind the same schema is a self-contained edit to `executeWithin`;
  adding a tool is one factory + one line in `builtinTools`.

## Deps / Bun APIs

Deps (`package.json:29-36`): `@anthropic-ai/sdk`, `@google/genai`, `@mubit-ai/sdk`, `ink`,
`react`, `string-width`. No ripgrep vendored (ambient `rg`, `grep` fallback); no glob lib
(built-in `Bun.Glob`). Tool layer uses `Bun.Glob`, `Bun.spawn`; everything else is
`node:fs`/`node:fs/promises`. `bun:sqlite` lives in `src/db/`, not in tools.

## Behavioral notes discovered during design (affect P0/P1 work)

- `loop.ts:448-451` buffers `onUpdate` events and only yields them **after** the tool finishes —
  fixing bash streaming fixes the tool contract, but live UI rendering needs a separate loop
  change (out of P0 scope); no TUI component consumes `toolExecutionUpdate` today.
- Nothing in `src/` reads `details.count` — details-shape changes are risk-free.
- `permissions.ts:140` imports only the pure/sync `parsePatch` from apply_patch — internals can
  be restructured freely as long as `parsePatch` stays sync.
- ripgrep only applies `.gitignore` inside a git repo, and does NOT skip `node_modules` unless
  a `.gitignore` says so — glob's fix normalizes this in TS so both engines agree.
- rg `-g '*.ts'` matches at any depth; `Bun.Glob` `*.ts` is top-level only — glob must NOT pass
  the user pattern to rg; it must filter rg's file list with `Bun.Glob.match()`.
- GitHub issues: 104 total, all closed, none tracking these tool bugs — all latent/unreported.
