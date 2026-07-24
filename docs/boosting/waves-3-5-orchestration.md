# Waves 3–5 orchestration guide — parallel subagent execution playbook

> Written 2026-07-24. Audience: (1) the human owner, who reads this first; (2) an
> orchestrator agent in a fresh session, who executes it. Feature content comes from
> `research/next-features-analysis.md`; live status lives in Linear (MUB-199…208 under
> umbrella MUB-188) — this doc never mirrors issue state. The playbook below is the one
> that already shipped Waves 0–2 (P0–P4), refined by what went wrong and right there.

## 1. How to use this doc

Hand it to an orchestrator agent with an instruction like: "Execute Wave 3 of
`docs/boosting/waves-3-5-orchestration.md`. Report before merging anything." One wave at
a time — do NOT start Wave 4 while Wave 3 PRs are unmerged. The orchestrator coordinates;
implementation happens in per-slice worktrees by subagents with self-contained briefs.

## 2. Ground rules (non-negotiable, from `boosting-roadmap.md` §A)

1. **PRs target `feat/boosting`, NEVER `main`.** The integration branch is where the
   owner integration-tests; main gets one consolidated PR later.
2. **One worktree + branch per slice** (`minima-boost-<slug>` / `feat/boost-<slug>`).
   The integration worktree `/Users/eldaru/Mubit/Minima/minima-boosting` is for
   PR-testing and merges only — no slice implementation there. The MAIN worktree
   (`/Users/eldaru/Mubit/Minima/minima`) is never touched — don't switch its branch,
   don't build in it. *Why: parallel sessions switching the main worktree's branch has
   corrupted work before.*
3. **No test, no merge.** Every slice lands its red→green regression tests in the same
   PR, and the red state is PROVEN (see §6 step V3), not assumed.
4. **Reimplement only.** Zero new deps, zero code copied from oh-my-pi (MIT reference
   only). Patterns are reimplemented against minima's own architecture.
5. **Model-agnostic.** Tool JSON-schema surface unchanged or strictly additive. Any
   schema change = regenerate `packages/tui/tests/__snapshots__/tool-schemas.test.ts.snap`
   with `bun test -u` style regeneration — NEVER hand-edit, never hand-merge on conflict.
6. **Append-only migrations.** Shipped batch strings are never edited. New migration
   numbers are RESERVED by the orchestrator (see §5) so parallel slices can't collide.
7. **Plan-then-build.** Wave 4 and Wave 5 slices each get a just-in-time `/plan` pass
   producing testable acceptance criteria + gate-backed verify commands, committed to
   `feat/boosting` BEFORE the implementation worktree forks. Wave 3 is small enough to
   run from its Linear issue bodies directly.
8. **Linear is the status home.** Orchestrator updates MUB-199…208 via MCP as PRs
   open/merge. If Linear MCP is unavailable in the session, say so — don't silently skip.

## 3. The map

| Wave | Slice | Issue | Branch | Plan pass? |
|---|---|---|---|---|
| 3 | SSRF guard for web_fetch/DDG | MUB-199 | `feat/boost-w3-ssrf` | no |
| 3 | CI hygiene (rg, lint, feat/boosting PRs) | MUB-200 | `feat/boost-w3-ci` | no |
| 3 | Artifact GC | MUB-201 | `feat/boost-w3-artifact-gc` | no |
| 3 | cd-extraction + steer v2 | MUB-202 | `feat/boost-w3-steer2` | no |
| 4 | Background bash jobs | MUB-203 | `feat/boost-w4-bgjobs` | YES |
| 4 | TTSR stream tripwires | MUB-204 | `feat/boost-w4-ttsr` | YES |
| 4 | Typed sub-agent outputs | MUB-205 | `feat/boost-w4-typed-task` | YES |
| 4 | Edit guard v2 | MUB-206 | `feat/boost-w4-editguard2` | YES |
| 4 | Compaction v2 | MUB-207 | `feat/boost-w4-compact2` | YES |
| 5 | LSP diagnostics pathfinder | MUB-208 | `feat/boost-w5-lsp` | YES |

Dependencies (also encoded as Linear blocking relations):

