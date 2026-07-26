# Next features analysis — what remains after P0–P4

> Researched 2026-07-24 on `feat/boosting` (post Wave 2: PRs #276–279 merged, main synced in).
> Purpose: inventory every candidate feature still on the table now that the original
> P0–P4 phases are complete, prioritize by the roadmap's rubric (importance × safety ×
> speed), and propose the next wave grouping. Sources: (a) explicit non-goals/deferrals
> written into the shipped phase plans, (b) unported features from
> `oh-my-pi-analysis.md`, (c) gaps surfaced by a fresh full-capability inventory of
> `packages/tui` run for this analysis. Companion to `../boosting-roadmap.md` — same
> workflow contract applies (reimplement-only, zero new deps, no test no merge, PRs →
> `feat/boosting`, Linear issues created at phase start, plan-then-build).

## 1. Where the harness stands (post P0–P4)

| Phase | Shipped | Flag / persistence |
|---|---|---|
| P0 | Tool-layer hardening: grep/glob/read/ls/bash/apply_patch fixes + `_bounds.ts`/`_rg.ts` seam + tool-schema snapshot pin | — |
| P1 | Spill-to-artifact: oversized tool output → content-addressed `<db-dir>/artifacts/<sha256>.txt`, re-read via normal `read` (offset/limit paging), SQLite index | `MINIMA_TUI_ARTIFACTS`, migration v20 |
| P2 | Loop robustness: bash-steer table (`cat/head/tail/grep/find/sed -i` → native tools), replay guard (effectful rungs never erased-and-replayed), tool-scoped abort plumbing | `MINIMA_TUI_STEER` |
| P3 | Edit guard: `[snap:]` tags + seen-lines ledger + stale/unseen rejection with re-read recovery, post-edit range remap; bench 12/12 + 4/4 | `MINIMA_TUI_EDIT_GUARD`, migration v21 |
| P4 | Checkpoint/rewind tool pair: projection-only context pruning, report retained, transcript stays in DB | `MINIMA_TUI_REWIND` |

Of oh-my-pi's "top 5 to reimplement", four are done (output economics, edit safety,
loop robustness core, checkpoint/rewind). **TTSR is the one explicitly deferred item**
(P2 plan §1: "TTSR is explicitly OUT — stays a stretch goal").

## 2. Candidate inventory

### 2a. Deferrals written into the shipped phases (cheapest to resume — design already anticipates them)

| # | Candidate | Origin | Current state (evidence) |
|---|---|---|---|
| D1 | **TTSR stream tripwires** — dormant regex rules over the live token stream; on match abort mid-token, inject the rule as a system reminder, retry the turn | P2 non-goal (stretch) | ABSENT. Loop accumulates `partialText` only for the abort marker (`src/agent/loop.ts:104-105`); observer tripwires run over *finished* turns only (`observer_tripwires.ts`). Replay guard already classifies rungs — a TTSR abort produces a non-`effectful` rung (no toolResult), so retry is legal under the P2 rule without weakening it |
| D2 | **Edit guard v2** — extend to `apply_patch` + `write`; per-agent seen-lines scoping | P3 non-goal ("revisit if the benchmark motivates it") | Ledger schema is ready: `seen_lines.agent_id` exists, always NULL in v1; `apply_patch` neither guarded nor recording, so patch-then-edit costs one stale-rejection round trip |
| D3 | **Artifact GC / retention** | P1 non-goal | Index rows already carry `bytes`/`created`/`last_used` (`minima_db.ts:463-475`) — "a later feature can add GC without a schema change" |
| D4 | **`cd`-extraction + steer table v2** — lift `cd X && cmd` into the `workdir` param; extend the (deliberately conservative) rule table | P2 non-goal | ABSENT — nothing parses `cd`; steer passes through anything with a metachar, so `cd X && grep …` bypasses steering today |
| D5 | **Sub-agent checkpoint/rewind + edit-guard coverage** | P3+P4 non-goals | Sub-agents get neither the ledger (`builtin.ts:66-71`) nor the rewind pair (`spawn.ts` untouched by P4) |
| D6 | **CI hygiene** — no CI on `feat/boosting` PRs; no `rg` in CI (rg-gated tests silently skip); tui CI job lacks lint | Wave-1 known flags | One-liner fixes, PR to main |

### 2b. Unported oh-my-pi features (from `oh-my-pi-analysis.md`)

