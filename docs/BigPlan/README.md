# BigPlan — What Makes an Agent Plan Actually Work

> Research synthesis + playbook on the characteristics of plans that **execute successfully**
> for LLM agents. Built from the canonical literature (Anthropic engineering, ACL/NeurIPS/ICLR
> papers) and cross-checked against Minima's own Big Plan implementation.

---

## TL;DR (the one-screen version)

Plans fail for predictable reasons. The plans that **execute** share a small set of properties:

1. **Verifiable steps** — every step produces a checkable artifact (test, file, command exit
   code). The harness can tell *red* from *green*. The Big Plan implementation lives by this.
2. **Right-sized decomposition** — subtasks are small enough to be unambiguous, big enough to
   mean something. Neither "fix the bug" nor "type a character".
3. **Effort scales to complexity** — a 1-step lookup and a 10-step investigation are *different
   shapes* of plan. Embed the budget in the plan itself.
4. **Persistent + visible** — the plan survives context truncation and is projected back every
   turn so drift is observable, not hidden.
5. **Replan, don't railroad** — a plan is a hypothesis about the path. New evidence from the
   environment must be able to update it (ReAct / Reflexion).
6. **Tool/task match** — every step names the tool(s) it needs. A step that needs Slack but
   only has web search is a broken step.
7. **Stop conditions** — iteration cap, ask-for-help threshold, success criteria. Plans without
   these spiral.

The deep version: **[`characteristics-of-successful-plans.md`](./characteristics-of-successful-plans.md)**

The actionable checklist: **[`playbook.md`](./playbook.md)**

How production harnesses (Claude Code / Codex / OpenCode) satisfy the 7 properties:
**[`harness-research.md`](./harness-research.md)**

How to apply those practices in Minima's TUI harness: **[`minima-harness-application-guide.md`](./minima-harness-application-guide.md)**

Where each claim came from: **[`sources.md`](./sources.md)**

---

## File map

| File | What it's for | Read it if… |
|---|---|---|
| `README.md` (this) | Entry point, TL;DR, navigation | you want the 60-second answer |
| `characteristics-of-successful-plans.md` | The 7 properties, why each works, failure modes, evidence | you want to understand the theory |
| `playbook.md` | Step-by-step checklist + a plan template + scoring rubric | you're about to write a plan and want it to be good |
| `harness-research.md` | How Claude Code / Codex / OpenCode actually satisfy the 7 properties | you want to learn from production harnesses |
| `minima-harness-application-guide.md` | Gap analysis + prioritized roadmap for Minima's TUI harness | you're editing `packages/tui/` or the Big Plan contract |
| `workflow-diagrams.md` | Visual reference for the Big Plan loop (ledger, gates, confidence tiers) | you want to see the in-production flow |
| `sources.md` | Annotated bibliography with the key takeaway per source | you want to verify a claim or go deeper |

---

## How this connects to Minima

Minima's Big Plan implementation is **the empirical version of this research**: the agent
writes a plan, the harness verifies each step went **red→green
because of this step's code**, and the verdict feeds back into routing. The properties here are
why that architecture is shaped the way it is — particularly **(1) verifiable steps**, **(4)
persistence/visibility**, and **(5) replan capability**.

If you change the Big Plan contract, re-read `characteristics-of-successful-plans.md` §1, §4, §5
first.
