# How Coding-Agent Harnesses Satisfy the 7 Properties

> Companion to `characteristics-of-successful-plans.md`. This file maps each of the 7
> properties of an executable plan onto the **actual mechanisms** in production coding-agent
> harnesses — Claude Code, Codex, OpenCode, plus shorter notes on Cursor / Aider.
>
> Sources are inline (URLs at the bottom). Where a harness has no public doc for a property,
> it says so plainly rather than guessing.

The seven properties (see `characteristics-of-successful-plans.md`):
1. Verifiable steps · 2. Right-sized decomposition · 3. Effort scales to complexity ·
4. Persistent + visible · 5. Replan, don't railroad · 6. Tool/task match · 7. Stop conditions

---

## The matrix (TL;DR)

| Property | Claude Code | Codex | OpenCode |
|---|---|---|---|
| **§1 Verifiable** | tests/build/screenshots + `/goal` + **Stop hooks** + verification subagents | sandbox + apply-patch + auto-review | (none native — relies on prompt + Plan/Build split) |
| **§2 Decomposition** | **Plan mode** (Explore→Plan→Implement→Commit) | tasks/subagents/projects | **Plan vs Build primary agents** (Tab) + 3 subagents |
| **§3 Effort scaling** | `/clear`, auto-compaction, subagents, "skip plan if 1-sentence diff" | long-running work, scheduled tasks | **`steps` config** (max iterations → forced summarization) |
| **§4 Persistent + visible** | CLAUDE.md, named sessions, `/rewind` checkpoints, status line | AGENTS.md, memories, chronicle | AGENTS.md, JSONL sessions, `/undo`+`/redo`, shareable |
| **§5 Replan** | Esc + `/rewind` + "after 2 corrections, /clear" | task handoff, cloud↔local | `/undo` (revert + re-prompt), Plan↔Build cycle |
| **§6 Tool/task match** | `/permissions`, Skills, MCP, per-subagent tools, Plugins | plugins, MCP, hooks | **glob permissions** + per-agent + **task permissions** |
| **§7 Stop conditions** | Stop hooks, `/goal`, auto-mode aborts, StopFailure event | sandbox caps, security auto-review | **`steps`** + **`doom_loop` permission** (3× repeat trigger) |

**Takeaway #1:** No single harness is best at all seven. Claude Code owns §1, §4, §5;
OpenCode owns §3, §6, §7; Codex sits in between with the strongest **sandboxing** story.
**Takeaway #2:** The mechanisms cluster into two layers — *deterministic* (hooks, permissions,
caps, `doom_loop`) and *advisory* (CLAUDE.md/AGENTS.md, plan mode, subagents). Production
harnesses layer deterministic guards *under* advisory guidance.

---

## §1 — Verifiable steps

> A step isn't done because the agent says so. It's done because the environment changed in a
> way that can be checked.

### Claude Code — the gold standard
The Anthropic best-practices article devotes its **first** tip to this ([claude-code-bp]):

> "Give Claude a check it can run: tests, a build, a screenshot to compare. It's the
> difference between a session you watch and one you walk away from."

Four escalation levels, in order of setup cost:
1. **In the prompt** — "run the tests after implementing".
2. **`/goal` condition** — a separate evaluator re-checks it after every turn; Claude keeps
   working until it holds.
3. **Stop hook** — a deterministic script that runs your check and **blocks the turn from
   ending until it passes**. Claude Code overrides after **8 consecutive blocks** (a built-in
   stop condition, see §7).
4. **Verification subagent** — a fresh-context model tries to refute the result, so the agent
   doing the work isn't the one grading it.

And the rule that ties them together: **"Have Claude show evidence rather than asserting
success."** Test output, command + return code, screenshot — not "I did it".

### Codex
Codex is built around **`apply_patch`** + a **sandbox** with auto-review
([codex-doc-tree]). The sandbox makes "did this command run cleanly?" checkable by
construction (exit codes, blocked network). Codex Cloud runs in an isolated VM so the
environment itself is the verification surface. Auto-review (under Security → Auto-review)
acts as the post-run verification subagent.

### OpenCode
**No native verify primitive.** Verification is the user's responsibility — the prompt has to
ask for it. The **Plan vs Build** agent split (see §2) helps indirectly: Plan mode forces
"what would the check be?" to be answered before any code runs.

