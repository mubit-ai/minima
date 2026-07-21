# Characteristics of Plans That Actually Execute

> The synthesis. For each property: what it is, why it works, the failure mode when it's
> missing, and the evidence. Sources are referenced by short tag — see `sources.md`.

---

## The seven properties at a glance

```
   ┌─────────────────────────────────────────────────────────────────────┐
   │                     A PLAN THAT EXECUTES                            │
   ├─────────────────────────────────────────────────────────────────────┤
   │  1. Verifiable steps        each step → checkable artifact          │
   │  2. Right-sized decomposition  small enough to be unambiguous,      │
   │                                 big enough to mean something        │
   │  3. Effort scales to complexity  budget is part of the plan         │
   │  4. Persistent + visible    survives truncation, projected each turn│
   │  5. Replan, don't railroad  the plan updates with new evidence      │
   │  6. Tool/task match         every step names the tool it needs      │
   │  7. Stop conditions         iteration cap + ask-for-help threshold  │
   └─────────────────────────────────────────────────────────────────────┘
```

If a plan has all seven, it almost always runs. If it's missing more than two, it almost
never does. The rest of this doc explains each.

---

## 1. Verifiable steps

> **A step isn't done because the agent says so. A step is done because the environment
> changed in a way that can be checked.**

### What it is
Every step in the plan produces (or contributes to) a **checkable artifact**: a passing test,
an emitted file, a command's exit code, a diff that compiles. The plan names *what to check*,
not just *what to do*.

### Why it works
LLMs hallucinate completion. Without verified evidence, "I did the step" and "the step is actually
done" diverge fast, and the divergence compounds — step 4 builds on a step 3 the agent *thinks*
it finished. Verifiability breaks that compounding. The Anthropic SWE-bench agent loops on
test results as feedback precisely because test output is **evidence from the environment**
— not the model's self-report ([anthropic-agents]).

### The failure mode when it's missing
- Agent marks a step complete, moves on, builds on sand.
- Reviewer can't tell whether the work happened.
- Late failures are expensive — you discover at step 8 that step 2 was broken.

### Evidence
- Anthropic's two canonical coding-agent success criteria: code is **verifiable through
  automated tests**, and the agent **iterates on solutions using test results as feedback**
  ([anthropic-agents], Appendix 1B).
- Minima's own Big Plan contract freezes this exact idea: a step is verified only if a check
  went **red→green because of this step's code**, not a fake test the agent quietly wrote.

### What to write into the plan
For each step, one line: `verify: <command or observable check>`. If you can't fill it in,
the step is too vague — keep decomposing.

---

## 2. Right-sized decomposition

> **Decompose until each subtask has one objective, one output format, one tool set, and a
> clear boundary from its siblings.**

### What it is
The plan is split into subtasks that are neither too coarse ("build the feature") nor too
fine ("write a function"). Each subtask carries:
- **Objective** — what success looks like, concretely.
- **Output format** — what artifact comes back.
- **Tools/sources** — which tools are in scope.
- **Boundary** — where this subtask ends and the next begins.

### Why it works
Plan-and-Solve ([plan-and-solve]) shows that *devising a plan to divide the task into smaller
subtasks, then carrying them out* beats undifferentiated "let's think step by step" on every
one of ten reasoning datasets. But Anthropic's multi-agent post ([anthropic-multi-agent])
adds the crucial qualifier: vague subtask descriptions make agents **duplicate work or leave
gaps**. "Research the semiconductor shortage" given to three subagents produced three
overlapping investigations of 2025 supply chains. Decomposition has to be *specific*, not
just *present*.

### The failure mode when it's missing
- **Too coarse**: the agent has to plan *inside* the step, which is just deferring planning —
  you get a plan that's really one big step.
- **Too fine**: the plan is 60 micro-steps; the agent can't keep the through-line in mind and
  drifts.
- **Vague boundaries**: siblings overlap (duplicate work) or don't touch (gaps).

### Evidence
- Plan-and-Solve: zero-shot decomposition + execution beats Zero-shot-CoT by a large margin
  across 10 datasets ([plan-and-solve]).
- Anthropic multi-agent: each subagent needs *objective, output format, tool guidance, and
  clear task boundaries*. Without these, agents "duplicate work, leave gaps, or fail to find
  necessary information" ([anthropic-multi-agent], prompting principle #2).

### What to write into the plan
For every step with children, assert the four properties above. If two sibling steps could
plausibly produce the same artifact, redraw the boundary.

---

## 3. Effort scales to complexity

> **A plan for a 1-step lookup and a plan for a 10-source investigation are different shapes.
> Build the budget into the plan.**