| # | Candidate | omp shape | Minima current state |
|---|---|---|---|
| O1 | **Background bash jobs** — start long command → job handle; wait/poll/cancel tool | async jobs + `hub` tool | ABSENT. Every bash call is a fresh `Bun.spawn` that runs to completion or is killed (`bash.ts:102-108`); a dev server or long build blocks the whole turn or times out |
| O2 | **Typed sub-agent outputs** — schema-validated return objects, no prose parsing | `task` with typed output schemas | PARTIAL. `task` DAG runs children in parallel with worktree isolation, but `ChildResult.text` is prose; `output_format` is only a prompt instruction (`spawn.ts:60,254`) |
| O3 | **LSP integration** — diagnostics, rename, references | 14 ops via Rust | ABSENT (grep for lsp/tsserver/diagnostic: only unrelated hits). Highest-leverage slice is *post-edit diagnostics*, which slots into the existing gates/evidence spine |
| O4 | **Structural read summaries** — declaration outline for code files, bodies elided, recovery selectors | tree-sitter | ABSENT. Blocked as-specified: tree-sitter violates zero-new-deps. A regex outline is possible but low-fidelity |
| O5 | **Multi-format reads** — images, PDFs, archives, URLs | one `read` for everything | ABSENT — images explicitly rejected (`read.ts:49-50`), PDFs/zips trip the binary guard. Image support must be capability-gated per model (model-agnostic constraint) |
| O6 | **Persistent shell sessions** — state/cwd carry-over, PTY | embedded bash fork | ABSENT (fresh process, no PTY). omp needed a vendored Rust bash for Windows parity; minima doesn't |
| O7 | **FS scan cache** — mtime-keyed, shared by read/grep/glob, invalidated by writes | Rust-side cache | ABSENT — every call re-scans. rg is already fast; staleness bugs are the risk |
| O8 | **Per-model edit-dialect selection** | replace/patch/apply-patch per model | ABSENT — both `edit` and `apply_patch` always registered; nothing in routing/quirks selects |
| O9 | **Compaction v2** — today's compaction is extractive truncation (`tui/compact.ts`: one-liners, keep last 6); omp treats compaction as first-class with externalized content | compaction entries + blob store | PARTIAL. P1 artifacts + P4 rewind exist but compaction itself still *discards* — the pruned window could spill to an artifact and stay re-readable |
| O10 | **Internal URL schemes** (`pr://`, `artifact://`, …) | one resolver behind FS tools | Low value now — artifacts already re-read via plain file paths |
| O11 | **Sub-agent messaging / advisor model** | IRC DMs, advisor injects notes | Observer (`src/minima/observer.ts`) already covers the advisor niche harness-side; live DMs conflict with the DAG model |
| O12 | Atomic commit splitting · eval kernels · session sharing · snapcompact | — | Backlog-or-skip (see §5) |

### 2c. Gaps found by this inventory (not omp features — omp lacks some of these too)

| # | Candidate | Evidence |
|---|---|---|
| G1 | **SSRF guard for `web_fetch`/DDG fetch** — raw GET on any model-supplied URL: no loopback/private-range/link-local/metadata-IP rejection, no redirect re-check | `_ddg.ts:228-245`; only guards are content-type + timeout. A prompt-injected page can point the harness at `169.254.169.254` or `localhost:<port>` today |
| G2 | **Stale `task.ts` docstring** — header claims sequential execution; code is parallel | `task.ts:9-11` vs `task.ts:154-232` (trivial, fold into any nearby PR) |

## 3. Prioritization (importance × safety × speed)

Same rubric as roadmap §C. "Safety" = risk-inverse: high = additive/guarded, low = deep change.

| Rank | Candidate | Import. | Safety | Speed | Note |
|---|---|---|---|---|---|
| 1 | G1 SSRF guard | high (security) | high (pure guard + tests) | fast | No schema change; hermetic-testable with a local listener |
| 2 | D6 CI hygiene | medium | high | fast | Makes every later wave's gates trustworthy — do first |
| 3 | D3 Artifact GC | medium | high | fast | Schema ready; size/age policy + `/artifacts` count |
| 4 | D4 cd-extraction + steer v2 | medium | high | fast | Closes the `cd X && grep` bypass; still metachar-conservative |
| 5 | O1 Background bash jobs | high | medium | medium | Biggest capability gap left; additive tool schema (deliberate snapshot update); registry in DB per state-in-DB doctrine, live handles in-memory |
| 6 | D1 TTSR tripwires | high | medium | medium | Zero context tax until violated; interplay with replay guard already sound (non-effectful abort → legal retry) |
| 7 | O2 Typed sub-agent outputs | med-high | med-high | medium | Additive `Delegation.output_schema`; validate child's final text, one re-ask on invalid |
| 8 | D2 Edit guard v2 | med-high | medium | medium | apply_patch recording first (cheap), write + per-agent scoping after |
| 9 | O9 Compaction v2 (artifact-backed) | med-high | medium | medium | Fits "state in DB, projections in context" — compaction stops destroying information |
| 10 | O3 LSP diagnostics slice | high | med-low | slow | Big bet; zero-dep possible (stdio JSON-RPC to locally installed servers); diagnostics-after-edit ONLY as pathfinder — rename/references later, DAP never |
| 11 | O5 Image reads | medium | medium | medium | Needs catalog capability gating + provider-layer image blocks; clean error for non-vision models |
| 12 | D5 Sub-agent guard/rewind parity | medium | medium | fast-medium | After D2 (per-agent scoping unlocks it) |
| 13 | O8 Per-model edit dialect | low-med | medium | medium | Wait for evidence from P3 telemetry that some routed model needs it |
| 14 | O7 FS scan cache | low | med-low | medium | Perf not currently a complaint; staleness risk real — defer until profiling says otherwise |
| 15 | O6 Persistent shell / PTY | low-med | med-low | slow | Weak value/complexity ratio without the Windows-parity motive |