### Notes from elsewhere
- **Aider** uses git commits as the unit of verification — every change is a checkpoint you
  can diff and revert. The test-suite integration (`aider --test`) makes red→green an
  automatic loop.
- **Cursor agent** has a "verify" step in its planning flow but exposes it through the IDE
  run/test UI rather than as a deterministic harness hook.

---

## §2 — Right-sized decomposition

> Decompose until each subtask has one objective, one output format, one tool set, and a clear
> boundary from its siblings.

### Claude Code — the four-phase ritual
"Explore first, then plan, then code" ([claude-code-bp]) is the canonical decomposition:

| Phase | Mode | What happens |
|---|---|---|
| Explore | Plan mode | Claude reads files, answers questions, **no changes** |
| Plan | Plan mode | Detailed implementation plan; user edits it via `Ctrl+G` |
| Implement | Default mode | Code against the plan, verify as it goes |
| Commit | Default mode | Descriptive commit + PR |

The escape hatch is critical: **"If you could describe the diff in one sentence, skip the
plan."** Planning is overhead; it earns its keep only on multi-file or unfamiliar work.

### OpenCode — primary agents as decomposition modes
OpenCode hard-codes the split as **two primary agents** you toggle with **Tab**:
- **Build** — all tools enabled, the default for development.
- **Plan** — restricted: all file edits and bash default to `ask`, so analysis/suggestion
  only.

Three **subagents** handle delegation: **General** (multi-step research, can write),
**Explore** (read-only codebase search), **Scout** (read-only external docs/deps research).
Subagents are invoked automatically by primary agents or manually via `@mention`.

### Codex
The docs map a project hierarchy — **projects → chats → tasks** — plus explicit **Subagents**
and **Rules** for per-task scope ([codex-doc-tree]). Codex Cloud's **long-running-work** and
**scheduled-tasks** features lift decomposition out of a single session entirely: a "task" is
a first-class durable object with its own lifecycle.

### Notes from elsewhere
- **Claude Code subagents** (`/sub-agents`) live in `.claude/agents/*.md` with their own
  tools, model, and prompt — same pattern as OpenCode's subagents.

---

## §3 — Effort scales to complexity

> Token usage alone explains 80% of the variance on BrowseComp. Effort must scale to
> complexity.

### Claude Code — manage context aggressively
The headline constraint: **"Claude's context window fills up fast, and performance degrades as
it fills."** Mechanisms that follow:
- **`/clear` between unrelated tasks** — first listed pattern.
- **Auto-compaction** near context limits; `/compact <instructions>` for guided compaction.
- **Subagents for investigation** — explore in separate context, report back summaries. "When
  Claude researches a codebase it reads lots of files, all of which consume your context."
- **Two-corrections rule** — "If you've corrected Claude more than twice on the same issue in
  one session, the context is cluttered with failed approaches. Run `/clear`."
- **`--output-format stream-json --verbose`** for fanning out across files in CI/scripts.

The non-obvious move: **start wide, narrow later**. Investigate via subagent, *then* scope
down to implementation in the main context.

### OpenCode — the `steps` cap
Each agent has a **`steps` config** — "the maximum number of agentic iterations an agent can
perform before being forced to respond with text only" ([opencode-agents]).

> "When the limit is reached, the agent receives a special system prompt instructing it to
> respond with a summarization of its work and recommended remaining tasks."

This is the cleanest implementation of §3 in any harness I looked at: it makes the **budget
explicit per-agent** and converts hitting the cap from a hard failure into a *graceful
handoff* back to the user. Also `temperature` (0.1 for plan, 0.3 for build, 0.7 for
brainstorm) is effort-shaped.

### Codex
Codex exposes **reasoning effort** as a model parameter on reasoning models (Sol/Terra/Luna =
flagship/balanced/fast). The **speed** setting in agent config maps directly to §3.

---

## §4 — Persistent + visible

> The plan is the source of truth. It lives outside the context window and is projected back
> in every turn.

### Claude Code
- **CLAUDE.md** — "read at the start of every conversation". Hierarchical: `~/.claude/`,
  project root, parent dirs (monorepo), child dirs (lazy). Imports via `@path`.
- **Sessions** are first-class: `/rename` to treat them like branches; `claude --continue`
  picks up most recent, `claude --resume` to choose.
- **Checkpoints** — Claude snapshots files before each change. `/rewind` restores conversation
  only, code only, or both. **Checkpoints persist across sessions.**
