# Changelog

All notable changes to Minima are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Removed
- **Big Plan compat window closed** (TUI, #243 + #212): the one-release aliases shipped
  in 0.13.2 are removed — `/gt`/`/gt-seed` commands, the `MINIMA_TUI_GROUND_TRUTH` env
  fallback, the `config.groundTruth` input/read alias, the deprecated API delegate
  exports (`groundTruthHooks`, `synthesizeGroundTruth`, `attachGroundedOutcome`,
  `groundedOutcomeFor`, `stampGroundedOutcome`, …), and the `gt_*` dual-writes
  (columns remain, read-only).

### Fixed
- **Stream inactivity watchdog + spinner backpressure guard** (TUI): a turn whose model
  stream went silent kept `busy` pinned forever while the 8 fps spinner pumped frames
  into a possibly non-draining stdout — overnight this grew RSS without bound until
  macOS jetsam OOM (observed at 43 GB). Streams now abort after
  `MINIMA_STREAM_IDLE_TIMEOUT_MS` (default 5 min; 0 disables) with a clear transcript
  error distinct from Esc; the recommender client's dead `timeoutMs` is wired into
  every request; and the busy spinner skips ticks while stdout's write buffer needs
  drain.
- **Legacy-row skew in plan-verification reads** (TUI, #212): rows stamped only with
  `gt_*` columns by pre-rename binaries no longer vanish once dual-writes stop — the
  judge/gate disagreement query (the scribe's feed) and run rehydration fall back via
  `COALESCE(big_plan_outcome, gt_outcome)`.

## [0.13.2] - 2026-07-21

### Changed
- **Ground Truth is now Big Plan** (TUI, #198 via #208): the verification spine's
  user-facing surface is renamed — `/bp` + `/bp-seed` commands (Plan Overview on
  Ctrl+G), `MINIMA_TUI_BIG_PLAN` env flag, `BigPlan.md` plan artifact,
  `config.bigPlan`, and `big_plan_*` DB columns (append-only migration v14 with
  backfill). One-release compatibility window: `/gt`/`/gt-seed`,
  `MINIMA_TUI_GROUND_TRUTH`, `config.groundTruth`, and the deprecated API exports
  keep working, and the old `gt_*` columns are dual-written. The wire contract is
  unchanged (`evidence_source="gate"` et al.). A terminology guard in
  `bun run check` keeps the rename from regressing.
- **Docs follow-through** (#209): CLAUDE.md, repo architecture docs, and the
  docs-site updated to the Big Plan surface (deployed with this release so docs
  match installed binaries).

### Fixed
- **Enforce-mode footer overflow** (TUI, #206 via #208): the `⛔` badge could
  render the footer row one cell wider than the terminal (three disagreeing
  Unicode width tables in Ink's pipeline), autowrapping it and drift-looping the
  frame. Fixed at the dependency-resolution level (`slice-ansi`/
  `is-fullwidth-code-point` overrides + a committed `cli-truncate` patch) with
  regression coverage for every footer emoji at 80–160 columns.
## [0.13.1] - 2026-07-21

### Fixed
- **Plan-mode fallback pool** (TUI, #204): plan mode's premium model-pool
  restriction only covered the council path — with `MINIMA_TUI_GROUND_TRUTH=0`
  (or a failed council setup) plan-mode turns ran the normal loop over the full
  candidate pool, so a cheap/small model could end up doing the planning. The
  sessionless fallback now routes with the same premium hard pool +
  `phase:plan` tag as the council's planner turn, with the same loud failure
  when the policy is active but no premium model is runnable. The restriction
  is now a property of the mode, not of the council.

## [0.13.0] - 2026-07-21

The Mubit reinforcement train: mubit-sdk 0.13.0 adopted end to end, every free
signal on the memory wire put to work, and the ground-truth spine's per-step gate
verdicts start feeding Mubit as process rewards (PRs #192–#197).

### Added
- **Per-step process rewards** (server + harness, #195): the harness's red→green
  gate verdicts now ride `POST /v1/feedback` as `step_outcomes[]` and relay to
  Mubit's `record_step_outcome` — finer-grained reflection attribution and the raw
  material for server-side workflow induction (procedural memory). Feedback truth
  applies per step: deterministic/user verdicts only (judge gates excluded),
  verified/failed only, relayed even on unlabeled turns (steps carry their own
  provenance), capped at 32, duplicate-feedback check doubles as replay dedup.
  Response gains `step_outcomes_recorded`.
- **`POST /v1/diagnose` + `GET /v1/memory/health`** (server, #196): Mubit
  introspection relays — failure lessons matching an error, and a per-namespace
  memory-hygiene report (stale entries, contradictions, low-confidence counts,
  promotion candidates). Both degrade to `memory_unavailable` instead of 500ing.
  Full client parity (Python sync/async, TS SDK, TUI).
- **Recovery-ladder memory brief** (TUI, #196): the replan rung asks `/v1/diagnose`
  for "here's how this failed before" and injects matched lessons into the retry
  preamble, next to the E2 local diagnostics. Fail-open.
- **Drift + retrieval signals surfaced** (server, #193): Mubit DriftMonitor flags
  riding every recall now emit `memory_drift:repeated` / `memory_drift:stagnant`
  diagnostics, and the server's recall confidence feeds escalation as
  `low_recall_confidence` (only when reported — absence is not a signal).
- **Sampled retrieval observability** (server, #194): `MINIMA_RECALL_EXPLAIN_SAMPLE`
  requests Mubit's per-evidence fusion-score breakdown on a sampled fraction of
  recalls and logs it as `recall_explain` — the "why did memory rank this" tool.

### Fixed
- **Dereference now shares the recall budget** (server, #193): it was the one read
  path with no timeout budget — a hung Mubit could stall a recommend for the full
  30s client timeout.
- **Supersession folds into staleness** (server, #193): a `superseded_by` entry is
  treated as stale even when the `is_stale` flag lags the supersession write.

### Changed
- **mubit-sdk ≥ 0.13.0** (#192): the v0.12.3 keyed-lookup transport shim is deleted
  in favor of the now-public `Client.lookup`; the TUI's `@mubit-ai/sdk` moves to
  `^0.13.0` (transport retries now real). All remaining private `_control` handle
  uses replaced with the typed surface (#194) — recall knobs and `record_outcome`
  idempotency are first-class SDK parameters now.
- **Bi-temporal outcome writes** (server, #194): `remember_outcome` passes
  `occurrence_time` (observation time, not async-ingest landing time). Seeds are
  deliberately NOT backdated — the seed-vs-live weighting design stands.
- **Harness memory lane partition** (TUI, #197): harness trace writes stamp
  `lane=harness`, keeping them explicitly partitioned from the server's typed
  outcome records. Recall stays unfiltered until unlaned data ages out.
- Dead `MubitMemory.get_context` surface removed (#193); recall-precision knobs
  (`entry_types`, `rank_by`, `budget`, `max_age_days`, `explain_sample`) documented
  in `docs/configuration.md` (#194).

## [0.12.4] - 2026-07-21

### Fixed
- **Inline render stability — the anchor ledger** (TUI, #187): the composer stays
  bottom-anchored and Ink can no longer strand or wipe rows. An explicit capped
  live-frame height makes strand + wipe structurally impossible; inherited scroll
  margins (a leaked DECSTBM region surviving clear/resize) are reset at boot; empty
  markdown lines no longer collapse to zero rows. Backed by new PTY regression gates
  (anchor-ledger repro matrix, mid-run resize, stale-margin asserts).
- **PTY-suite hermeticity** (#187): a blank `MUBIT_API_KEY` kills a live
  recall-before-route stall inside the "hermetic" suite — root cause of the historic
  ~50%/run flake.

### Added
- **Shift+Tab mode ring with Claude Code permission parity** (TUI, #187): a silent,
  global mode cycle (build → accept-edits → plan) that works mid-run and over the
  permission overlay. Plan mode denies write/edit/bash at the dispatcher (new
  `mode-deny` guard event), the exit-plan gate gains a 4-option landing, accept-edits
  auto-approval is cwd-scoped, and `[a]` on a bash prompt becomes a persisted
  per-command-family grant. Mode-aware permissions footer; gate blocks render as
  `⊘ verify gate` instead of a red denial.
- **Premium plan routing** (TUI, #187): plan mode decides on premium models only — a
  hard pre-request candidate pin (`constraints.candidate_models` + `phase:plan` tag)
  that never silently widens; premium finalize/turn cost is booked like any other.
- **Honest Mubit-error taxonomy** (server, #132): the memory layer's bare
  `except Exception` no longer collapses every failure into `memory_unavailable` /
  `memory_write_failed`. Mubit SDK errors map to class-specific warnings
  (`memory_auth_failed`, `memory_rejected_payload`, `memory_unsupported`,
  `memory_server_error`, `memory_unreachable`), and non-Mubit exceptions are labeled
  `memory_write_bug` / `memory_recall_bug` so a local bug is never disguised as an
  outage. Logs carry `error_type` alongside the label.

### Changed
- `uv.lock` refreshed to record the current project version (#190) — the 0.12.2/0.12.3
  bumps had left it stale at 0.12.1.

## [0.12.3] - 2026-07-21

### Fixed
- **Keyed lookup no longer depends on an unreleased SDK method** (server): every prod
  recommend logged `keyed_lookup_degraded` because the adapter called
  `self._client.lookup`, which does not exist in released `mubit-sdk` (0.10.0) — the
  deterministic per-(cluster, model) evidence channel never left the process. A new
  `_client_lookup` shim prefers a native `Client.lookup` when present and otherwise
  drives the `core.lookup` op through the SDK's transport engine (same endpoint, key,
  and error handling as generated methods). Verified against a pristine 0.10.0 install
  and live against a dev Mubit instance.

### Added
- **Venv integrity check**: `scripts/verify_venv_integrity.py` re-hashes every installed
  file against its wheel RECORD and fails on mismatch; runs first in `make test` and as
  a CI step. Guards against hand-patched site-packages masking prod-only failures —
  exactly how the keyed-lookup bug stayed invisible locally.

## [0.12.2] - 2026-07-20

The memory spine: the SQLite ledger starts feeding decisions. Ten PRs across the
harness and server (#175–#184) — curated cross-session memory, a background
curator, recall track records on server memory, and the durable-execution +
verification upgrades.

### Added
- **Memory ledger** (harness, default ON — `MINIMA_TUI_MEMORY=0` opts out; migration
  v12): curated per-repo memories (`note`/`workflow`/`lesson`/`guardrail`) projected
  into each turn's system prompt (hard-capped, pinned > gate-cited > recency; every
  distinct injection audited so "what the model saw" is replayable). Managed via
  `/memory` (list · add · dream · pin/confirm/reject/delete = bi-temporal invalidate).
  The model has no memory-write tool (Letta split).
- **Memory scribe**: the sole automated memory writer — signals mined from the ledger
  (gate flips, verified failures, user corrections, judge/gate disagreements — never
  the transcript), recurrence-gated, one extraction call routed through Minima
  (`tags=["memory:extract"]`, spend booked like judge spend), mem0-style
  reconciliation (rejected rows never resurrected), provenance activation (only
  gate-cited candidates auto-activate). Runs as crash-safe persisted jobs.
- **Memory dream** (`/memory dream`): deterministic offline consolidation — only
  green-gated closed plans distill into `workflow` candidates (always pending, never
  mutates existing rows). Confirmed workflows enable **replay-with-cheap**: matching
  prompts route with `tags=["procedure:known"]` so Thompson learns the cheaper
  frontier for known-procedure work organically.
- **Recall track** (server, schema v5): every trusted-label feedback casts a vote on
  the durable records recalled into that decision; bad-track records are down-weighted
  (floor 0.25) and eventually tombstoned (`invalidated_at`, never deleted;
  `recall_invalidated_skipped:<n>` recommend warning). `MINIMA_RECALL_VOTE_MIN_N` /
  `MINIMA_RECALL_INVALIDATE_RATE`.
- **Planning critic** (advisory, at `/plan` finalize) + **zero-context diff reviewer**
  (at plan closure; an objection can yellow the plan tier, never green it).
  `MINIMA_TUI_PLAN_CRITIC=0` / `MINIMA_TUI_DIFF_REVIEW=0` opt out.
- **Auto-gates**: repo manifests mined for trusted-by-construction check commands at
  `/plan` finalize — fast command (typecheck/lint) on verify-less steps, full test
  suite on the final step. `MINIMA_TUI_AUTO_GATES=0` opts out.
- **Version stamps + blob tier** (migration v13): decisions/gates record
  `harness_version` + a toolset hash (resume warns on skew, never blocks); >16KB tool
  results spill to content-addressed blob files.
- **Resume re-verify**: resuming re-runs the in-progress step's verify against its
  recorded baseline (consent-gated) — divergence re-baselines from reality with a 🟡
  banner; the resumed run's provider session id is reused for prompt-cache continuity.
- **Ladder v2**: named rung states (`retry_step`/`revise_step`/`replan`) on recovery
  gates + feedback notes; repeated verified failures unlock full failing-check output
  in the retry prompt.
- **Honest meter**: KV-cache hit rate and cost-of-pass (labeled successes only, with
  coverage disclosure) in `/cost`.

## [0.12.1] - 2026-07-20

SDK integrity + a standalone TypeScript SDK. Server wire contract unchanged; all
changes are client-side and release-pipeline hardening.

### Added
- **`@mubit-ai/minima-sdk`** (`packages/sdk`) — a standalone TypeScript SDK: pure-fetch
  typed `/v1/*` client with zero runtime dependencies (Node 18+/Deno/Bun/edge), full
  surface including `policyValue()`, typed feedback options, transparent feedback
  retries, and rate-limit-aware errors. Its schema mirror is pinned against the
  Pydantic source of truth alongside the TUI's.
- Python SDK: `capabilities()` and `policy_value()` (the doubly-robust
  regret-vs-oracle report) on both clients; `recommend()` gains `incumbent_model_id`,
  `max_candidates`, and `phase=` (rides as the `phase:<v>` tag); `feedback()` gains
  typed named params (`quality_score`, `evidence_source`, `error_cause`,
  `chosen_effort`, `iterations`); `x-minima-client`/`User-Agent` headers; feedback
  retries with backoff on transient faults (safe under the reconcile replay guard —
  recommend stays fail-fast); `MinimaRateLimited(retry_after)` and
  `MinimaUnavailable` error subtypes.
- OpenHands adapter closes the loop: realized cost/tokens/latency auto-reported as
  `evidence_source="none"` telemetry off the selected LLM's metrics, fire-and-forget;
  `minima_timeout` (default 5 s) bounds the hot-path recommend.

### Fixed
- **LiteLLM logger graded outcomes**: quality now maps by the loop thresholds
  (≥ 0.8 success / ≥ 0.4 partial / else **failure** with `error_cause="quality"`) —
  previously a judged-bad response could never be labeled a failure.
- LiteLLM feedback calls run off the event loop (`asyncio.to_thread`) instead of
  blocking the caller's async app for up to the client timeout per completion.
- LiteLLM recommendation→completion correlation is exact under concurrent identical
  prompts (`rec_id` carried in-band via request metadata; hash join kept as fallback).
- `Usage` distinguishes "not measured" (`None`) from a real zero — 0 tokens / $0.00
  are reported instead of dropped.
- `minima-route feedback --source` defaults to `none` — scripted feedback no longer
  claims human-asserted provenance by default.
- The dead `allow_llm_escalation` parameter is removed from both Python clients (the
  reasoner it fed was deleted in 0.11.0).
- Release pipeline: the Homebrew formula now pushes directly to the tap on release
  (formula PRs previously sat unmerged — brew served 0.10.0 while 0.11.0/0.12.0
  shipped) with a serves-the-released-version verification step; the nightly catalog
  snapshot fails loudly when it cannot open its refresh PR instead of reporting green.

## [0.12.0] - 2026-07-20

The Big Plan harness: the TUI's plan workflow grows verification teeth, and the
renderer goes inline-only. A TUI/harness release — the server wire contract is
unchanged from 0.11.0.

### Changed
- **Inline is the only renderer** — the fullscreen mode and docked sidebar are
  deleted. Claude-Code-style inline panels replace them: hard-wrapped markdown with
  verbatim code fences, a shared line classifier so the render, the height
  estimate, and the panel reader can never disagree, and a stream-reseat fix so the
  composer no longer strands mid-screen after a tall streamed reply commits.
- **The plan workflow is enforced, not suggested** (ground truth is on by default,
  `MINIMA_TUI_GROUND_TRUTH=0` opts out): plan steps carry `verify` shell commands;
  a step can't be marked done while its check fails (red→green vs a captured
  baseline); doom-loop and step-cap guards break spirals
  (`MINIMA_TUI_STOP_STRIKES` / `MINIMA_TUI_SPIRAL_REPEATS` / `MINIMA_TUI_STEP_CAP`);
  confidence tiers drive the UI (🟢 glide / 🟡 flag / 🔴 stop-and-ask); gate
  verdicts are graded into outcome labels by tier (`MINIMA_TUI_GRADED_OUTCOME=0`
  for the binary rule) while `evidence_source="gate"` stays green-tier-only.
- **BREAKING: verify commands require consent.** Model-authored `verify` commands
  are shown and approved before they execute — approval is session-only and a
  mutated command re-prompts. Headless `-p` runs **fail closed** (gates go
  unrunnable) unless `MINIMA_TUI_ALLOW_VERIFY=1` is set.
- **Shift+Tab cycles primary agents** — Build → accept-edits → Plan; plan mode
  asks first on write/edit/bash and blocks todowrite/task, with a universal exit
  gate so finalized ground truth is the way out of a plan conversation.
- The plan council convenes in parallel and only on substantive turns (follow-up
  plan turns ~5× faster), with a live progress line and a plan-draft view.
- Fullscreen defaults to selection-first mouse — native select/copy works out of
  the box.

### Added
- **Named sessions and `--resume`** (by name or id), with the context status line
  restored on resume.
- **Git-shadow checkpoints, `/undo`, and `/rewind`** — per-run snapshots under
  `refs/minima/ckpt/…` with byte-identical restore, rewind markers on the SQLite
  events spine, and a turn picker with conversation/code/both restore modes.
- **Session usage ledger** with per-turn `{model, tokens, cost}`, a
  table-of-contents overlay (**Ctrl+T**) with per-section cost, a ground-truth plan
  overview (**Ctrl+G**) with per-step cost and tiers, and `/why` verification views
  backed by the same surface.
- A mid-run tasks footer (**Ctrl+B** toggles, hide persists across sessions).
- A PTY invariant suite (`make tui-verify`) — 18 scripted terminal scenarios
  asserting echo latency, zero scrollback wipes, no alt-screen/mouse-capture
  leaks, bottom-anchored composer, render budgets, and the plan/consent flows.

### Fixed
- Prompt-echo latency, scrolling and text-selection, and input-stability issues in
  the inline TUI.
- The permission overlay keyed preview rows by content prefix, collapsing
  same-prefix verify commands (duplicate React keys could drop rows on the one
  surface that must show every shell command before approval); rows are keyed by
  position now.
- `todowrite` accepts an unencoded array argument instead of failing on
  `JSON.parse`.
- The tool-body height ruler measured at the old fullscreen interior width while
  the inline renderer paints full-width — the 1-row over-reserve floated the
  composer off the terminal bottom when a plan-mode notice committed.

## [0.11.0] - 2026-07-16

The learning-loop rework: honest labels in, fabricated ones out, and a posterior
that actually accumulates. Verified end-to-end against Mubit v0.12.0 (locally
built and the deployed instance) before release.

### Changed
- **Truth rule across the wire** — quality is nullable everywhere; feedback carries
  `evidence_source` (`gate` | `judge` | `human` | `none`) as the provenance of the
  quality signal (the legacy `judged`/`verified_in_production` flags still map);
  unlabeled turns and infra failures (`error_cause="infra"`) are cost/latency
  telemetry only — they never touch the success aggregate, reinforcement, or
  calibration. The fabricated 0.9-quality default is gone.
- **Ground truth and honest labels are the default** — the GT verification spine is
  ON (`MINIMA_TUI_GROUND_TRUTH=0` opts out); green gate verdicts are the label
  source for gated turns, a sampled LLM judge (`MINIMA_JUDGE_SAMPLE`, default 15%)
  labels a slice of the rest, and judge spend stays booked to the session wallet.
- **Accumulating evidence** — the durable (cluster, model) record is a
  read-modify-write upsert carrying outcome counters and sample rings, so organic
  evidence no longer caps at n≈1 and one failure can't erase history. Recall embeds
  the same gist text the write path stores, and a budgeted keyed lookup
  (`/v2/core/lookup`, `evidence_only` recall) gives an exact-match evidence channel
  (pairs with Mubit v0.12.0, now live).
- **Thompson sampling is the default selection policy** — calibrated posterior
  sampling with a capped explore share (`minima_selection_policy=argmin` or
  `minima_argmin_orgs` opt out). The selection zoo (collapse guard, epsilon,
  exploration bonus, shadow UCB, evidence-mass IPW) is deleted, and
  `GET /v1/policy-value` reports doubly-robust regret-vs-oracle.
- **Benchmark-derived catalog priors** replace hand-tuned capability numbers;
  cross-generation seed aliasing is deleted (no more crediting 2024 outcomes to
  2026 model ids); `minima-seed` defaults to the synthetic pack.
- **The pre-decision LLM reasoner is deleted** — escalation is diagnostic-only
  (`escalation_suggested:*` warnings + decision-log reasons); the harness recovery
  ladder owns the cascade. Config shrinks 97 → 64 settings; recommendation-store
  I/O and calibrator refits run off the event loop; a TS-mirror contract test pins
  the wire schemas to `packages/tui/src/minima/schemas.ts`.
- **The harness is a reference client** — phase tags, difficulty, and
  `chosen_effort` go on the wire; cache-boundary stickiness prefers the incumbent
  model mid-session when the tradeoff is marginal.

### Added
- **Typed SDK feedback** — `Usage(input_tokens, output_tokens, cost_usd, latency_ms)`
  on `feedback()` in both clients, honest autocapture framing, and a loop quickstart
  in the docs.
- **Harness adapters** (`pip install "minima-cli[adapters]"`) — LiteLLM custom
  routing strategy + realized-cost feedback logger, OpenHands `RouterLLM`, and a
  `minima-route` CLI for shell-level integrations.

### Fixed
- **Reinforcement id-space discipline** — keyed-lookup hits carry numeric core-plane
  node ids, which are never sent as reinforcement references anymore; the durable
  record is the primary reference so one unresolvable neighbor can't drop the whole
  reinforcement call (pairs with Mubit's cross-run `record_outcome` resolution fix).
- Live-suite tests updated to the new contracts (diagnostic-only escalation,
  deterministic asserts pinned to argmin) and adapter tests skip cleanly when the
  frameworks are absent.

## [0.10.0] - 2026-07-12

### Fixed
- **Ground-truth spine hardened end-to-end** (still opt-in via `MINIMA_TUI_GROUND_TRUTH=1`):
  - Gate verdicts now carry the `rec_id` of the turn that minted them, so grounded
    feedback can never be poisoned by a stale gate from an earlier prompt, and a
    blocked step's red verdict is superseded by its retry (content-first flip
    identity). Plans close when their last flip is verified, instead of haunting
    every later turn.
  - Step identity survives rewording (token-set matching), a step's baseline resets
    when its `verify` command changes (no fabricated red→green), and resuming a run
    re-adopts its active plan.
  - Bash writes and sub-agent writes are attributed to the run; unattributed
    ("blind") writes cap confidence at 🟡 instead of silently passing.
  - Check runner: verify commands run in their own process group and are killed as a
    group on timeout/abort (no orphaned children), run under a minimal env allowlist,
    and honor `MINIMA_TUI_CHECK_TIMEOUT`.
  - `/plan` council: injected findings are fenced as untrusted data, the whole plan
    turn aborts cleanly on Esc (partial research kept), and each council round is
    budget-metered ($0.25/round soft cap).
- **Default path** (no flag required): the SQLite migration runner is race-safe across
  concurrent sessions and self-heals a previously wedged DB; a bash tool timeout/abort
  kills the whole process group; a throwing after-hook no longer wedges the agent loop;
  the `task` tool is blocked in plan mode.
- Gate-focus modal: keyboard verdict overrides (approve / reject / steer with a note)
  reach the correct gate, and the TUI footer/overlay no longer overflow on narrow
  terminals.

### Added
- With `MINIMA_LLM_JUDGE=1`, judge grading spend is now booked to the session wallet —
  visible in `/cost` (as `judge overhead`), the footer, and enforced by `--budget` —
  while staying out of feedback's `actual_cost_usd` so the cost model Minima learns
  from stays clean.

## [0.9.0] - 2026-07-10

### Added
- **Ground-Truth verification spine (experimental, opt-in via `MINIMA_TUI_GROUND_TRUTH=1`)** —
  the agent's plan steps can carry `verify` shell commands; the harness runs them
  (pre-work baseline → done-gate red→green), records every verdict in the SQLite ledger,
  and derives a confidence tier that drives the UI (🟢 glide / 🟡 flag / 🔴 stop) plus
  grounded, deterministic-over-judge feedback to Minima. Includes `/why` (inspect why the
  harness trusts/distrusts a step), a plan footer strip, and red-gate override capture.
  Off by default — with the flag unset the CLI behaves exactly as 0.8.x.
- **`/plan` planning workflow (part of the same experimental gate)** — a planner persona
  plus a design council of sub-agents that researches, drafts, critiques, and synthesizes
  a `GROUND_TRUTH.md` design document (`/plan start · status · finalize · cancel`).
  Without the flag, `/plan` stays the read-only toggle it always was.
- Permission hardening for verify commands: every LLM-authored `verify` is shown verbatim
  in the approval overlay (with an explicit "… +N more lines" marker when truncated), and
  a stored "always allow" on todowrite never covers a verify command the user hasn't seen.

### Changed
- Transcript rendering is memoized (windowing + `memo()` message rows, render-time ref
  mutations moved to effects) — typing no longer re-renders the whole transcript per
  keystroke.
- Repo-root `CLAUDE.md` added (agent-facing repo guide).

## [0.8.0] - 2026-07-07

### Fixed
- **Learning loop now takes effect** — the client sends a stable `user_id` on every
  recommend, so Minima's memory recall actually surfaces your prior outcomes and routing
  can move off the cold-start prior. Previously no `user_id` was sent, so server-side
  recall was always empty and `decision_basis` never left `prior`.
- **Esc reliably aborts** — pressing Esc now cancels during the routing/recommend phase
  too (it was a no-op there, so the model still ran), and an aborted turn no longer leaves
  a dangling message that made the next prompt re-answer the previous one.
- **Web search/fetch work without an Exa key** — `web_search` and `web_fetch` fall back to
  DuckDuckGo when `EXA_API_KEY` is unset (they previously failed at call time); with a key
  set they still prefer Exa.
- **Rendering** — long lines (routing warnings, reasoning, tool output) are clipped inside
  their bordered cells instead of drawing past the border; the `escalation_suggested`
  internal hint is no longer leaked into the info line; the question and `/tree` overlays
  reserve their height so they can't corrupt terminal scrollback.

### Changed
- Learning-loop write failures are now surfaced — a muted `ℹ learning loop: …` line in the
  TUI and a `feedback_error` event in `--mode json` — instead of being silently swallowed.

## [0.7.2] - 2026-07-06

### Added (TUI)
- **Fullscreen renderer (new default)** — alternate screen buffer with the prompt glued
  to the bottom row, height-accurate transcript windowing, and in-app history scrolling
  (mouse wheel / trackpad on by default; PgUp/PgDn always work). Opt out with
  `--no-fullscreen` or `MINIMA_TUI_INLINE=1` for the classic inline renderer with native
  terminal scrollback.
- **Live current-action line** — while a tool runs, the footer shows what the agent is
  doing right now (e.g. `⚙ bash: git diff --stat`), with `(+N more)` for parallel tools.
- **New tools**: `question` (ask the user mid-run, never permission-gated),
  `apply_patch` (multi-file add/update/delete/move), and Exa-backed `web_search` +
  `web_fetch` (require `EXA_API_KEY`).
- `--thinking LEVEL` is now actually applied (was parsed but ignored).
- Busy indicator with rotating tips; thinking states renamed to `reasoning`/`running`.

### Fixed (TUI)
- **Esc / Ctrl+C abort a running turn** (was dead code behind the busy guard); a second
  Ctrl+C within 2.5s force-quits even if a provider stream cannot be cancelled.
- Plan mode (read-only) blocks `apply_patch` alongside write/edit/bash.
- Live streaming region can never outgrow the viewport: over-budget final lines are
  hard-sliced (fixes the fullscreen garble class and inline scrollback wipes).
- `/fork` and `/clone` no longer claim fake success — they say they're not implemented.
- glob/grep are permission-scoped as directory READS (`read from <dir>`) instead of
  generic `run glob` prompts.

### Changed (TUI)
- **Permission denials are reframed for the model** ("the user declined … do not retry
  the call and do not attempt the same action through other tools") — stops the
  sandbox-spiral where models retry or work around a deliberate user decline.
- Memory-recall block is annotated reference-only (do NOT run tools from recall).

## [0.7.1] - 2026-07-05

### Changed (API behavior — note for integrators)
- **`max_cost_per_call` is now a true hard filter.** When no model fits the budget,
  `POST /v1/recommend` returns **422** (`"no model within max_cost_per_call budget"`)
  instead of 200 with the cheapest over-budget model plus a `no_model_within_cost_budget`
  warning. This matches the documented "hard filter" contract and the existing
  no-candidates behavior. Callers who want "cheapest possible regardless of ceiling"
  should use the cost-quality slider, not `max_cost_per_call`.
- **Auth rejects malformed bearer tokens.** A bearer token that is not in the Mubit key
  format (`mbt_…`) now returns **401** before any work, instead of being accepted and
  served from priors. A missing bearer with a server-configured `MUBIT_API_KEY` fallback
  is unaffected.

### Fixed
- **Cold-start catalog prices were stale.** The vendored fallback snapshot
  (`capability_priors.json`) is refreshed from the live catalog (e.g. `claude-opus-4-8`
  `15/75` → `5/25`), and a scheduled workflow now keeps it current so it stops drifting
  by hand. (The auto-refresh updates prices for the curated model list; it does not add
  new models — expanded provider coverage such as the gpt-5 family remains a separate
  curation.)
- **Server version string can no longer drift.** `minima.__version__` (reported by
  `/v1/health` and `/v1/capabilities`) now derives from installed package metadata instead
  of a hardcoded constant that had silently lagged across releases.
- **Feedback reconciliation types the quality value honestly** as `float | None` — unjudged
  rows keep `NULL`, no fabricated default (preserves the M-J2 fix).

### Internal
- **PR CI added** — every PR now runs server (`ruff` + `pytest` + `mypy`) and TUI
  (`bun test` + `tsc`) checks; the recommender is mypy-clean.

## [0.7.0] - 2026-07-05

### Added
- **`GET /v1/capabilities`** — server feature handshake (api version, honored constraint
  fields, feature flags) so clients can gate enforce-mode features on what the server
  actually supports instead of guessing. (#54)
- **Sub-agent tree visualization** — a live `▸ step [status] $cost` panel (`/tree`) fed by
  tagged child events during multi-agent runs. (#55)
- **Git worktree isolation for parallel sub-agents** — `isolation: "workdir"` delegations run
  in a temporary `git worktree` (with a dirty-tree warning and automatic cleanup), so parallel
  children editing the same files can't clobber each other. (#55)
- **Delegation ops-rules + BLOCKED convention** — sub-agents get explicit operational rules,
  boundary refusals surface as `BLOCKED` → `partial` outcome so the parent can tell, and the
  task tool carries anti-retry guidance (no more re-running an identical failed DAG). (#59)

### Fixed
- **Every Claude call timed out in the harness** — the Anthropic SDK was handed a timeout in
  seconds where it expects milliseconds (a 30–60 ms budget), so every Claude stream/complete
  call died with "Request timed out" and fed quality-0 failures into routing. (#56)
- **Quality-score fabrication in the feedback loop (M-J2)** — unjudged successes no longer
  default to quality 0.9 in the server decision log; the harness now sends a `judged` flag and
  unjudged rows reconcile with `quality = NULL`, so calibration and savings metrics stop
  trusting values that were never measured. (#54)
- **Judge hardening** — empty-output guard (scores 0 without an API call), head+tail
  truncation so tail requirements survive long outputs, `<response>` delimiters + scoped-trust
  system prompt against response-embedded injection, and a `parseScore` fix for
  "X out of 10" phrasing. (#57)
- **Gemini reasoner starvation** — advisory JSON calls (classify/rank) no longer burn their
  entire token budget on thinking before emitting JSON; RANK_SYSTEM invariants hardened. (#58)

### Notes
- `minima-cli` on PyPI resumes at 0.7.0: the project version had lagged at 0.5.0, so the
  0.6.0 release build was silently skipped by `--skip-existing` and 0.6.0 was never published.

## [0.6.0] - 2026-07-02

Agent-core release (milestones M-A…M-I): cost-aware sub-agent orchestration — `task` tool
with sequential and parallel DAG fan-out under a semaphore, per-child routing, budgets and
timeouts; DB-backed `BudgetLedger` with graduated enforcement; SQLite persistence spine
(runs/events/decisions + rehydration); recovery ladder walking server-supplied rungs on
failure; effort routing Phase A + fleet metrics; feedback-loop poisoning fixes; feature-vector
classifier with strongest-signal scoring. *(Never published to PyPI — see the 0.7.0 note.)*

## [0.5.2] - 2026-07-02

Fixed TUI viewport-overflow rendering corruption; docs rebrand (Manrope, "minima by Mubit"
nav logo, new favicon).

## [0.5.1] - 2026-07-01

Mubit memory in the TS harness (recall-before-route + outcome write-back with stable session
ids); benign routing diagnostics no longer render as errors; live model catalog; docs migrated
to Vocs with a Homebrew install guide.

## [0.5.0] - 2026-07-01

The TypeScript/Bun TUI becomes the shipped CLI: one-click `minima auth` (browser login,
per-repo project mapping, workspace provisioning), the Homebrew tap ships the compiled binary
instead of a Python venv formula, and a comprehensive routing/tool test suite lands.

## [0.4.10] - 2026-06-26

### Changed
- **`minima-cli` is now published to PyPI automatically on every release** — `pip install minima-cli`
  is the official install (it bundles the `minima_client` SDK). A new CI job builds + uploads the
  sdist/wheel alongside the GitHub release and prod deploy.

### Fixed
- **Docs (API reference):** corrected the `GET /v1/health` response example (it returns `mubit`
  not `memory`, `version 0.4.9`, plus `auth`/`reasoner` blocks and `catalog.cost_source`) and
  clarified `status` is only `degraded` on a key-bearing probe; documented the real
  `summary.realized` field set (it differs from `summary.estimated`); and fixed the `days`
  parameter bound (`>0–365`) on `/v1/savings` and `/v1/calibration`. Added a PyPI install link to
  the Client SDK page.

## [0.4.9] - 2026-06-26

### Fixed
- **Multi-turn conversations with thinking enabled no longer 400 on Anthropic.** With extended
  thinking on, Anthropic signs each thinking block and requires the signature echoed back when the
  block is replayed — so the second turn of any thinking conversation (and any thinking + tool-use
  turn) failed with `messages.N.content.0.thinking.signature: Field required`. The provider now
  captures the `signature_delta` onto the thinking block and sends it back; an unsigned thinking
  block (from another provider or an older session) is dropped rather than sent unsigned.
- **Text selection works again in macOS Terminal.app.** Terminal.app doesn't report mouse-motion
  events (xterm mode 1003), which Textual needs for in-app drag-select — so capturing the mouse
  there gave neither in-app selection nor Terminal.app's native selection (only wheel-scroll). The
  mouse default is now resolved per-terminal: ON everywhere (scroll + in-app drag-select, as in
  iTerm2/Ghostty/WezTerm), but OFF on macOS Terminal.app so native click-drag selection + copy work
  out of the box (scroll with PageUp/PageDown). `--mouse`/`--no-mouse` overrides; `/mouse` toggles.

## [0.4.8] - 2026-06-26

### Fixed
- **A provider whose API key is invalid no longer wastes every turn routed to it.** When a model
  call hard-fails on auth (e.g. an invalid `ANTHROPIC_API_KEY` → `401 invalid x-api-key`), that
  provider is now blacklisted for the session and the *same* message is auto-rerouted onto a
  provider whose key works — instead of the router re-recommending the dead provider on every
  turn. The auth failure is also no longer fed back to Minima as a model-quality failure (it's a
  credential problem, not a quality signal), so it can't poison the model's success estimate in
  your namespace. Routing now also drops providers with no key configured up front, `/reconnect`
  (and a key fixed via `/config`) clears the blacklist, and pins are never auto-rerouted.
- **Scroll-wheel and text selection/copy both work now.** Terminal mouse-tracking is
  all-or-nothing — capturing the mouse for scroll-wheel suppresses the terminal's native
  click-drag selection. Mouse capture is back ON by default (wheel scroll + in-app drag-select),
  the terminal's native selection stays reachable by holding the bypass modifier while dragging
  (Option on macOS, Shift on Linux), and copy now also pushes to the OS clipboard
  (`pbcopy`/`xclip`/`wl-copy`) — Textual's built-in copy emits only OSC 52, which macOS
  Terminal.app silently ignores, so selections *looked* copied but weren't.

### Added
- **`/resume` picker shows timestamps** — each session row now shows when it was created and last
  used (e.g. `used 2h ago · created 3d ago`), and the list is sorted most-recently-used first.
- **`/mouse [on|off]`** command to toggle mouse capture live (scroll-wheel vs. terminal-native
  selection) without restarting, plus a **`--no-mouse`** launch flag and an OS-aware selection
  hint on the splash.

## [0.4.7] - 2026-06-26

### Fixed
- **Gemini calls failed whenever a tool with a nested-model schema was attached** — including
  the `/ledger` `tasks` tool (its `TaskItem` list). Pydantic emits `$ref`/`$defs` for nested
  models, and the google-genai SDK's strict `Schema` model rejects those with a
  `ValidationError` (`extra_forbidden` on `$ref`), failing the entire call. Because the error
  text contains `extra_forbidden`, it was *misclassified* as a `403` "Access denied (key lacks
  permission, or no quota)" — so it looked like a key/quota problem when it was a client-side
  schema issue. (This is why Gemini "stopped working" once a ledger goal was active; introduced
  with the `tasks` tool in 0.4.4.) The Google provider now sends tool schemas via
  `parameters_json_schema` (the SDK's standard-JSON-Schema path, which inlines/converts `$ref`
  itself per Gemini's function-declaration rules) instead of the strict `parameters` model.
- **Client-side validation errors are no longer misread as provider auth failures.**
  `classify_provider_error` now detects a pydantic/schema `ValidationError` first and reports it
  as a tool-schema problem ("pin another model / report it"), so a `extra_forbidden` can never
  again masquerade as a `403`/permission denial.

## [0.4.6] - 2026-06-26

### Added
- **Raw provider errors are now surfaced and logged.** Alongside the clean classified message,
  a failed model call now shows the provider's exact words (`└ provider said: …`) in the TUI and
  logs them at WARNING, so an ambiguous `403/429` ("key lacks permission, or no quota") is
  self-diagnosing — you can see whether it's `RESOURCE_EXHAUSTED`, `PERMISSION_DENIED`, a project
  issue, or model availability, instead of guessing.

### Fixed
- **One provider hiccup wedged the entire session.** A failed model call (bad key, 403/429,
  network) is swallowed into an *empty* assistant message with `stop_reason="error"`, which the
  agent loop appended to history. On the *next* turn — even to a healthy provider — that empty
  text block made the request invalid (Anthropic `400 "messages: text content blocks must be
  non-empty"`), so a single hiccup broke every subsequent turn until the session was cleared.
  Now (1) the loop never sends a failed call's assistant to a provider, and (2) a failed turn is
  rolled fully out of the agent's context (assistant + the user message that triggered it), so
  the next turn starts clean. Regression introduced in 0.4.4 (when provider errors began being
  swallowed into an empty assistant rather than raised). Verified against the live Anthropic API.
- **A failed model call was framed as "routing offline … /reconnect to retry Minima."** When
  routing *succeeds* but the model *call* fails, the banner now reads e.g. `⚠ Access denied by
  Google Gemini … — check GEMINI_API_KEY (/config) or pin another model (/model)` instead of the
  misleading routing/reconnect framing. The provider-403 message also gained an actionable next
  step (it was the only `classify_provider_error` branch without one).
- **Switching models left a stale error banner up.** After a model's call failed, pinning or
  unpinning a different model (`/model …`, `/model auto`) now clears the banner — a prior
  model's "access denied"/offline message no longer lingers as if it were still happening.
- **Pinning a model not in Minima's routing catalog 422'd and ran the wrong model.** Pinning
  e.g. an OpenRouter-namespaced model (`google/gemini-2.5-flash`) sent it to Minima as a routing
  constraint; Minima didn't recognize the id → `422 no models match the supplied constraints` →
  routing degraded offline and ran a *different* fallback model, while the footer/banner
  disagreed with what actually ran. A pin is now a true override: it bypasses Minima entirely
  and runs exactly the pinned model (basis `pinned`), so any registered model — OpenRouter,
  local, custom — can be pinned and runs as-is.

## [0.4.5] - 2026-06-26

### Fixed
- **Routing 401'd for the whole session when the Mubit key wasn't resolvable at launch.**
  The `AsyncMinimaClient`'s `Authorization` header is fixed when the client is built, so a
  Mubit key added via the `/config` overlay (or exported after launch) never took effect —
  `/reconnect` only cleared the banner without rebuilding the client, leaving every turn
  routing offline with `minima error 401: pass your Mubit API key …` until a full restart.
  Now `/reconnect` (and saving a routing key/URL in `/config`) re-reads the environment and
  rebuilds the Minima client in place, so the fix applies immediately — no restart.
- **Offline-fallback banner for an auth/config problem misleadingly said "/reconnect to
  retry."** A no-key or rejected-key 401/403 is now classified separately from a transient
  outage: the banner shows the actionable step ("no Mubit API key — add MUBIT_API_KEY via
  /config") and drops the "/reconnect" framing (retrying alone wouldn't help). Transient
  causes (timeout/unreachable) keep the "/reconnect to retry" banner.
- **No-key + hosted Minima made a guaranteed-401 round-trip every turn.** With no key
  configured against a remote endpoint, routing now short-circuits instantly instead of
  waiting on a doomed request (local/loopback endpoints still attempt, so keyless local
  servers are unaffected).

## [0.4.4] - 2026-06-25

### Added
- **OpenRouter is now a full provider, not 4 hardcoded models.** Setting `OPENROUTER_API_KEY`
  fetches OpenRouter's entire live model list (`GET /api/v1/models`, ~340 models) with live
  pricing / context / modalities / reasoning, so any OpenRouter model is callable, pinnable, and
  routable. Cached to `~/.minima-harness/cache` with a 24h TTL; degrades live → stale cache →
  curated so startup never blocks or breaks offline.
- **`/ledger` — cost-aware goals.** Set a budgeted objective (`/ledger set <title>`,
  `/ledger budget <usd>`); the agent maintains a task checklist (the `tasks` tool, footer `N/M`,
  re-anchored into the prompt each turn and persisted across `--continue`/`--resume`). The goal
  conditions routing (its turns cluster in Minima's memory) and each turn's realized cost is
  attributed to it — `└ ledger · spent $X · ~$Y projected · budget $B` — the cost-to-goal view no
  other agent has. (`/goals` remains as a hidden alias.)
- **Permission prompts before sensitive ops (default on).** write / edit / bash now ask first
  (Enter approve · `a` always-allow this tool · Esc reject), previewing a diff or the command.
  `/yolo` or `--dangerously-skip-permissions` disables prompting; `/edits` forces a diff review.
- **`/thoughts`** streams the model's reasoning into a muted bubble above each answer; **`/exit`**
  (and `/quit`) quit the TUI.

### Fixed
- **Provider failures are no longer silent.** A failed model call (bad/missing key, 401/403/404/
  429/402, network) was swallowed into an *empty* assistant message — a blank bubble in the TUI,
  an empty line on `--print`. The harness now classifies it and surfaces an actionable,
  provider-aware message (e.g. "Authentication failed for Anthropic running claude-opus-4-8 — set
  ANTHROPIC_API_KEY (/config)") in the TUI, on `--print` stderr (exit 1), and in `--mode json`.
  Tool failures (incl. permission denials) render prominently instead of a faint line.
- **OpenAI GPT-5 / o-series models 400'd on every call.** They reject `max_tokens` and require
  `max_completion_tokens`; the OpenAI-compatible provider now sends the right param for the
  `openai` provider (other OpenAI-compatible hosts keep `max_tokens`). Encoded as a small
  per-provider request-quirks table rather than a hardcoded branch.
- **`/confirm` could silently ignore your pick** (kept the routed model when a pick didn't
  resolve) — now warns; the decision card marks candidates with no provider key as `⚠ no key`.
- **`/model` had no way to unpin** — added an "auto (unpin)" entry + `/model auto` that restore
  the full routing pool.
- **Scary red banners for benign routing diagnostics** (`neighbor_classified`, `recall_timeout`,
  `cold_start`, …) — these are now suppressed; the banner is reserved for actionable issues.
- **Tool calls dumped raw JSON args** — now rendered IDE-style (diffs for edit/write, `$ cmd` for
  bash, a clean summary otherwise) with colorized diffs.
- **Errored turns were sometimes reported to Minima as successes** (when judging was off),
  poisoning the routing loop — now recorded as failures.
- **The launch splash was pinned to the left** instead of centered.
- **`/v1/models` price overlay** — the harness now overlays Minima's authoritative live pricing
  onto the registry at startup, so reported cost matches what the server routed against.

### Performance
- **`brew install minima` drops from ~5 min to ~3 s.** The Homebrew formula now installs
  dependencies from prebuilt wheels instead of compiling grpcio / cryptography / pydantic-core /
  jiter / cffi from source. (Apple Silicon + Linux compile nothing; macOS-Intel still builds only
  `cryptography`, which publishes no x86_64 wheel.)

## [0.4.3] - 2026-06-24

### Fixed
- **High CPU / fans during use.** The status bar repainted on *every* streamed token —
  `_append_stream` called `set_state("working")` per delta and `StatusBar.set_state`
  re-rendered unconditionally, so a 600-token reply triggered ~616 footer repaints (the
  terminal emulator repaints on each, which spins fans). `set_state` is now idempotent
  (no-op when the state is unchanged), the live-stream flush eased from ~33 Hz to ~16 Hz,
  and the spinner timer is **paused while idle** (no 10 Hz wake-ups when nothing is running).
  Measured: a 600-token stream drops from ~666 to ~40 repaints (~94% fewer); idle is quiet.
  Memory is unaffected (steady ~70 MB RSS, no leak).

## [0.4.2] - 2026-06-24

### Added
- **Multi-provider support (open & closed source).** A new provider catalog
  (`ai/provider_catalog.py`) integrates 21 LLM providers — closed-native (OpenAI, Anthropic,
  Gemini, DeepSeek, Mistral, xAI, Cohere, Perplexity), the OpenRouter aggregator, open-weight
  hosts (Groq, Together, Fireworks, DeepInfra, Cerebras, Hyperbolic, Novita), and local
  runtimes (Ollama, vLLM, LM Studio, llama.cpp, LocalAI). All speak the OpenAI
  chat-completions protocol, so a verified `base_url` + the right API-key env var is enough.
  Model ids + pricing were verified against each provider's official docs (June 2026).
- **Key-gated, provider-specific routing.** Each model resolves *its own* provider's key
  (a Groq model uses `GROQ_API_KEY`, never an OpenRouter key on `api.openai.com`); a provider's
  models are registered only when its key is configured (so the `/model` picker stays relevant);
  routing candidates and the offline fallback are filtered to models the user can actually run.
  The `/model` picker now lists every registered model so any provider's model can be pinned.
- **`minima config`** now lists the popular providers (Anthropic, OpenAI, Gemini, xAI, DeepSeek,
  Mistral, OpenRouter, Groq, Together); more providers work by exporting their env var, and
  local runtimes need no key.
- **Config overlay UX:** Enter walks the fields and lands on a visible **Save** button (Enter
  saves — Ctrl+S still works); the save hint is pinned in an always-visible footer.

### Fixed
- **`.env.example` shipped `MUBIT_ENDPOINT=http://127.0.0.1:3000`** and the docs said
  `cp .env.example .env`; the CLI auto-loads `./.env`, silently degrading Mubit memory to a
  dead localhost. The localhost default is now commented out, and `init_mubit` treats an empty
  endpoint as unset (hosted default applies).
- **OpenRouter-only / single-provider setups mis-routed.** The earlier key-aware fallback could
  pick `gpt-4o-mini` (which hits `api.openai.com`) for an OpenRouter key → guaranteed 401. Key
  eligibility is now provider-specific and base_url-aware; an unpriced (cost-0) custom/local
  model is no longer mistaken for the cheapest offline fallback.
- **`--offline` no longer dumps an httpx traceback** — routing fails fast with a clear
  "routing disabled (offline mode)" reason, and the expected offline-fallback log drops the
  stack trace (kept at DEBUG).

## [0.4.1] - 2026-06-24

### Fixed
- **Published CLI defaulted routing to `localhost:8080`.** A freshly installed `minima` (no
  project `.env.harness`) connected to a dev URL that isn't running, so every turn fell back to
  OFFLINE with "Minima unreachable" — while `minima config doctor` misleadingly reported the
  hosted endpoint. `DEFAULT_MINIMA_URL` is now `https://api.minima.sh` and is the single source
  of truth shared by the runtime, the config store, and `config doctor` (they can no longer
  drift). Local dev against `make run` sets `MINIMA_URL=http://localhost:8080` explicitly.
- **Offline fallback could pick an unrunnable model.** The degraded-mode fallback chose the
  globally cheapest model (gpt-4o-mini) regardless of configured keys, so an
  Anthropic+Gemini-only setup hit a provider-auth error offline. It now prefers the cheapest
  model whose provider key is actually set (e.g. `claude-haiku-4-5` / `gemini-2.5-flash`),
  falling back to the global cheapest only when no key is present.

## [0.4.0] - 2026-06-24

First public, source-available release. Headline theme: the **harness** becomes a
trustworthy, transparent cost-aware coding agent, and the **recommender** gains a
data-grounded cost range.

### Added
- **`minima-harness config`** — per-user credential management across three surfaces
  (CLI subcommand, `/config` TUI overlay, in-TUI editing). Secrets go to the **OS keyring**
  when available, falling back to `~/.minima-harness/config.env` at mode `0600`; loaded into
  the environment at lowest precedence. Sections: LLM provider keys + Mubit/Minima routing.
- **`/prompt` layered inspector** — every system-prompt layer (base, project context, session
  override, Mubit lessons) shown separately with per-layer token counts, editable in place.
- **`/optimize`** — Mubit-backed system-prompt optimization (consolidates lessons + outcomes,
  estimates token savings) with a local dedup fallback; never auto-applies.
- **Routing decision card** — each candidate framed as **cost (with predicted range) / speed /
  predictability**, an ROI line for pricier alternatives, and hybrid reasoning (data-grounded
  by default, the reasoner's natural language only when evidence is thin).
- **Data-grounded cost band** (server) — the recommend response now carries a p25–p75 cost band
  (`est_cost_low` / `est_cost_high` / `cost_band_basis`) and `success_interval_width`, computed
  from realized-cost history; honest "no range yet" when evidence is thin.
- **Cost predictability in `/stats`** — estimate-vs-actual MAPE and within-band hit-rate
  (estimated cost is now persisted per turn to the session log).
- **MINIMA CLI welcome banner** and a centered launch splash.
- `docs/publishing.md` — release checklist.

### Changed
- **License is now `FSL-1.1-Apache-2.0`** (Functional Source License — source-available,
  non-compete; each version converts to Apache-2.0 two years after publication). Previously
  `Proprietary`.
- **Mouse capture is OFF by default** so terminal text selection + copy (drag, then Cmd/Ctrl+C)
  works out of the box; `--mouse` opts into scroll-wheel support (otherwise PageUp/PageDown).
- Footer renders Ctrl shortcuts as `ctrl+l` etc. instead of the `^l` caret.
- Overlays (config, prompt, routing, optimize, and the model/session/command/tree pickers) share
  a consistent rounded-accent card style with border titles.

### Fixed
- Copy/paste broke when mouse capture was enabled by default — restored selection-friendly default.
- Harness Minima client timeout raised (10s → 30s) so a cold-start `recommend` that consults the
  reasoner no longer silently degrades to offline routing.

[0.4.0]: https://github.com/mubit-ai/minima/releases/tag/v0.4.0
