# oh-my-pi analysis — feature research for the boosting roadmap

> Researched 2026-07-22 against https://github.com/can1357/oh-my-pi (v17.0.7, commit of 2026-07-21).
> Purpose: identify patterns worth **reimplementing** in the minima TUI harness. Policy is
> reimplement-only — no code is copied from oh-my-pi; this doc is the reference the
> just-in-time `/plan` passes for P1–P4 work from. See `../boosting-roadmap.md`.

## What it is

"Oh My Pi" (`omp`) is a terminal-first AI coding agent (CLI + TUI + SDK + RPC + ACP), a heavily
extended fork of Mario Zechner's Pi (`pi-mono`): 40+ providers, 32 built-in tools, 14 LSP ops,
28 DAP ops, ~55k lines of Rust core linked in-process via N-API.

- **Runtime**: Bun ≥ 1.3.14 (TypeScript monorepo) + Rust N-API addon (`@oh-my-pi/pi-natives`),
  prebuilt for 5 platforms. Native Windows support (no WSL).
- **License**: MIT (© 2025 Mario Zechner, © 2025–2026 Can Bölük).
- **Maturity**: 19.2k stars, 1.8k forks, 533 releases (daily cadence), 1,705 `*.test.ts` files,
  ~79 architecture docs, a dedicated edit-benchmark package.
- **Size**: `coding-agent` 370k LOC TS · `ai` 90k · `catalog` 99k · `tui` 24.8k · `agent` 13.6k ·
  `hashline` 5.7k. Rust: 74k own + 100k vendored (brush bash fork).
- **Deps**: no `openai`/`anthropic` SDKs — all wire protocols hand-rolled.

## Feature inventory

### Read tool (`src/tools/read.ts`, ~3.6k LOC)

One `read` tool for everything: files, directories, archives (`.tar/.zip:member`), SQLite
(`db.sqlite:table:key`), images, PDFs/docx, notebooks, URLs, 12+ internal `://` schemes.

- **Selectors appended to the path**: `:50-200`, `:50+150`, `:5-16,960-973` multi-range, `:raw`,
  `:conflicts`. Same grammar on URLs and internal schemes.
- **Structural summary by default**: parseable code with no selector returns a tree-sitter
  declaration summary (bodies elided); the footer names exact "recovery selector" ranges to
  re-read. The prompt hard-forbids guessing elided content.
- **Truncation**: 3000 lines / 50KB defaults, 512-col per-line cap; overflow **spills to a
  content-addressed artifact** (`artifact://<id>`, blob store `~/.omp/agent/blobs/<sha256>`)
  the model can page back with `:N-M` — output is never simply lost.
- **Edit coupling**: every read/search emits a `[path#TAG]` snapshot header (4-hex content hash)
  and records exactly which line numbers the model saw (seen-lines ledger).

### Grep (`src/tools/grep.ts` + Rust `grep.rs`)

- Links the actual ripgrep engine crates in-process (no fork-exec); Rust regex + PCRE2;
  timeout/AbortSignal cancel; parallel walk with globally correct offset/maxCount aggregation.
- mtime-keyed shared FS scan cache shared by read/grep/glob/lsp, invalidated by write/edit tools.
- Output: `LINE:TEXT` rows under `[path#TAG]` headers → **grep results are directly valid edit
  anchors**. Context windows, dedup, 512-col truncation, default 20-file limit.

### Glob / listing (`src/tools/glob.ts`)

Semicolon-delimited multi-pattern; `gitignore` (default true) and `hidden` flags; results sorted
by mtime newest-first, grouped by directory; directory reads produce depth-limited trees.

### Edit — the flagship (`packages/hashline`, 5.7k LOC self-contained)

**Hashline patch language**: section header `[PATH#TAG]` (snapshot hash from last read), ops
`SWAP N.=M:` / `SWAP.BLK` / `DEL` / `INS.PRE/POST/HEAD/TAIL` / `MV`; body rows are all
`+final content` — no old/new pairs, no context lines, no string matching.

- Safety: stale-tag rejection with recovery; hunks anchored on lines the model never actually
  saw are **rejected** (seen-lines ledger); noop-loop guard; off-by-one auto-repair; every
  apply mints a fresh tag and returns renumbered content.
- Fallback modes per model: `replace` (str_replace), `patch`, `apply-patch` (OpenAI-style).
- Benchmark claims: Grok Code Fast 6.7%→68.3% edit pass rate; −61% output tokens on Grok 4 Fast;
  +5pp over str_replace on Gemini 3 Flash.
- Only the `.BLK` (block) ops need tree-sitter; the rest is pure TS.

### Bash / shell

- Embedded bash interpreter in-process (vendored brush fork): persistent sessions, Windows
  parity, optional PTY mode, async background jobs with a `hub` wait/message/cancel tool.
- **Bash interceptor**: regex rules block `cat/head/tail`, `grep/rg`, `find/fd`, `sed -i`,
  `echo > file` when the equivalent native tool is registered — "Blocked: use read/search".
- Leading `cd X && …` auto-extracted into `cwd`; output through the same truncate-or-spill sink.

### Agent loop (`packages/agent/src/agent-loop.ts`)