### What it is
The plan carries an **effort budget** — number of subagents, tool-call cap, token budget,
time cap — calibrated to the complexity of the task. Agents are bad at judging appropriate
effort on their own, so the plan has to do it for them.

### Why it works
Two findings converge here:
- Token usage alone explains **80% of the variance** on BrowseComp, and token usage + tool
  calls + model choice explain **95%** ([anthropic-multi-agent]). Underbudgeting tokens is
  the single biggest cause of failure.
- Without explicit scaling rules, agents either **over-invest in simple queries** (50
  subagents to look up one fact) or **under-invest in hard ones** (give up after one search).
  Embedding "simple = 1 agent / 3–10 calls; comparison = 2–4 agents; complex = 10+" directly
  in the prompt fixed both failure modes ([anthropic-multi-agent], principle #3).

### The failure mode when it's missing
- Burn the entire budget on step 1 and have nothing left for the rest.
- Refuse to spend enough on a hard step and produce a shallow answer.

### Evidence
- BrowseComp variance decomposition ([anthropic-multi-agent]).
- Explicit scaling heuristics in the orchestrator prompt ([anthropic-multi-agent], principle
  #3).

### What to write into the plan
A line at the top: `effort: {agents, tool_calls, tokens, time} — calibrated because <reason>`.
The reason matters: it forces you to justify the budget against complexity, not pick a number.

---

## 4. Persistent + visible

> **The plan is the source of truth, not a scratchpad. It lives outside the context window and
> is projected back in every turn.**

### What it is
Two things, related:
- **Persistence**: the plan is written to durable storage (a DB, a file, memory) the moment
  it's created, not held in the model's working memory.
- **Visibility**: the plan is re-projected into context every turn, and shown to the observer
  (human or harness) so drift is observable.

### Why it works
Anthropic's lead research agent **saves its plan to memory immediately** because "if the
context window exceeds 200,000 tokens it will be truncated and it is important to retain the
plan" ([anthropic-multi-agent], process diagram caption). When the plan lives only in the
context, one truncation silently amputates the strategy. Persistence makes the plan
re-loadable; visibility makes drift a visible event instead of a silent one.

The Minima Big Plan implementation is built around this exact principle: the plan is persisted
(stage 1, M1.1) and projected back each turn (M1.2), with a step X/N footer (M1.3) and a
DRIFT indicator when work goes off-plan (M2.3).

### The failure mode when it's missing
- Context fills up, plan gets truncated, agent forgets what it was doing and free-associates.
- Observer can't tell whether the agent is still on-plan.
- No audit trail — you can't reconstruct what happened.

### Evidence
- Anthropic Research lead agent's first action is to save the plan to memory
  ([anthropic-multi-agent]).
- Big Plan stages 1–2 are entirely about persistence and visibility of the plan.
- Anthropic's three core agent principles: simplicity, **transparency** (explicitly showing
  planning steps), ACI ([anthropic-agents], Summary).

### What to write into the plan
A storage location (`store: <where>`) and a projection rule (`re-project: every turn /
on-demand`). If neither is defined, the plan is a scratchpad, not a plan.

---

## 5. Replan, don't railroad

> **A plan is a hypothesis about the path. It has to be allowed to be wrong, and the agent
> has to be allowed to revise it.**

### What it is
The plan is not a script. Each step's outcome can update the remaining steps — drop them,
reorder them, add new ones, change the budget. The plan must support **replanning**, not just
execution.

### Why it works
Three papers converge on this:
- **ReAct** ([react]): interleaving reasoning traces with actions lets the model *induce,
  track, and update* its plan as observations arrive. Static plans can't.
- **Reflexion** ([reflexion]): after a failed trial, the agent verbally reflects on what went
  wrong, stores the reflection in episodic memory, and tries again with a better plan. 91%
  pass@1 on HumanEval vs. 80% for the non-reflective GPT-4 baseline.
- **Tree of Thoughts** ([tot]): for problems where the first move matters, the agent explores
  multiple partial plans, evaluates them, and commits (or backtracks). Game of 24 jumped from
  4% (CoT) to 74% (ToT).

The Anthropic multi-agent post makes the same point at the system level: the lead agent
synthesizes results and **"decides whether more research is needed — if so, it can create
additional subagents or refine its strategy"** ([anthropic-multi-agent]).

### The failure mode when it's missing
- The plan was wrong at step 2 but the agent executes steps 3–10 anyway because the plan said
  to.
- A subagent discovers a better path but can't act on it because the plan doesn't allow
  branching.
- One failure cascades because there's no recovery.

### Evidence
- ReAct: reasoning + acting interleaved beats either alone; reasoning traces "help the model
  induce, track, and update action plans" ([react]).
- Reflexion: verbal self-reflection turns 80% → 91% on HumanEval ([reflexion]).
- Tree of Thoughts: 4% → 74% on Game of 24 by exploring multiple reasoning paths ([tot]).

### What to write into the plan
A replan policy: `replan: after each step / on evidence X / never`. Almost always the first
two. Pure `never` is appropriate only for fully deterministic workflows.

---

## 6. Tool/task match

> **A step that needs information from Slack but only plans to use web search is broken before
> it starts.**

### What it is
Every step names the tools it will use, and those tools must be **capable of producing what
the step needs**. The plan validates the match before execution begins.

### Why it works
Anthropic is blunt: **"an agent searching the web for context that only exists in Slack is
doomed from the start"** ([anthropic-multi-agent], principle #4). Tool choice is "often
strictly necessary" for correctness, not just efficiency. With MCP servers multiplying the
tool surface, this gets worse, not better — agents see "wildly varying quality" in tool
descriptions and pick wrong ones. Good plans constrain the choice up front.

This is also half of the **agent-computer interface (ACI)** argument from Building Effective
Agents ([anthropic-agents], Appendix 2): invest as much effort in the agent-computer
interface as you would in a human-computer interface. Tool ergonomics — poka-yoke arguments,
absolute paths, format near to natural text — determine whether the plan executes cleanly.

### The failure mode when it's missing
- Agent picks a tool that can't possibly return the needed info, spends the budget on it,
  fails.
- Two tools look similar; agent oscillates between them.
- Tool description is bad enough that the agent misuses it consistently.

### Evidence
- Anthropic multi-agent principle #4: tool design and selection are critical ([anthropic-multi-agent]).
- Building Effective Agents: the SWE-bench team **spent more time optimizing tools than the
  prompt**; switching relative paths to absolute fixed a class of bugs entirely
  ([anthropic-agents], Appendix 2).

### What to write into the plan
For each step: `tools: [<tool>, <tool>]`. Before executing, sanity-check that each named tool
can in principle return what the step's `verify` checks for.

---

## 7. Stop conditions

> **Plans without termination criteria spiral. Define when to stop, when to ask, and when to
> declare failure.**

### What it is
Three things:
- **Success criterion**: what observable state means the whole plan is done.
- **Iteration cap**: max steps / max tool calls / max tokens before force-stopping.
- **Escalation threshold**: the condition under which the agent stops and asks a human (or a
  stronger model) instead of continuing.

### Why it works
Anthropic's agent definition includes explicit stopping conditions as part of what makes an
agent controllable: "it's also common to include stopping conditions (such as a maximum number
of iterations) to maintain control" ([anthropic-agents], the Agents section). Without them,
the autonomous nature of agents means **compounding errors** and runaway cost — multi-agent
systems already use ~15× the tokens of chat, and a spiral multiplies that further
([anthropic-multi-agent]).