- **Custom status line** to track context usage continuously.
- **Auto-compaction** preserves "code patterns, file states, and key decisions" — editable via
  CLAUDE.md ("When compacting, always preserve the full list of modified files…").

### OpenCode
- **AGENTS.md** — `/init` generates it; loaded every session.
- **Append-only JSONL session tree** + `SessionManager` (this is also what Minima TUI does —
  see `packages/tui/README.md`).
- **`/share`** — turns a conversation into a shareable link (visibility beyond the local
  machine).
- **`/undo` and `/redo`** — explicit state navigation.
- **Compaction agent** — hidden system primary agent that compacts long context automatically.

### Codex
- **AGENTS.md** (codex-doc-tree → Agent configuration → AGENTS.md) — same convention.
- **Memories** and **Chronicle** under Customization — durable cross-session state.
- **Codex Cloud** runs in isolated VMs, so the environment itself persists per task.

### Notes from elsewhere
- **Aider**'s chat history is a `.aider.chat.history.md` file (literally markdown); a
  separate `.aider.input.history` is readline-recall. Both are append-only and grep-able.

---

## §5 — Replan, don't railroad

> A plan is a hypothesis about the path. It has to be allowed to be wrong.

### Claude Code — course-correct early and often
This is the deepest treatment of §5 in any harness:
- **Esc** stops Claude mid-action; context is preserved so you can redirect.
- **`Esc + Esc` or `/rewind`** opens the rewind menu — restore conversation + code to any
  prior checkpoint, or summarize-from-here.
- **"Undo that"** lets Claude revert its own changes.
- **Two-corrections rule** again: after two failed corrections, the context is the problem —
  `/clear` and write a better initial prompt.
- **Writer/Reviewer pattern** across two sessions — fresh context is unbiased by what was just
  written.

### OpenCode
- **`/undo`** is the primary replan primitive: reverts changes and shows the original message
  so you can re-prompt. `/undo` stacks (`/undo` multiple times = multiple reverts).
- **Plan↔Build cycle** — go to Plan mode to rethink, back to Build to execute.
- **Child sessions for subagents** with keybinds to navigate (`session_child_first`,
  `session_child_cycle`, `session_parent`). You can dive into a subagent's reasoning, decide
  it went wrong, and redo.

### Codex
- **Task handoff** (Jun 2026 changelog) — "moves a task and its Git state between your local
  computer and a connected remote host". Replanning across environments.
- **Codex Cloud** + local CLI flow lets a task start in one environment and finish in another.

---

## §6 — Tool/task match

> A step that needs info from Slack but only plans to use web search is broken.

### Claude Code
Three layers stacked:
1. **`/permissions` allowlists** — explicit per-tool allow/ask/deny.
2. **Skills** (`.claude/skills/`) — domain knowledge + reusable workflows, loaded on demand
   (CLAUDE.md is for *always*; Skills are for *sometimes*).
3. **MCP servers** — external tools (Notion, Figma, DB, …) via `claude mcp add`.
4. **Custom subagents** (`.claude/agents/`) with **their own tool list**:
   ```markdown
   ---
   name: security-reviewer
   tools: Read, Grep, Glob, Bash
   model: opus
   ---
   ```
5. **Plugins** — bundle skills + hooks + subagents + MCP into one install.

The Anthropic SWE-bench finding: the team "spent more time optimizing tools than the overall
prompt" — poka-yoke argument (relative→absolute filepaths) — is the source citation for this
section ([anthropic-agents] Appendix 2).

### OpenCode — the cleanest permission grammar
Permission patterns are glob-matched against tool inputs ([opencode-perms]):

```json
"permission": {
  "bash": {
    "*": "ask",
    "git *": "allow",
    "npm *": "allow",
    "rm *": "deny",
    "grep *": "allow"
  },
  "edit": {
    "*": "deny",
    "packages/web/src/content/docs/*.mdx": "allow"
  }
}
```

Rules: **last matching rule wins**; `*` first, then specifics. Per-agent overrides. And the
killer feature for multi-agent: **`task` permissions** control which subagents a primary
agent may invoke via the Task tool:

```json
"permission": {
  "task": {
    "*": "deny",
    "orchestrator-*": "allow",
    "code-reviewer": "ask"
  }
}
```

