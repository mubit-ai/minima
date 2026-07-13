# Applying Proven Harness Practices to Minima

> Companion to `harness-research.md`. This file answers: **given what other harnesses do
> well, what should Minima's harness adopt, in what order, and where does it plug into the
> existing codebase?**
>
> Audience: someone editing `packages/tui/` or extending the GT contract in
> `docs/PLAN/ground-truth-plan.md`. Read this *before* opening a Linear ticket.

---

## Part 0 — Where Minima already stands

Minima's TUI harness (`packages/tui/README.md`) already has the load-bearing bones:

| Capability | In Minima today | Where |
|---|---|---|
| Agent loop with **before/afterToolCall hooks** | ✅ | `src/agent/` (agentLoop, hooks) |
| **`max_turns`** cap | ✅ | agent core |
| Parallel tool execution + steering | ✅ | agent core |
| **Plan persistence + projection + DRIFT footer** | ✅ | GT stages 0–2 |
| SQLite ledger (plans · plan_steps · file_changes · gates · user_signals) | ✅ | `src/db/minima_db.ts` (schema v5) |
| **Frozen verification contract** (red→green check) | ✅ (contract) | `src/minima/gt_contract.ts` |
| Append-only JSONL session tree | ✅ | `src/session/` |
| Tools: read/write/edit/bash/ls | ✅ | `src/tools/` |
| 3 providers (openai-compat, anthropic, google) + faux | ✅ | `src/ai/` |

What's **not** there yet — from `docs/PLAN/ground-truth-plan.md` status table:
- Verification wiring (Stage 3 — `runCheck`, capture baseline)
- Block-on-fail (Stage 4)
- Provenance + tamper detection (Stage 5)
- Confidence tier → behavior mapping (Stage 6)
- Grounded outcome → routing (Stage 7)
- `/why` + E2E demo (Stage 8)

**So Minima is past the persistence layer and into the deterministic-guard layer.** That's
exactly the right place to apply the lessons from `harness-research.md`. Most of the work
ahead is wiring the deterministic layer; the research tells us *which mechanisms* wire in
cleanly.

---

## Part 1 — The seven-property gap analysis for Minima

For each property: what's done, what's a gap, the single best mechanism to borrow, and where
it plugs in. ★ = highest-leverage borrow.

### §1 — Verifiable steps ★★★

| | |
|---|---|
| Done | Frozen contract (`gt_contract.ts`); `plan_steps.verify` column; red→green requirement. |
| Gap | Stage 3 not wired — `runCheck(cmd)` primitive, baseline capture-on-start. |
| **Borrow** | **Claude Code's Stop hook with N-strike override.** ([harness-research §1]) |
| Plug into | M3.2 `runCheck` (MUB-112), M4.1 block-`done`-on-fail (MUB-114). |

**Specific recommendation:** implement the Stop hook exactly as Claude Code does it — a
deterministic shell-out that **blocks step-done until `verify` passes**, but **overrides
after N consecutive blocks** (Claude Code uses 8; Minima should make this configurable per
step, defaulting to 3 because GT steps are smaller than CC turns). The override triggers the
§7 escalation path (🟡 flag or 🔴 stop), not silent success. This is the bridge between §1
and §7.

```ts
// pseudocode shape — not a real file
async function markStepDone(step: Step): Promise<DoneVerdict> {
  const checks = await runCheck(step.verify);          // M3.2
  const baseline = step.baseline ?? await captureBaseline(); // M3.3
  for (let attempt = 1; attempt <= MAX_BLOCKS; attempt++) {
    if (checks.wentRedToGreen(baseline)) return 'verified';
    if (attempt === MAX_BLOCKS) return escalate(step); // → §7
    await step.rerunOrPatch();
  }
}
```

The **verification subagent** (Claude Code level 4) is also worth borrowing for the post-run
"did this actually satisfy the goal?" check. It can ride on the existing
`task`/subagent infra already in `src/agent/`. Wire it as Stage 8 (M8.x) — a `/why` for the
whole plan, not just per-step.

### §2 — Right-sized decomposition ★

| | |
|---|---|
| Done | `todowrite` is the unit of decomposition; `upsertPlanFromTodos` persists each. |
| Gap | No Plan/Build mode split — every session is Build by default. |
| **Borrow** | **OpenCode's Tab-switch Plan↔Build primary agents.** ([harness-research §2]) |
| Plug into | New in `src/tui/` + `src/agent/`. No DB change. |