Minima's Big Plan confidence tiers (🟢/🟡/🔴) are exactly this: 🟢 glide, 🟡 flag, 🔴 stop and ask.

### The failure mode when it's missing
- Agent loops forever, burning tokens, when one "I don't know, ask the human" would have
  solved it.
- A failing step is retried 50 times with no escalation.
- There's no definition of "done" so the agent either stops too early or never stops.

### Evidence
- Building Effective Agents: agents terminate on completion **or on stopping conditions like
  max iterations** ([anthropic-agents]).
- Multi-agent systems carry higher cost and compounding-error risk, making caps non-optional
  ([anthropic-multi-agent]).

### What to write into the plan
Three lines at the top:
```
done:    <observable end state>
cap:     <max iterations / tokens / tool calls>
escalate: <condition that triggers "stop and ask">
```
If you can't write `done`, the plan doesn't have a goal — it has a direction.

---

## Properties vs. properties — which matter most?

If you can only enforce three, enforce these (in order):

1. **Verifiable steps** (§1) — without this, nothing else can even be measured.
2. **Stop conditions** (§7) — without this, failures become catastrophes.
3. **Persistent + visible** (§4) — without this, you lose the plan to truncation and can't
   observe drift.

The other four (decomposition, effort scaling, replanning, tool match) are *quality
multipliers* — they take a working plan from "completes" to "completes well, fast, cheaply".

---

## The one figure to remember

```
                    plan quality
                         ▲
                         │
            executes ─ ─ ─┼─────────────────  ← 7/7 properties
                         │              ╱
                         │            ╱
                         │          ╱
                         │        ╱
                         │      ╱
                         │    ╱
            fails   ─ ─ ─│──╱───────────────  ← ≤3/7 properties
                         │
                         └──────────────────────► properties present
```

The transition from "usually fails" to "usually executes" is steep. Adding the first 2–3
properties moves you most of the way; the last few are the difference between "works" and
"works reliably at scale".