```
Wave 3 (parallel: 199 | 200 | 201 | 202)
  merge order: 200 (CI) FIRST, then 199/201/202 in any order
        |
        v   (all four merged)
Wave 4 (plan passes first, then parallel: 203 | 204 | 205 | 206 | 207)
  merge order: 205 -> 203 -> 204 -> 206 -> 207   (see §7 Wave 4)
        |
        v   (all five merged)
Wave 5 (single pathfinder PR: 208, Wave-0 discipline)
```

Why waves gate each other: Wave 3's CI fix (MUB-200) makes every later PR's gates
trustworthy (today rg-gated tests silently SKIP in CI); W4.5 consumes W3.3's GC policy;
W5 touches `apply_patch` results after W4.4 rewires them. Forking Wave N+1 before Wave N
merges would also force every branch to rebase over every merge — churn with no upside.

## 4. Topology and setup commands

All slice worktrees fork from the CURRENT tip of `feat/boosting`, created serially by the
orchestrator (never let two agents create worktrees concurrently):

```bash
cd /Users/eldaru/Mubit/Minima/minima-boosting
git branch --show-current            # MUST print feat/boosting
git pull --ff-only origin feat/boosting
git worktree add /Users/eldaru/Mubit/Minima/minima-boost-w3-ssrf -b feat/boost-w3-ssrf feat/boosting
# ...one per slice in the current wave
```

Per-worktree bootstrap (every fresh worktree, before anything else):

```bash
cd <worktree>/packages/tui && bun install
```

*Why: a fresh worktree without `bun install` fails ~22 rendering tests on missing
`cli-truncate` — that is NOT a regression signal. Also verify `Bun.which("rg")` is
non-null locally (`command -v rg` — the shim in some agent shells doesn't count; if
missing: `brew install ripgrep`), otherwise rg-gated tests silently skip and the slice
ships unverified engine paths.*

Gates, run from `packages/tui`, all three required:

```bash
bun test && bun run check && bun run lint
```

## 5. Parallel-safety rules (what makes the fan-out safe)

- **Write-set declaration.** Before implementation starts, each slice declares the exact
  files it will touch (Wave 4: in a committed `wave4-preflight.md`, same pattern as
  `wave2-preflight.md`; Wave 3: the issue bodies already name them). The orchestrator
  audits `git diff --stat <base>...HEAD` against the declaration before merging — an
  undeclared file is a stop-and-explain, not a shrug.
- **Known collision pairs.** W4.1 (bgjobs) and W4.2 (TTSR) both touch
  `src/agent/loop.ts` — their plan passes must partition the file (e.g. tool-dispatch
  region vs stream region) or serialize the two slices. W4.5 (compaction v2) consumes
  `_artifacts.ts` (P1, frozen surface) and W3.3's GC — consume-only, no signature edits.
- **Migration reservation.** DB is at v21 (seen_lines). If any Wave-4 slice needs a
  migration (expected: only W4.1, and only if it adds a jobs table), the orchestrator
  assigns the next number at plan time and records it in the preflight doc. Two slices
  must never both claim v22. Migrations are append-only — never renumber someone else's.
- **Schema snapshot.** Slices that add tool params (W4.1, W4.3) will conflict on
  `tool-schemas.test.ts.snap` in the merge train. Resolution is always: take the merged
  code, REGENERATE the snapshot, re-run gates. Never hand-merge snapshot hunks.
- **Worktree hazard.** Every agent, before EVERY commit: `git branch --show-current`
  must print its own slice branch. Sub-agent worktrees under `/tmp/minima-wt-*` (from
  task-tool tests) are disposable; slice worktrees are not.
- **Env-flag isolation.** Every Wave-4 feature ships behind its own env flag (pattern:
  `MINIMA_TUI_<FEATURE>`, default per plan pass) with the flag-off path byte-identical —
  that is what makes parallel merges low-risk to the running product.

## 6. The orchestration loop (per wave)

**O1 — Preflight.** Confirm `feat/boosting` clean + pulled; confirm the wave's blockers
are merged (Linear); for Wave 4/5, run the plan passes (§7) and get the owner's approval
on the committed plan docs BEFORE forking anything.

**O2 — Fork.** Create all slice worktrees serially off the same tip (§4). Record the
base SHA — it is the red-proof and audit baseline.