**Specific recommendation:** copy OpenCode's exact UX — **Tab cycles primary agents**, the
footer shows which one you're in. The Plan agent differs from Build only in its
**permission defaults**: `edit: ask`, `bash: ask` (everything that mutates asks). Plan still
has `read`/`grep`/`glob`/`ls` because exploration is the point.

This is cheap because Minima's agent already has beforeToolCall hooks; the mode is just a
policy bundle those hooks read. **The payoff is high** because today the harness can't tell
"the user wants exploration, not changes" from the prompt alone — it has to guess.

The Claude Code escape hatch travels with this: **"if you could describe the diff in one
sentence, skip the plan"**. Encode it as a hint in the system prompt, not a hard rule.

### §3 — Effort scales to complexity ★★

| | |
|---|---|
| Done | `max_turns` exists. |
| Gap | No per-agent budget; no graceful-cap behavior; no "two-corrections → reset" rule. |
| **Borrow** | **OpenCode's `steps` config + forced summarization on cap.** ([harness-research §3]) |
| Plug into | `Agent` class (`src/agent/`) + agent config schema. |

**Specific recommendation:** replace (or augment) `max_turns` with a `steps` field per agent
that, when hit, **injects a special system prompt** instructing the agent to summarize its
work and recommend remaining tasks — instead of hard-stopping. This converts hitting the cap
from a failure into a graceful handoff.

> "When the limit is reached, the agent receives a special system prompt instructing it to
> respond with a summarization of its work and recommended remaining tasks."
> — OpenCode docs ([opencode-agents])

