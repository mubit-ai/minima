# Boosting roadmap — tool-layer hardening + oh-my-pi-inspired features

> Written 2026-07-22 on `feat/boosting`. This doc owns the WHY and the SPEC.
> **[Linear owns live status/ownership](https://linear.app/mubit/issue/MUB-188)** — the TODO
> below references issue IDs and never mirrors their state.
>
> Evidence + design detail: [`research/tui-tool-audit.md`](research/tui-tool-audit.md) ·
> [`research/p0-design-rationale.md`](research/p0-design-rationale.md) ·
> [`research/oh-my-pi-analysis.md`](research/oh-my-pi-analysis.md).

## A. Workflow contract

- **Integration branch**: `feat/boosting`, checked out in the dedicated integration worktree
  `minima-boosting` — that worktree is for PR-integration testing only; **no slice
  implementation happens in it**. Each slice gets its own worktree + branch
  (`minima-boost-<slug>` / `feat/boost-<slug>`); every PR targets `feat/boosting`, never
  `main`. It goes to `main` as one reviewed PR when a phase is proven.
- **Gates per PR** (all must be green, independently): `bun test` · `bun run check` ·
  `bun run lint` (run in `packages/tui`).
- **No test, no merge**: every bug fix lands its red→green regression test in the same PR —
  the test must fail against the pre-fix code.
- **Model-agnostic**: tool JSON-schema surface stays unchanged or strictly additive (three
  provider conversions consume it: `anthropic.ts`, `openai_compat.ts`, `google.ts`). Enforced
  in code, not reviewer vigilance — two distinct gates: `tests/unit/test_ts_mirror.py` pins
  the **service** wire mirror (it does NOT cover tool params), and Wave 0 adds
  `packages/tui/tests/tool-schemas.test.ts`, a snapshot pin of every builtin tool's jsonSchema
  that fails loudly on any non-additive change (Wave 1's `include_ignored` lands as a
  deliberate snapshot update).
- **Zero new deps. No code copied from oh-my-pi** (MIT, but policy is reimplement-only; the
  analysis doc is the reference).
- **Tracking**: Linear via MCP. The issues exist (MUB-188 umbrella + MUB-189…194, created
  2026-07-22): an implementing agent updates its own slice issue's status as its PR
  opens/merges; the integrator owns the umbrella and the seam-freeze call. Tracking
  granularity = planning granularity: P1–P4 issues are created at phase start, not before.
- Worktree hygiene: check `git branch --show-current` before every commit (parallel sessions
  can switch the main worktree's branch).

## B. Current state (why this work exists)

Audit of `packages/tui/src/tools/` at 54fcb68 (full detail + file:line in
[`research/tui-tool-audit.md`](research/tui-tool-audit.md)):

1. grep's ripgrep path passes `-n` AND `-N` — **line numbers silently dropped** (last flag
   wins); the description promises `file:line:content`. Fallback `grep -rn` ignores the
   ".gitignore respected" claim.
2. glob caps at 200 **during** scan then sorts the arbitrary subset; no gitignore/node_modules
   filtering; the cap is silent.
3. read loads whole files into memory regardless of offset/limit; no binary/size guard.
4. ls is uncapped, sync, and **crashes on dangling symlinks**.
5. bash output is unbounded; `onUpdate` fires once at completion despite claiming streaming.
6. ls/apply_patch use sync fs (blocks the event loop during parallel tool batches).
7. **grep and glob have ZERO execution-level tests** — root cause of all of the above
   surviving. Fix and tests travel together from here on.

## C. Phase plan (priority = importance × safety × speed)

| Phase | What | Importance | Safety | Speed |
|---|---|---|---|---|
| **P0** Baseline hardening (Wave 0 → Wave 1) | Fix every confirmed tool bug + full regression matrix | critical | high (pure fixes + tests) | fast |
| **P1** Output economics | Spill-to-artifact via the P0 seam: oversized output saved + re-readable, never lost | high | high (additive) | medium |
| **P2** Loop robustness | Bash interceptor, retry classifier, tool-scoped abort placeholders; stretch: TTSR | high | medium (touches loop) | medium |
| **P3** Edit engine | Snapshot tags + seen-lines ledger; stale edits rejected with recovery | high (biggest quality lever) | medium-low (deep change) | slow |
| **P4** Checkpoint/rewind | Deterministic context pruning; DB keeps everything | medium | medium | medium |

## D. P0 — baseline hardening (fully specified)

Per-tool behavioral contracts, the seam API, the ~35-row red→green test matrix, and
risks/rollbacks live in [`research/p0-design-rationale.md`](research/p0-design-rationale.md).
Summary of shape:

- **Seam**: `src/tools/_bounds.ts` (`boundText` / `boundDetails` / `BoundedBuffer`,
  standardized truncation notices, `SpillSink` hook for P1) + `src/tools/_rg.ts` (cached
  `Bun.which("rg")` + `rgCmd` test seam).
- **grep**: line numbers restored, deterministic order, honest description, fallback
  exclusions, partial results on exit 2 ([MUB-189](https://linear.app/mubit/issue/MUB-189)).
- **glob**: `rg --files` + `Bun.Glob.match` hybrid, gitignore/node_modules filtering with
  additive `include_ignored`, sort-before-cap ([MUB-190](https://linear.app/mubit/issue/MUB-190)).
- **read**: streaming window reads, binary/image guards, size backstops
  ([MUB-191](https://linear.app/mubit/issue/MUB-191)).
- **ls**: async, symlink-resilient, capped ([MUB-192](https://linear.app/mubit/issue/MUB-192)).
- **bash**: bounded head+tail output, real throttled streaming, partial output on timeout
  ([MUB-193](https://linear.app/mubit/issue/MUB-193)).
- **apply_patch**: async IO edges, `parsePatch` stays sync
  ([MUB-194](https://linear.app/mubit/issue/MUB-194)).

### Wave slicing — pathfinder, not blind fan-out

- **Wave 0 — ONE PR `feat/boost-p0-seam-grep`** (MUB-189): the seam **plus grep as its first
  real consumer**. Grep stress-tests the seam before it freezes. Tests-red commit first.
- **Seam-freeze gate** — owner: the integrator on `feat/boosting`. Criterion: grep's PR is
  green AND the seam's public signatures (`boundText`/`boundDetails`/`BoundedBuffer`/
  `resolveRg`) survive one review cycle unchanged. **Failure path**: if grep forces a
  signature change, the seam goes back for re-review and Wave 1 does not start until it
  passes again.
- **Wave 1 — only after Wave 0 merges**: one-agent-per-file fan-out (MUB-190…194), each PR
  with its own red→green tests. **Branch base + merge order**: each Wave-1 branch forks from
  `feat/boosting` AFTER Wave 0 merges; PRs merge one at a time; later branches rebase on the
  updated `feat/boosting` before merging.
- Rationale: **never fan out onto an interface until one real consumer has stress-tested it.**

## E. P1–P4 sketches (deliberately thin — two-tier plan depth)

**Hard rule: each feature's planning pass must produce testable acceptance criteria + verify
commands (gate-backed, red→green) before any implementing agent starts. Plan-then-build,
never build-then-check.** The feature's Linear issue is created at phase start, alongside its
plan.

- **P1 — Output economics.** Wire an artifact store into the seam's `SpillSink`: truncated
  output is content-addressed to files under the session dir with a SQLite index, and the
  truncation notice names the ref so the model can page it back via normal `read` — output is
  never simply lost. Placeholder acceptance criterion: a bash command producing 1MB of output
  yields a bounded body + a ref that `read` can page through hermetically. *Detailed plan
  produced just-in-time by a /plan subagent at phase start, against the frozen seam.*
- **P2 — Loop robustness.** A bash-interceptor rule table in the dispatcher (enforcement in
  the dispatcher, never prompt text) steering `cat/head/tail/grep/find/sed -i` to native
  tools; a retry classifier that never replays a turn that emitted observable output;
  tool-scoped abort placeholders. Stretch: TTSR-style stream tripwires. Placeholder acceptance
  criterion: `bash("grep foo src/")` is blocked with a steer message while a plain
  `bash("make test")` passes untouched, proven by hook-level tests. *Detailed plan produced
  just-in-time by a /plan subagent at phase start, against the frozen seam.*
- **P3 — Edit engine.** Read/grep output stamped with a short content-hash snapshot tag; a
  seen-lines ledger in SQLite (state in the DB, projection in the context); edits touching
  unseen or stale lines rejected with a "re-read these ranges" recovery message; hermetic
  before/after edit benchmark gates the rollout. No tree-sitter. Placeholder acceptance
  criterion: an edit against a file modified since last read is rejected with a recovery
  message naming the stale ranges, and the benchmark shows no regression in edit success.
  *Detailed plan produced just-in-time by a /plan subagent at phase start, against the frozen
  seam.*
- **P4 — Checkpoint/rewind.** A `checkpoint`/`rewind(report)` tool pair: exploration tool
  spam is pruned from the projected context on rewind, keeping only the report; the DB keeps
  the full transcript. Placeholder acceptance criterion: after a rewind, the projected context
  contains the report but none of the intermediate tool results, while the ledger retains all
  of them. *Detailed plan produced just-in-time by a /plan subagent at phase start, against
  the frozen seam.*

## F. TODO (execution order, references only)

Status lives in Linear — nothing is checked off here.

1. Wave 0 — seam + grep pathfinder → [MUB-189](https://linear.app/mubit/issue/MUB-189)
2. Wave 1 — glob → [MUB-190](https://linear.app/mubit/issue/MUB-190)
3. Wave 1 — read → [MUB-191](https://linear.app/mubit/issue/MUB-191)
4. Wave 1 — ls → [MUB-192](https://linear.app/mubit/issue/MUB-192)
5. Wave 1 — bash → [MUB-193](https://linear.app/mubit/issue/MUB-193)
6. Wave 1 — apply_patch → [MUB-194](https://linear.app/mubit/issue/MUB-194)
7. P1 planning pass (issue + /plan at phase start) → then P2 → P3 → P4

Umbrella: [MUB-188](https://linear.app/mubit/issue/MUB-188).