This is the cleanest implementation of "tool/task match at the plan level" — it makes the
*delegation graph itself* a permissioned object.

### Codex
- **Plugins** and **MCP** ([codex-doc-tree]).
- **Hooks** (parallel to Claude Code's hooks).
- **Profiles** under Permissions — preset permission bundles.

---

## §7 — Stop conditions

> Plans without termination criteria spiral.

### Claude Code
- **Stop hook** runs your check as a script and blocks the turn from ending until it passes.
  Claude Code **overrides after 8 consecutive blocks** — a built-in cap so a flaky check
  doesn't lock the agent forever.
- **`/goal`** condition — re-checked after every turn.
- **Auto mode** — non-interactive runs (`-p` flag) **abort** if the classifier repeatedly
  blocks actions, since there's no user to fall back to.
- The **hooks lifecycle** exposes explicit `Stop` and `StopFailure` events
  ([claude-code-hooks]). `StopFailure` matches on error type (`rate_limit`,
  `overloaded`, `authentication_failed`, `billing_error`, `max_output_tokens`, …) — the
  agent system can react differently to each failure kind.

### OpenCode — the strongest §7 implementation
Two distinct mechanisms:
1. **`steps`** — the per-agent iteration cap (see §3).
2. **`doom_loop` permission** — "triggered when the same tool call repeats 3 times with
   identical input" ([opencode-perms]). Defaults to `"ask"`. This is the only harness I
   found with a **dedicated anti-spiral primitive** built into the permission system. It
   catches exactly the failure mode of "agent stuck calling the same broken tool".

Both are deterministic and live in the permission layer — they fire even if the model would
otherwise keep going.

### Codex
- **Sandbox caps** (network isolation, workspace approval).
- **Security auto-review** as a post-stop gate.

---

## Cross-cutting pattern: deterministic layer + advisory layer

Every production harness I looked at splits plan-execution control into two layers:

```
   ┌──────────────────────────────────────────────────────────┐
   │  ADVISORY layer — model follows if it understands        │
   │  ────────────────────────────────────────────            │
   │  CLAUDE.md / AGENTS.md · plan mode · subagent prompts    │
   │  skill descriptions · in-prompt instructions             │
   │                                                          │
   │  ↑ guides  ↓ can be ignored by a confused model          │
   ├──────────────────────────────────────────────────────────┤
   │  DETERMINISTIC layer — runs regardless of model state    │
   │  ────────────────────────────────────────────            │
   │  hooks · permissions · `steps` cap · `doom_loop`         │
   │  Stop hook · sandbox · checkpoints                       │
   │                                                          │
   │  ↑ enforces the contract even when the model won't       │
   └──────────────────────────────────────────────────────────┘
```

Anthropic's phrasing in [claude-code-bp]:
> "Unlike CLAUDE.md instructions which are advisory, **hooks are deterministic and guarantee
> the action happens.**"

**Implication:** a harness that only has the advisory layer (a prompt + plan mode) is one
confused-model away from spiraling. A harness that only has the deterministic layer
(hooks + permissions but no plan mode) can't benefit from the model's judgment. **Both
layers are needed.** Minima's GT build is on this exact axis — see the application guide.

---

## Sources for this file

Inline tags used above:
- `[claude-code-bp]` — Anthropic, *Best practices for Claude Code*, Dec 2024 + ongoing updates.
  <https://www.anthropic.com/engineering/claude-code-best-practices>
- `[claude-code-hooks]` — Claude Code hooks reference (lifecycle events, schema).
  <https://docs.claude.com/en/docs/claude-code/hooks>
- `[opencode-agents]` — OpenCode Agents docs (primary/subagents, `steps`, permissions).
  <https://opencode.ai/docs/agents/>
- `[opencode-perms]` — OpenCode Permissions docs (`doom_loop`, glob rules, ask/allow/deny).
  <https://opencode.ai/docs/permissions/>
- `[codex-doc-tree]` — Codex documentation index (overview, features, config, security).
  <https://developers.openai.com/codex/overview>
- `[anthropic-agents]` — Anthropic, *Building Effective Agents*, Dec 2024.
  <https://www.anthropic.com/engineering/building-effective-agents> (see also
  `sources.md`)

Cursor docs (`docs.cursor.com/agent/overview`) were attempted but only the title returned;
claims about Cursor here are kept minimal and labeled as such.