Add the **Claude Code two-corrections rule** as advisory content in `AGENTS.md` (or
`packages/tui`'s equivalent): "If the user has corrected you twice on the same issue,
summarize what you learned and stop." This is advisory, not deterministic — but it's the
*single most useful* advisory rule for cost-control on a routed model.

Per-step token/tool-call accounting is already possible through the step id attribution (GT
stage 2). Surface it in the footer like Claude Code's custom status line.

### §4 — Persistent + visible ★★

| | |
|---|---|
| Done | Plan persisted + projected + DRIFT footer (GT stage 0–2). JSONL sessions. |
| Gap | No checkpoints (`/rewind`); no named sessions; no live status line for context %. |
| **Borrow** | **Claude Code's `/rewind` checkpoints + named sessions.** ([harness-research §4]) |
| Plug into | `src/session/` (extend the JSONL tree) + `src/tui/` (commands + status). |

**Specific recommendation:** the JSONL session tree already has the structure for this —
every assistant turn is an append. Add a **`/rewind <turn-id>`** command that:
1. Restores conversation to that point (drop later JSONL entries — or mark them reverted).
2. Optionally restores the file tree (snapshot on each `write`/`edit` — GT already attributes
   file writes to steps, so the snapshot key is the step id).

The **named sessions** piece is the cheapest win: `minima --resume <name>` instead of just
`--continue`. Pair with the existing `SessionManager`.

The **status line** for context-fill % is a small `src/tui/` addition that pays off
disproportionately because §3's whole premise is "context degrades as it fills" — the user
needs to *see* it filling.

### §5 — Replan, don't railroad ★★

| | |
|---|---|
| Done | New `todowrite` calls upsert remaining steps — replan is structurally possible. |
| Gap | No "revert + re-prompt" primitive; no two-session Writer/Reviewer. |
| **Borrow** | **OpenCode's `/undo` (revert + show original prompt).** ([harness-research §5]) |
| Plug into | Reuses §4's checkpoint infra. |

**Specific recommendation:** `/undo` is the cleanest replan UX I've seen. It does two things
in one action: reverts changes **and re-shows your original message** so you can edit it and
retry. This is meaningfully better than "Esc + manually revert + retype".

The deeper borrow — **Claude Code's Writer/Reviewer two-session pattern** — is the right
shape for Minima's routed-model world: Writer on the cheapest model that can do the work,
Reviewer on a stronger model in a fresh context. The Minima router already picks models per
task; formalize the **two-session review** as a documented workflow (Stage 8 candidate).

### §6 — Tool/task match ★★★

| | |
|---|---|
| Done | Five tools (read/write/edit/bash/ls); per-step tool attribution via GT. |
| Gap | No permission grammar; no per-step tool allowlist; no task delegation control. |
| **Borrow** | **OpenCode's glob permission grammar + `task` permissions.** ([harness-research §6]) |
| Plug into | `src/tools/` permission wrapper + step schema. |

**Specific recommendation:** this is the biggest *unfilled* lever. Minima already attributes
every tool call to a step — extend that to **enforce** rather than just record:

```ts
// step carries an optional allowed-tools list (M3.1 sibling)
type Step = {
  // ...existing fields
  tools?: ToolPattern[];   // glob-matched, e.g. ["bash:pytest *", "edit:src/auth/**"]
};

// in the beforeToolCall hook:
if (step.tools && !matchesAnyPattern(currentCall, step.tools)) {
  return { decision: 'deny', reason: 'off-plan tool for this step' };
  // ↑ also surfaces as DRIFT — already a known concept in GT
}
```

The **`task` permissions** idea (a primary agent can only invoke certain subagents) is the
multi-agent version of the same primitive. Even if Minima doesn't have first-class
subagents today, defining the grammar now means adding them later doesn't redesign the
permission model.

The Anthropic SWE-bench poka-yoke finding ([anthropic-agents] Appendix 2) applies directly
to Minima's tools: review the **read/write/edit/bash/ls** tool descriptions and argument
shapes for footguns. (Example: does `edit` take absolute paths or relative? Pick one, make
it absolute — same fix Claude Code made.)

### §7 — Stop conditions ★★★

| | |
|---|---|
| Done | Confidence tiers 🟢/🟡/🔴 are designed (M6.2 not yet wired). |
| Gap | No `doom_loop`-equivalent; no Stop-hook with N-strike override; no per-failure-kind handling. |
| **Borrow** | **OpenCode's `doom_loop` permission + Claude Code's Stop hook with override.** ([harness-research §7]) |
| Plug into | Permission layer + M6.2 tier→behavior wiring. |

**Specific recommendation — three deterministic guards, all in the permission layer:**

1. **`doom_loop` primitive.** Track the last N tool calls; when the same call (tool + args
   hash) repeats 3× consecutively, fire the §7 escalation. This catches the single most
   common spiral — agent convinced that running the same failing command again will help.
   OpenCode's default is `"ask"`; for Minima route it through the confidence tier: 🟡 on
   first detection, 🔴 on second.

2. **Stop hook with N-strike override** (cross-references §1). The verify-check blocks
   step-done until red→green; cap blocks at N (default 3 for GT, configurable per step); on
   cap-hit, trigger escalation, **not** silent success.

3. **Per-failure-kind handling** à la Claude Code's `StopFailure` matcher. The agent core
   already distinguishes tool failure from API failure; expose those as matchable kinds so
   different failures route differently (rate-limit → back off + retry; auth → escalate
   immediately; tool-error → replan).

---

## Part 2 — The prioritized roadmap

Borrowings, ranked by leverage (effected improvement ÷ implementation cost), with the Linear
issue where one exists.

| # | Borrow | Property | Cost | Leverage | Wire into |
|---|---|---|---|---|---|
| 1 | **`doom_loop` primitive** | §7 | S | ★★★ | New in `src/agent/` permission layer |
| 2 | **Stop hook with N-strike override** | §1+§7 | M | ★★★ | M3.2 + M4.1 (MUB-112, -114) |
| 3 | **Per-step `tools` allowlist (glob)** | §6 | M | ★★★ | Extends M3.1 (MUB-111) |
| 4 | **`steps` cap with forced summarization** | §3 | S | ★★ | `Agent` class config |
| 5 | **Plan↔Build primary agents (Tab)** | §2 | M | ★★ | `src/tui/` + agent mode policy |
| 6 | **`/undo` revert + re-prompt** | §5 | M | ★★ | Reuses §4 checkpoints |
| 7 | **`/rewind` checkpoints** | §4 | L | ★★ | `src/session/` snapshot + restore |
| 8 | **Named sessions + status line** | §4 | S | ★ | `src/tui/` + `src/cli/main.ts` |
| 9 | **Verification subagent** (whole-plan) | §1 | L | ★ | Stage 8 (M8.x) |
| 10 | **Poka-yoke audit of read/write/edit/bash/ls descriptions** | §6 | S | ★ | `src/tools/` |

The **top three** are all in the deterministic layer and all plug into stages that are
already in flight (M3–M4) — that's not a coincidence. The research's biggest finding
([harness-research](#cross-cutting-pattern)) is that the deterministic layer is what
separates "demo-grade" from "production-grade"; Minima is right at that boundary now.

---

## Part 3 — Three concrete borrow patterns, expanded

### Pattern A — "Stop hook + N-strike override" (Claude Code)
**Why it works in CC:** the user gets to walk away because the loop closes on its own —
check fails, agent iterates, check passes, turn ends. The override (8 consecutive blocks)
guarantees termination even when the check is wrong or the fix is beyond the model.

**How to size N for Minima:** CC's N=8 is sized for *turns*; Minima's verify-check is
per-*step*, and steps are smaller. **N=3** is the right default. Make it per-step
configurable in `plan_steps.verify_max_blocks`.

**Why this beats "just trust the model":** without it, the model's only signal is "looks
done" — exactly the failure mode §1 exists to prevent. With it, "looks done" is not a
terminal state.

### Pattern B — "doom_loop permission" (OpenCode)
**Why it works in OC:** it's the only mechanism in any harness that detects spirals by
*shape* rather than by count. Three identical tool calls in a row is a near-perfect signal
that the model has fixated on a broken approach. Permission-gated so the user gets to
approve-or-deny the next iteration.

**How to wire in Minima:** keep a ring buffer of the last 3 tool-call hashes
(`tool_name + sorted_args_hash`) in the agent core. On a 3-match, fire the same code path as
a 🔴 confidence tier. Because GT already attributes calls to steps, you also get to record
this in the `gates` table — which means **Minima's routing layer learns** that this
(model, step-kind) combination tends to spiral.

### Pattern C — "Glob permission grammar + per-step allowlist" (OpenCode)
**Why it works in OC:** rules are easy to write ("`git push`: ask") and the **last-match-wins**
semantics make composition predictable. Per-agent overrides make Plan/Build split a config
change, not a code change.

**How to wire in Minima:** Minima's step already carries `verify`; add an optional `tools`
field with the same glob grammar. Default = inherit (current behavior). When set, the
beforeToolCall hook enforces it and writes a DRIFT signal on violation. This closes the loop
between "the plan says what tools each step needs" (§6 of the plan template in
`playbook.md`) and "the harness enforces it".

The deeper payoff: this lets a Minima **plan be statically analyzable**. You can grep a
plan for steps whose declared tools don't include the tool that would actually produce the
`verify` check — catching the "searching the web for Slack-only info" failure before any
code runs.

---

## Part 4 — What NOT to borrow (and why)

For symmetry — these came up but don't fit Minima:

- **Claude Code's `/goal` condition as a separate evaluator model.** Too expensive for a
  routed-model setup; the verify-check on each step is the local equivalent and cheaper.
- **OpenCode's experimental `policies` (`provider.use`).** Minima's *whole job* is provider
  selection; denying a provider via policy would fight the router. (You might want the
  *opposite* — a `provider.prefer` hint to the router — but that's a Minima feature, not a
  borrow.)
- **Codex Cloud's VM-isolated environment.** Minima is a local-first harness; the
  sandboxing story is the user's machine, not a hosted VM.
- **Cursor's IDE-run/test integration.** Minima is a CLI/TUI; the verify primitive should be
  a shell-out (`runCheck(cmd)`), not an IDE message.

---

## Part 5 — One-screen summary

```
Minima's harness today:  advisory layer ✓   deterministic layer ⬜ (in flight, GT stage 3-8)

Borrow the three highest-leverage mechanisms from production harnesses:

  1. doom_loop (OpenCode §7)         — 3× repeated tool call → escalate
                                       wire into: agent core + gates table
                                       cost: small       leverage: ★★★

  2. Stop hook w/ N-strike (CC §1)   — verify blocks done; cap blocks at N=3
                                       wire into: M3.2 runCheck + M4.1 block-done
                                       cost: medium     leverage: ★★★

  3. Per-step tool allowlist (OC §6) — glob patterns enforced in beforeToolCall
                                       wire into: M3.1 step schema + DRIFT
                                       cost: medium     leverage: ★★★

All three live in the deterministic layer and all three plug into stages already in flight.
That's the boundary Minima is crossing right now — these are what get it across.
```

For the why behind each borrow, see `harness-research.md`. For the plan-shape that these
mechanisms enforce, see `characteristics-of-successful-plans.md` and `playbook.md`.
