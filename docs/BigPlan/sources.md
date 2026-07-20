# Sources — Annotated Bibliography

> Where each claim in `characteristics-of-successful-plans.md` and `playbook.md` came from.
> Each entry: the source, why it's trustworthy, and the **one takeaway** used in this folder.

---

## Industry / engineering (peer-practice, production-validated)

### `[anthropic-agents]` — Building Effective Agents
- **Source**: Anthropic Engineering, Dec 19 2024.
  <https://www.anthropic.com/engineering/building-effective-agents>
- **Why trustworthy**: Synthesis of Anthropic's own agent work plus "dozens of teams building
  LLM agents across industries". The SWE-bench results cited are reproduced and benchmarked.
  Authors (Erik S., Barry Zhang) lead Claude's agent tooling.
- **Takeaways used here**:
  - Three principles for agents: **simplicity**, **transparency** (explicit planning steps),
    and careful **ACI** (agent-computer interface). → §4, §6.
  - Workflows vs. agents: workflows are predictable for well-defined tasks; agents earn their
    autonomy only when flexibility is required. → the `shape` field in the plan template.
  - Agents terminate "upon completion, but it's also common to include stopping conditions
    (such as a maximum number of iterations)". → §7.
  - Coding agents work because "code solutions are verifiable through automated tests" and the
    agent "iterates on solutions using test results as feedback". → §1.
  - Appendix 2: the SWE-bench team "spent more time optimizing tools than the overall prompt";
    forcing absolute filepaths fixed a whole class of bugs. → §6, poka-yoke.

### `[anthropic-multi-agent]` — How we built our multi-agent research system
- **Source**: Anthropic Engineering, Jun 13 2025.
  <https://www.anthropic.com/engineering/multi-agent-research-system>
- **Why trustworthy**: First-party postmortem of the Research feature in production, with
  internal eval numbers (e.g. +90.2% over single-agent Opus 4) and a BrowseComp variance
  decomposition based on real data.
- **Takeaways used here**:
  - **Token usage explains 80% of the variance** on BrowseComp; tokens + tool calls + model
    choice explain 95%. → §3, the budget is the plan.
  - Subagents need *objective, output format, tool guidance, and clear task boundaries* —
    without them they "duplicate work, leave gaps, or fail to find necessary information". →
    §2.
  - Effort-scaling heuristics embedded in the prompt: 1 agent/3–10 calls for fact-finding;
    2–4 subagents for comparisons; 10+ for complex research. → §3, the `shape` field.
  - Lead agent **saves its plan to memory first**, because context beyond 200k tokens gets
    truncated. → §4.
  - "An agent searching the web for context that only exists in Slack is doomed from the
    start." → §6.
  - End-state evaluation over step-by-step: agents may take "completely different valid paths
    to reach the same goal". → §5, alternative paths to the goal are legitimate.

---

## Academic (peer-reviewed, reproducible)

### `[plan-and-solve]` — Plan-and-Solve Prompting
- **Source**: Wang et al., ACL 2023. arXiv:2305.04091.
  <https://arxiv.org/abs/2305.04091> · code: <https://github.com/AGI-Edgerunners/Plan-and-Solve-Prompting>
- **Why trustworthy**: Peer-reviewed at ACL. Reports gains on **ten datasets across three
  reasoning tasks**, comparing to Zero-shot-CoT, 8-shot CoT, and Program-of-Thought.
- **Takeaway used here**: The foundational empirical evidence that **devising a plan to divide
  the task into subtasks, then executing** beats undifferentiated "think step by step" on
  every dataset tested. → §2. The contribution is the *plan* phase, not just more reasoning.

### `[react]` — ReAct: Synergizing Reasoning and Acting in Language Models
- **Source**: Yao et al., ICLR 2023. arXiv:2210.03629.
  <https://arxiv.org/abs/2210.03629> · project: <https://react-lm.github.io>
- **Why trustworthy**: Peer-reviewed at ICLR. One of the two most-cited agent papers. Beats
  CoT and imitation/RL baselines on HotpotQA, Fever, ALFWorld, and WebShop with only 1–2
  in-context examples.
- **Takeaway used here**: Interleaving reasoning traces with actions lets the model "induce,
  track, and update action plans" as observations arrive — and overcomes hallucination and
  error propagation. → §5. A plan that can't be updated as observations arrive is a railroad.

### `[reflexion]` — Reflexion: Language Agents with Verbal Reinforcement Learning
- **Source**: Shinn et al., NeurIPS 2023. arXiv:2303.11366.
  <https://arxiv.org/abs/2303.11366>
- **Why trustworthy**: Peer-reviewed at NeurIPS. Reproducible gains: 91% pass@1 on HumanEval
  vs. 80% for the GPT-4 baseline without reflection.
- **Takeaway used here**: After a failed trial, the agent verbally reflects on *what went
  wrong*, stores the reflection in episodic memory, and tries again with a better plan. This
  is the strongest evidence that **replan-after-failure beats retry-after-failure**. → §5.

### `[tot]` — Tree of Thoughts: Deliberate Problem Solving with LLMs
- **Source**: Yao et al., NeurIPS 2023. arXiv:2305.10601.
  <https://arxiv.org/abs/2305.10601> · code: <https://github.com/princeton-nlp/tree-of-thought-llm>
- **Why trustworthy**: Peer-reviewed at NeurIPS. Reproducible, dramatic gain on Game of 24:
  4% (CoT, GPT-4) → 74% (ToT). Code and prompts all public.
- **Takeaway used here**: When the **first decision is pivotal**, exploring multiple partial
  plans and evaluating them before committing beats committing to one path early. → §5,
  "explore multiple reasoning paths and self-evaluate".

---

## First-party / in-repo

### Minima Ground-Truth Plan
- **Source**: `docs/PLAN/ground-truth-plan.md` (this repo). Linear: Minima – Big Plan.
- **Why relevant**: The empirical, in-production implementation of properties §1, §4, §5, §7.
  Used as the worked example at the end of `playbook.md`.
- **Key mappings** (also reproduced in `playbook.md` Part 6):
  - §1 verifiable steps → `plan_steps.verify` + frozen GT contract, red→green requirement.
  - §4 persistent + visible → stages 0–2 (persist + project + DRIFT footer).
  - §5 replan → new `todowrite` calls upsert remaining steps.
  - §7 stop conditions → confidence tiers 🟢/🟡/🔴 → silent / flag / stop-and-ask.

---

## What was deliberately *not* used

For transparency, here are adjacent sources considered but left out, and why:

- **LangChain / LlamaIndex docs**. Useful as framework docs, but they prescribe abstractions
  rather than report what makes plans execute. The Anthropic posts already cover the same
  ground from a first-party production perspective.
- **OpenAI "Practices for Guiding Agents" / agent guides**. Solid, but largely overlaps with
  `[anthropic-agents]` and `[anthropic-multi-agent]`; including both would duplicate the
  claims.
- **Lilian Weng, "LLM Powered Autonomous Agents"** (lilianweng.github.io). Excellent
  *survey*, but it catalogues planning taxonomies (task decomposition, ReAct, Reflexion) that
  are already cited here at the source. Recommended as further reading.
- **Blog posts without reproducible numbers**. Excluded in favor of sources with measurable
  claims (BrowseComp variance, Game of 24 success rate, HumanEval pass@1, +90.2% on internal
  research eval).

If you want to extend this folder, the bar is: **a claim, evidence for the claim, and a
source the reader can verify**. Add to this file in the same format.
