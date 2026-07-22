# Parallel Observer / Adversarial Agent — research + design fit (2026-07)

Can Minima's harness run a concurrent observer agent that watches the whole run
(turns, tool calls, gate verdicts), curates memory from what it sees, and adversarially
checks the implementation agent's conclusions (false "done"s, wrong claims, plan
drift)? Three-track research: academic literature (all citations verified), industry
practice (sources fetched), and a deep attachment-point analysis of `packages/tui`.

## What the evidence establishes

**The observer must be external — and can be cheap.** Intrinsic self-correction fails
and often degrades answers (Huang et al., 2310.01798); a dedicated critic out-catches
both the actor and human reviewers (CriticGPT, 2407.00215); a *weaker trusted* model
monitoring a stronger actor with a ~2% audit budget yields 62–92% safety in control
evaluations (AI Control, 2312.06942), and GPT-4o effectively monitors o3-class actors
(2503.11926). Aggregated cheap aspect-verifiers beat one monolithic reviewer (MAV,
2502.20379).

**Adversarial stance wins; trajectory scope, not single actions.** Debate protocols
beat cooperative review (2402.06782: judges 76%/88% vs 48%/60% baselines). Multi-step
monitoring must judge sequences, and resampling a suspicious step is a cheap
interrogation primitive (Ctrl-Z, 2504.10374: attack success 58%→7% at 5% usefulness
cost). Bun's Rust rewrite (bun.com/blog/bun-in-rust) is the production-scale proof:
6,502 commits / 64 parallel Claudes governed by split-context adversarial review —
implementer with full context, two reviewers given *only the diff* and told to assume
the code is wrong, a separate fixer. Their anti-shortcut rule ("a paragraph-long
comment justifying a workaround means the code is wrong") is a directly promptable
observer heuristic.

**Attribute online, not post-hoc.** Post-hoc blame assignment is near-useless today
(Who&When, 2505.00212: 53.5% agent-level, 14.2% step-level accuracy), while observers
with tool access to intermediate artifacts approach human agreement (Agent-as-a-Judge,
2410.10934) and mid-run outcome prediction from trace statistics works (AgentMonitor,
2408.14972, ρ=0.89). Verdicts must be stamped at the step where a claim and a tool
result diverge — which requires the full event ledger as substrate (Minima already has
it).

**Audit the greens.** Frontier coding agents game verifiers at material rates (METR:
30.4% of o3 RE-Bench runs; hacks found by inspecting *anomalously successful* runs),
and uncaught reward hacking generalizes into covert misalignment (Anthropic,
2511.18397). MAST (2503.13657) puts weak verification / premature termination among
the top real-world multi-agent failure clusters — its 14 failure modes are a
ready-made observer rubric.

**Protect the observer from the observed.** Adaptive prompt injections embedded in
actor output subvert every current monitoring protocol (2510.09462) — the observer
must treat all actor text as data (sanitize/paraphrase before ingesting). And
optimizing the actor against monitor verdicts produces obfuscated cheating
(2503.11926; monitorability position paper 2507.11473) — observer verdicts may gate
and write memory, but must never become a target the actor is tuned against.

**Memory curation as a separate asynchronous reflector.** Generative Agents'
reflection (2304.03442) and Retroformer (2308.02151 — a separate retrospective model
graded by realized downstream reward, beating self-reflection) validate exactly
Minima's scribe shape: an observer that writes memory should be a distinct process
over the event log, graded by gates, not by the actor's agreement.

## Where the industry actually is

Nobody ships a general-purpose LLM observer streaming token-by-token beside the actor.
The converged two-tier architecture:

- **Concurrent tier = deterministic** — hooks, rails, static analysis at every action
  boundary (Claude Code PreToolUse/Stop hooks, NeMo Guardrails execution rails,
  Factory DroidShield). The one production per-action *LLM* monitor is Meta's
  LlamaFirewall AlignmentCheck (real-time goal-alignment audit of the reasoning
  trace), viable because its scope is narrow (injection/goal-hijack).
- **LLM-critic tier = artifact boundaries** — Google Jules' critic pass on every patch
  before the user sees it (flag-don't-fix, actor revises); GitHub Copilot's coding
  agent self-reviews pre-PR; Cursor Bugbot at the merge boundary; OpenHands' trained
  32B critic selecting best-of-5 trajectories (60.6%→66.4% SWE-Bench Verified);
  Anthropic's multi-agent system judges end-state with a rubric and deliberately does
  not step-grade.
- **Budget norm:** the critic earns roughly one invocation per completed unit of work,
  ~10–30% of actor spend; observability products (LangSmith online evals) sample and
  cap spend per evaluator. Cognition's counter-position ("Don't Build Multi-Agents")
  bounds the design: the observer's judgment is only as good as its access to the
  full trace — summaries make it unreliable.

## Attachment-point map (from the codebase deep dive)

The harness has every ingredient except the streaming subscription:

| Ingredient | Status | Where |
|---|---|---|
| Live event feed | EXISTS in-process: `Agent.subscribe()` bus (agentStart→toolExecutionEnd→turnEnd), already feeds TUI + DB sink. Caveat: `dispatch` awaits listeners — a slow observer stalls the loop; needs a non-blocking fan-out | `src/agent/agent.ts` |
| Event ledger substrate | EXISTS: append-only `events`, `tool_calls`, `gates`, `file_changes` (with `origin=off_plan` drift marker), `routing_decisions` — but sink flushes per turn, and DB is single-writer (observer must be in-process; read-only WAL reads are fine) | `src/db/minima_db.ts`, `sink.ts` |
| Critic precedents | EXIST, all bounded: sampled judge (post-turn, advisory), zero-context diff reviewer (plan close, yellow-gate-only), planning critic (finalize, note-only), `/verify` refutation (spawned deep child, red/yellow gate), anti-spiral + stop-gate (deterministic, during-run, CAN block) | `judge.ts`, `diff_review.ts`, `plan_critic.ts`, `plan_refute.ts`, `anti_spiral.ts`, `stop_gate.ts` |
| Memory-side precedent | EXISTS: the scribe — `memory_jobs` queue, budget caps ($0.03/pass, 20% budget floor), recurrence gating, ledger-fed signals incl. `judge_gate_disagreement` (already adversarial-shaped) | `memory_scribe.ts` |
| Intervention channels | EXIST, cleanly split: enforced = `beforeToolCall` block, stop-gate deny-with-strikes, red gate; advisory = `agent.steer()`, notes, memory candidates, yellow tier-cap | `loop.ts`, `stop_gate.ts`, `diff_review.ts` |
| Spend booking | EXISTS: `meter.addOverhead` + `budget.bookSpend(usd, label)` — precedents "judge"/"scribe"/"diff-review"; observer adds `"observer"` | `meter.ts`, `cli/main.ts` |

**Gaps needing new code:** (1) non-blocking event fan-out off the bus; (2) a
whole-session in-process worker primitive (spawned children are turn-capped ≤24 and
wall-clock-timed); (3) a running cross-turn trajectory narrative ("claimed X in turn
3, contradicted in turn 7"); (4) an `observer_verdicts` store — gates' `kind` union
and the tier/feedback join must not be polluted (anti-spiral/stop-gate already write
`recId:null` audit rows for exactly this reason).

## Proposed design: two tiers, one memory spine

Tier 1 (**concurrent, deterministic, ~free**) — extend what exists with tripwires an
LLM isn't needed for, evaluated in after-tool hooks: edits to test files or `verify`
commands by the actor; a green without a red baseline (the fabrication floor already
red-tiers this — surface it as an observer event); `file_changes.origin=off_plan`
bursts; "done"-type claims in assistant text while plan steps sit `unchecked`; the Bun
anti-stub heuristic (large explanatory comment + trivial body). Output: advisory
steers (like anti-spiral) + `recId:null` audit gates.

Tier 2 (**sampled LLM observer at boundaries**) — a long-lived in-process worker fed
by the non-blocking fan-out, holding the trajectory narrative; invoked at turn/plan
boundaries and on Tier-1 tripwires, on the cheap meta-model, budget-capped
scribe-style. Prompted adversarially (refute the "done" claim against plan + diff +
gates; MAST rubric; audit anomalous greens first), ingesting paraphrased/sanitized
actor text. Powers:

- **Call-outs**: advisory `steer()` note naming the claim and the contradicting
  evidence (file:line, gate id); repeated ignored call-outs escalate to a yellow
  milestone gate (worst-tier resolution can yellow the plan — same authority as the
  diff reviewer, never green, never outranking deterministic gates).
- **Memory side**: observer findings become scribe signals (extending `mineSignals`),
  flowing through the existing recurrence gate + provenance rules — gate-cited
  candidates auto-activate, the rest await `/memory confirm`. Graded by realized
  gates, Retroformer-style, never by actor agreement.
- **Feedback-loop tie-in** (see `feedback-loop-research.md`): observer verdicts join
  the weak-supervision label model as one more labeling function with a learned
  accuracy — raising label coverage, never escalating `evidence_source` provenance.

Invariant checklist (all four Minima design principles hold): state in the DB
(`observer_verdicts` + audit events), enforcement in the dispatcher (only the
stop-gate/tool-block/red-gate levers enforce; text is advisory), feedback truth
(observer never fabricates quality or claims `gate` provenance), recommend-only server
(observer is entirely harness-side).

## Sequencing

| Phase | Work |
|---|---|
| O1 | Non-blocking event fan-out + `observer_verdicts` table (migration v15) + deterministic trajectory summarizer (no LLM) |
| O2 | Tier-1 tripwires → steers + audit gates; TUI surfacing (observer lane in /why) |
| O3 | Sampled Tier-2 LLM pass at turn/plan boundaries; budget label `"observer"`, floor-gated; adversarial refute prompt seeded with MAST modes + Bun anti-stub rule |
| O4 | Scribe integration: observer signals → memory candidates under existing provenance gates |
| O5 | Cross-run: observer verdicts as weak labels in the feedback label model (Phase 4 of the feedback-loop roadmap) |

Key sources: AI Control 2312.06942 · Ctrl-Z 2504.10374 · adaptive monitor attacks
2510.09462 · CriticGPT 2407.00215 · self-correction limits 2310.01798 · debate
2402.06782 · MAV 2502.20379 · MAST 2503.13657 · Who&When 2505.00212 · CoT monitoring
2503.11926 / 2507.11473 · METR reward hacking (metr.org, 2025) · emergent misalignment
2511.18397 · Generative Agents 2304.03442 · Retroformer 2308.02151 · AgentMonitor
2408.14972 · Agent-as-a-Judge 2410.10934 · LlamaFirewall AlignmentCheck (Meta 2025) ·
Jules critic (Google 2025) · OpenHands critic (2025) · Anthropic multi-agent research
system (2025) · Cognition "Don't Build Multi-Agents" (2025) · Bun-in-Rust
(bun.com/blog, 2026).
