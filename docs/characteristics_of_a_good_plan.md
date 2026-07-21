# Characteristics of a Good Plan

This is the ruleset behind the **A6 static plan lint / poka-yoke audit**
(`packages/tui/src/minima/plan_lint.ts`). It is both the human spec ("what makes a plan good") and
the machine spec (each characteristic maps to a lint rule with a severity). The audit runs at
`/plan finalize` and on demand via `/audit`; **blocker**-severity findings refuse finalize unless
you pass `/plan finalize --force`.

A plan here is a list of **steps**, each carrying three things:

- **action** — the concrete change to make.
- **verify** — a shell command that is RED before the step and GREEN after (the verifiable-steps
  contract). This is the evidence the step actually landed.
- **tools** — the minimal per-step tool allowlist (A6). While the step is in progress the harness
  hard-blocks any mutating tool not on the list. Read-only tools (`read`/`ls`/`glob`/`grep`) and the
  control tools (`todowrite`/`question`) are always allowed and need not be listed.

Poka-yoke (ポカヨケ, "mistake-proofing") is the guiding idea: catch the mistake-prone shapes
**before** execution, when they are cheap to fix, rather than after a model has acted on them.

---

## The characteristics (and their lint rules)

| # | Characteristic | Rule | Severity | Why |
| - | -------------- | ---- | -------- | --- |
| 1 | **The plan has steps.** | `empty-plan` | 🔴 blocker | A plan with no implementation steps can't be executed or verified. |
| 2 | **Every step that produces something checkable carries a real `verify`.** | `no-verify` | 🟡 warn | A step with no check can't be proven done — decompose it, or accept it as unverified scaffolding. (Advisory, not a block: genuinely uncheckable scaffolding is allowed.) |
| 3 | **The check actually gates.** A `verify` that always passes (`true`, `:`, `exit 0`, a bare `echo`/`printf`) is fabricated evidence. | `non-gating-verify` | 🔴 blocker | A green that can never be red proves nothing. This is the audit's core poka-yoke: a fake check is worse than no check because it *looks* verified. A real check chained after a noop (`echo building && bun test`) is fine — the test still gates. |
| 4 | **Each step's check is its own.** | `duplicate-verify` | 🟡 warn | A single check reused verbatim across steps rarely proves each one individually. |
| 5 | **Steps are concrete enough to verify.** A one- or two-word action, or a vague verb with no object ("refactor", "cleanup the code"), can't be checked. | `vague-action` | 🟡 warn | If you can't name a check for it, the step is too coarse — split it into pieces you can. |
| 6 | **The tool allowlist names real tools.** | `unknown-tool` | 🔴 blocker | A typo'd tool name (`edt`) never matches, so the real tool is blocked at runtime and the step wedges. Catching the typo at authoring time is pure mistake-proofing. |
| 7 | **A writing step scopes its tools.** A checkable step that mutates code but declares no allowlist runs unrestricted. | `no-allowlist` | 🟢 info | Advisory nudge to scope the step to the tools it needs (e.g. `edit`, `bash`) so an off-scope tool can't slip through. Never a block — an unrestricted step is the historical default. |

Severity legend: 🔴 **blocker** refuses `/plan finalize` (override with `--force`) · 🟡 **warn** and
🟢 **info** are advisory only.

---

## How it connects to the rest of the Big Plan spine

- **Per-step tool allowlist (task permissions).** `tools` is persisted on `plan_steps.tools`
  (schema v8), authored by the planning council (a `tools:` line per step in `BigPlan.md`) or by
  the agent via `todowrite` (`"tools": ["edit","bash"]`, sticky like `verify`). Enforcement is in the
  dispatcher (`tool_permissions.ts` → `bigPlanHooks`), gated by `MINIMA_TUI_TOOL_ALLOWLIST`
  (default on when Big Plan is on). A step with no allowlist is unrestricted, so nothing changes
  for plans that don't use the feature.
- **The audit does not fabricate quality.** It reasons only about the plan's *shape* — it never runs
  a check or judges outcomes. Runtime verification (red→green, provenance, coverage, tamper, the A5
  fabrication floor) remains the source of truth for whether a step actually landed.
- **Advisory-by-default, blocker-where-fabrication.** Consistent with the planner bridge's
  nudge/advise stance, only the two rules that catch *fabricated* or *self-defeating* plans
  (`non-gating-verify`, `unknown-tool`) plus the structural `empty-plan` block; everything else
  advises.

Everything above is behind `MINIMA_TUI_BIG_PLAN` and on by default.