- Steering queue (user typed mid-run) polled while interruptible tools run; aside messages
  folded at turn boundaries; tool-scoped aborts synthesize per-tool placeholder results.
- **Retry policy**: regex-classified transient/rate/refusal errors; **retry refused if the
  stream already emitted observable output** (tool call / text / thinking) — no silent replay
  of half-turns; context overflow routes to auto-compaction instead. Per-role fallback chains
  with cooldown restore; round-robin credential rotation with per-credential backoff.
- **TTSR — time-traveling stream rules**: dormant regex rules matched against the live token
  stream; on match the request is aborted mid-token, the rule injected as a system reminder,
  and the turn retried from the same point; injections survive compaction. Zero context tax
  until violated.

### Provider abstraction

7 wire-API families implemented from scratch; a dialect layer (xml/harmony/hermes/qwen3/…)
gives in-band tool calling to models without native tool APIs; model roles
(`default`/`smol`/`slow`/`plan`/`commit`) route by intent. Fully model-agnostic.

### TUI (custom renderer, NOT Ink)

Differential renderer with an append-only native-scrollback contract: committed rows are
physically scrolled into terminal history and never rewritten; only the live window repaints.
Same failure family minima's anchor ledger already solved on Ink, different solution. Kitty
keyboard protocol, inline images, ANSI-aware width/wrap in Rust (their answer to the ink
width-table problem).

### Sessions / persistence

JSONL tree sessions (`id`/`parentId`, movable `leafId` for branch navigation, append-only);
content-addressed blob externalization; compaction as first-class entries; `snapcompact`
(history archived as dense bitmap images readable by vision models). **`checkpoint`/`rewind`
tools**: agent marks a checkpoint before exploration, then `rewind(report)` deletes the
intermediate tool spam from active context keeping only the report.

### Subagents

`task` fans out parallel subagents with typed output schemas (schema-validated return objects,
no prose parsing); copy-on-write worktree isolation (APFS clonefile / reflink / overlayfs);
agent defs from markdown frontmatter; per-agent model + prewalk (expensive model auto-hands-off
to `smol` at first edit); IRC-style DMs between live agents; an **advisor** second model reads
every turn on its own context and injects notes inline.

### LSP & DAP

14 LSP ops (rename through `workspace/willRenameFiles`, references, code actions, diagnostics
with a post-write deferred-diagnostics ledger); 28 DAP ops driving lldb-dap/dlv/debugpy.

### Extensibility

Extensions are plain TS modules loaded in-proc (`pi.on(event)` handlers can block tool calls,
custom tools/commands/renderers/TTSR rules/providers); native read-in-place inheritance of 8
foreign config formats (`.claude`, `.cursor`, …); MCP client with OAuth.

### Internal URL schemes

One resolver behind all FS-shaped tools: `pr://`, `issue://`, `agent://<id>/findings.0.path`,
`conflict://N`, `artifact://`, `history://` — "GitHub is just another filesystem."

### Other notables

`mnemopi` local SQLite long-term memory — **model-writable** (`retain`/`recall`/`reflect`),
the opposite of minima's harness-only-writes Letta split (inspiration only, do not import the
write model). Persistent Python/Bun eval kernels that call back into agent tools. 25-provider
web-search chain. Atomic commit splitting. Live session sharing over a relay.

## Security posture

- Approval tiers per tool: `read`/`write`/`exec` + per-call dynamic escalation (e.g. bash
  escalates on `rm -rf /`, `curl|sh`). But the DEFAULT mode is `yolo` (auto-approve everything).
- **No filesystem jail** (tools write anywhere), no network/exec sandboxing, no SSRF guard in
  fetch. Worktree isolation is merge hygiene, not security. Capability-rich, security-thin.
- Minima keeps its own permission layer (a `beforeToolCall` hook) — nothing to import here.

## Verdict for minima

**Top 5 to reimplement** (mapped to roadmap phases):

1. **Read/output economics** (→ P1): truncate-or-spill-to-artifact so output is never lost;
   selector-grammar-style paging; consistent truncation notices. Small surface, immediate value.
2. **Hashline-family edit safety** (→ P3): snapshot tags + seen-lines enforcement + stale-edit
   rejection with recovery. Enforced by the applier, not the prompt — matches minima's
   "enforcement in the dispatcher" doctrine. Skip `.BLK` ops (tree-sitter).
3. **TTSR** (→ P2 stretch): stream-abort → inject rule → retry; zero-cost tripwires.
4. **Checkpoint/rewind** (→ P4): deterministic context pruning; complements the ledger spine
   better than blanket compaction.
5. **Loop robustness patterns** (→ P2): bash interceptor rule table, retry classifier that
   never replays observable output, tool-scoped abort placeholders.

**Not worth porting**:

1. The Rust natives stack (pi-natives/pi-shell/pi-ast + vendored bash): enormous build surface;
   minima's macOS/Linux Bun harness can shell out to `rg`/bash.
2. The custom TUI renderer: minima already solved append-only scrollback with the anchor
   ledger on Ink; swapping engines is a rewrite with no user-visible delta.
3. The provider/dialect/catalog layer: minima's differentiator is Minima-service routing over a
   thin provider client; importing 190k LOC of provider breadth fights the recommend-only loop.
   Ditto collab relay, browser automation, DAP, and the model-writable memory design.