## 4. Proposed wave grouping

Waves keep the Wave-2 playbook: plan docs committed to `feat/boosting` before forking,
parallel worktrees, orchestrator write-set audit + clean-base red-proof, serial merge
train, regenerate (never hand-merge) the tool-schema snapshot on any schema-touching PR.

### Wave 3 — small, safe, fast (ranks 1–4; 1–2 PRs, no /plan pass needed beyond the sketch)
SSRF guard · CI hygiene · artifact GC · cd-extraction/steer v2 (+ G2 docstring fix).
All high-safety, no cross-collisions, each with red→green regression tests.
*Placeholder acceptance:* `web_fetch` of a loopback/private/metadata URL returns a clean
policy error (test with a local listener proving no connection was made); rg-gated tests
run (not skip) in CI; artifact dir bounded by policy with `last_used` respected; steered
`cd X && cat f` becomes a `read` steer with `workdir=X`.

### Wave 4 — runtime power (ranks 5–9; one worktree per feature, Wave-2-style parallel fan-out)
Background jobs · TTSR · typed sub-agent outputs · edit guard v2 · compaction v2.
Collision map needed up front (background jobs and TTSR both touch the loop; edit guard v2
and compaction v2 both touch DB/migrations — preflight doc like `wave2-preflight.md`).
*Placeholder acceptance (per feature, refined by the /plan pass):* a 10-minute dev-server
command returns a job handle in <1s and is pollable/killable; a TTSR rule aborts a
matching stream, injects its reminder, and the retried turn passes without the rule
firing; a delegation with `output_schema` returns a validated object or a single re-ask;
an `apply_patch` hunk on stale lines is rejected with re-read ranges; post-compaction
context contains an artifact path from which every pruned message is recoverable.
detailed plan produced just-in-time by a /plan subagent at phase start, against the frozen seam.

### Wave 5 — the big bet (rank 10; pathfinder discipline like Wave 0)
LSP diagnostics slice: spawn a locally-installed language server (tsserver/pyright/gopls)
over stdio JSON-RPC (zero deps), collect diagnostics after write/edit/apply_patch, surface
them in the tool result and as gate evidence. Rename/references deferred until the
diagnostics pathfinder proves the client seam. Absent server ⇒ silent no-op (like rg).
*Placeholder acceptance:* an edit introducing a type error surfaces the diagnostic in the
tool result within the same turn, hermetically tested against a stub server.
detailed plan produced just-in-time by a /plan subagent at phase start, against the frozen seam.

### Later / evidence-gated (ranks 11–15)
Image reads (when a routed vision use-case exists) · sub-agent parity (after edit guard
v2) · per-model edit dialect (when telemetry shows a model failing str_replace) · FS scan
cache (when profiling shows re-scan cost) · persistent shell (unmotivated).

## 5. Skip list (reaffirmed + newly closed)

Unchanged from `oh-my-pi-analysis.md`: Rust natives · custom TUI renderer ·
provider/dialect/catalog layer · DAP · model-writable memory · collab relay · browser
automation. Newly closed after this analysis: **structural read summaries** (tree-sitter
violates zero-new-deps; regex outline not worth the fidelity risk) · **internal URL
schemes** (plain artifact file paths already work) · **sub-agent DMs/advisor** (observer
covers it) · **snapcompact / eval kernels / session sharing / commit splitting**
(value doesn't clear the bar for this harness).

## 6. Next step

Per the workflow contract: Linear issues for Wave 3 are created when Wave 3 starts
(tracking granularity = planning granularity), referencing this doc. Wave 3 is small
enough to execute from §4's sketch directly; Waves 4–5 each get their just-in-time /plan
pass first. Status lives in Linear — nothing is checked off here.