**O3 — Brief.** Launch one implementation agent per slice with a SELF-CONTAINED brief:
the Linear issue body, the plan doc path (Wave 4/5), the worktree path, the base SHA, the
declared write-set, the gates command, and the rules: tests-red commit first, no files
outside the write-set, `git branch --show-current` before every commit, no comments
unless asked, never commit `.env*`. Agents do not talk to each other; collisions were
resolved at plan time.

**O4 — Verify each slice (orchestrator, in the slice worktree; trust nothing).**
- V1 gates: re-run `bun test && bun run check && bun run lint` yourself.
- V2 write-set audit: `git diff --stat <base>...HEAD` — every file declared.
- V3 red-proof: create a scratch worktree at the base SHA, `bun install`, copy the
  slice's NEW TEST FILES ONLY into it, run them — they MUST fail. Then delete the
  scratch worktree. (Do NOT use `git checkout <base> -- src/` inside the slice worktree:
  it is unsound for DB-backed features and dirties the tree — Wave 2 lesson.)
- V4 doctrine spot-check: flag-off path unchanged; schema snapshot changes deliberate;
  no new deps in `package.json`; migrations append-only.

**O5 — Merge train (serial, in the integration worktree).** For each PR in the wave's
merge order: rebase the branch on current `feat/boosting`, re-run all gates post-rebase,
regenerate the schema snapshot if it conflicted, merge, update the Linear issue. Then the
next branch rebases on the NEW tip. One at a time — never merge two PRs between gate runs.

**O6 — Cleanup.** After the wave fully merges: delete slice worktrees
(`git worktree remove <path>`) and branches (local + origin), verify
`git worktree list` shows only main + minima-boosting, update Linear, and report: what
merged (SHAs), what was deferred, any write-set violations found, any seam decisions the
next wave inherits.

**Owner checkpoints (recommended, matches Wave 2):** after O1's plan passes (approve
plans), and after O4/before O5 (approve the merge train). The orchestrator should pause
and report at both points rather than merging autonomously.

## 7. Wave-specific notes

### Wave 3 — no plan passes, 4 parallel worktrees, ~1 day shape
Issue bodies are the spec. Merge order: **MUB-200 (CI) first** — then re-run the other
three slices' CI against the fixed pipeline before merging them. MUB-199's local-listener
test must prove *no connection was made* (assert the listener never accepted, not just
that an error string came back). MUB-202 must keep the metachar conservatism: the ONLY
new parse is `cd <path> && <simple command>`.

### Wave 4 — plan passes first, then 5-way fan-out
1. Run 5 `/plan` passes producing `docs/boosting/w4-<slug>-plan.md` each (scope,
   write-set, acceptance criteria, verify commands, env flag, migration need yes/no).
   Sequence the W4.1 and W4.2 plans back-to-back so they explicitly partition
   `src/agent/loop.ts`; the other three can plan in parallel.
2. Author `docs/boosting/wave4-preflight.md`: consolidated write-set matrix, collision
   resolutions, migration reservation, merge order. Commit plans + preflight to
   `feat/boosting`, get owner approval, THEN fork.
3. Merge order: **MUB-205 (typed-task, isolated) → MUB-203 (bgjobs) → MUB-204 (TTSR,
   rebases over bgjobs' loop.ts changes) → MUB-206 (editguard2) → MUB-207 (compact2,
   last — it consumes the most surfaces).**
4. TTSR accounting decision (double-booking meter/budget on retry) and bgjobs orphan
   policy are the two plan-time decisions most likely to need owner input — surface them
   at the O1 checkpoint.

### Wave 5 — one pathfinder PR, Wave-0 discipline
Single slice, single worktree. The `/plan` pass must pin the client seam's public
signatures; after merge, the seam gets one review cycle (like Wave 0's seam freeze)
before any follow-up LSP ops are even planned. Hermetic tests speak to a scripted stub
server — a real tsserver/pyright must never be a test dependency.

## 8. Done means

All ten issues Done in Linear · `feat/boosting` green (`bun test`, `check`, `lint`) with
every feature flag on AND off · no stray worktrees/branches · a closing report naming:
merged SHAs, the flags added, migration numbers consumed, and the candidate list for the
eventual consolidated `feat/boosting → main` PR (which also carries the CI workflow
changes from MUB-200 into main's workflow files).
