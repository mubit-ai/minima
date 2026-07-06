# Feature Gap Analysis: minima vs. Claude Code, Codex CLI & OpenCode

**Date:** 2026-07-02
**Scope:** The minima **coding agent** (`src/minima_harness/`, the `minima` CLI/TUI, v0.5.0 "Beta"). The routing service in `src/minima/` is minima's wedge, not the comparison surface.
**Comparators:** Claude Code (Anthropic), Codex CLI (OpenAI), OpenCode (open source).
**Goal:** Rank the features these three have that minima lacks, by **popularity/usability**, **time to build**, and **compatibility with minima's architecture**.

---

## How to read this

- **Popularity / Usability (1–5):** How strongly users expect the feature in 2026. 5 = table-stakes.
- **Build effort:** Engineer-days for a first solid version, with a T‑shirt size. *Lower is better.*
- **Compatibility (1–5):** How cleanly it slots into minima's existing architecture (tools system, routing loop, session store, extensions). 5 = drop-in / synergistic.
- **Priority rank:** My recommended build order, balancing all three. High value + low effort + high fit floats to the top; a couple of high-effort items still rank high because they are table-stakes.

The ranking is a recommendation, not a formula output — the numeric columns are there so you can re-weight if your priorities differ (e.g., if enterprise security matters more, sandboxing jumps up).

---

## Executive summary

Minima's coding agent is a competent port of the PI agent toolkit with a **genuinely differentiated core**: cost-aware model routing across a large multi-provider pool, memory-backed learning from realized outcomes, and per-turn/per-goal cost tracking. Nothing in the comparators matches that wedge.

But on the *table-stakes agent surface*, it trails all three comparators in a few specific, high-visibility places. The biggest gaps, in order: **MCP support** (all three have it; minima has none), **sub-agents** (all three; minima is single-agent), **LSP feedback** (OpenCode's marquee feature; minima scaffolded then deleted it), **web search/fetch** (Claude Code + Codex; minima has none), and **plan mode** (all three; minima has a `# TODO` where it should be).

The good news: several of these are cheap because minima already has the substrate — the tools system, the routing/judge loop, image plumbing, and `/compact` all exist. Five of the top seven items are days-scale, not weeks-scale.

### Top-15 ranked table

| # | Feature (minima lacks) | Who has it | Popularity/Usability | Build effort | Compatibility | Notes / minima synergy |
|---|---|---|:--:|---|:--:|---|
| 1 | **MCP client support** | CC, Codex, OC | 5 | ~5–8d (**M**) | 5 | Table-stakes ecosystem. MCP tools map onto the existing tool interface; routing treats them as more tools. |
| 2 | **Web search / fetch tool** | CC, Codex | 5 | ~2–3d (**S**) | 5 | Two new builtin tools over a search API. Highest ROI after image input. |
| 3 | **Expose image/vision input** | Codex | 4 | ~1–2d (**XS**) | 5 | Already plumbed end-to-end (`ai/types.py:ImageContent`, all 3 providers); only the TUI attach path is missing. Fastest win in the doc. |
| 4 | **Plan mode (read-only)** | CC, Codex, OC | 5 | ~3–4d (**S**) | 5 | `ROUTE_MODES=("auto","confirm")` + tool gating exist; the plan/act split is already a documented **"Phase‑3"** item (`app.py:98`) — design intent exists, de-risking the build. |
| 5 | **Automatic context compaction** | CC | 4 | ~2–3d (**S**) | 5 | Notice site (`app.py:945`) + reusable `summarize()` both exist; wire an auto-trigger there. |
| 6 | **`/review` code-review command** | Codex | 4 | ~2–3d (**S**) | 5 | Diff vs. base/commit → review prompt routed to a strong model. Pure reuse of git(bash)+routing. |
| 7 | **Sub-agents / multi-agent** | CC, Codex, OC | 5 | ~8–15d (**L**) | 4 | Biggest *differentiation* opportunity: route **each subagent independently to the cheapest capable model**. No competitor does cost-routed fan-out. |
| 8 | **LSP integration (re-add)** | OC | 4 | ~8–12d (**L**) | 4 | Feeds compiler diagnostics back into the loop → sharper quality/judge signal → strengthens minima's feedback thesis. Was scaffolded (`lsp/` now stale `.pyc` only). |
| 9 | **Filesystem checkpoints / rewind** | CC, OC (undo), Codex (git) | 5 | ~6–10d (**M/L**) | 4 | Session tree branches *conversations*; extend to snapshot *files* per turn + restore. |
| 10 | **Dedicated git integration** | CC, Codex, OC | 4 | ~3–5d (**S/M**) | 4 | Status/diff/branch awareness in context + optional auto-commit. Today git is bash-only. |
| 11 | **Best-of-N / parallel attempts** | Codex (`--attempts`) | 3 | ~4–6d (**M**) | 5 | Natural fit: judge + routing already exist. Run N candidates across models, judge, pick. A routing differentiator. |
| 12 | **Sandboxing (OS-level)** | CC, Codex | 4 | ~10–15d (**L/XL**) | 3 | bash runs with full user perms today. Platform-specific (seatbelt/landlock/container). Enterprise value. |
| 13 | **Session sharing (`/share`)** | OC | 3 | ~5–8d (**M**) + infra | 3 | Needs a hosting backend — Mubit could host it (synergy), otherwise heavy. |
| 14 | **IDE integrations (VS Code/JetBrains)** | CC, Codex, OC | 5 | ~20–40d (**XL**) | 2 | High demand but a whole new product surface; needs an exposed agent server protocol. |
| 15 | **Desktop / web app** | CC, OC | 4 | ~25–40d (**XL**) | 2 | Long-term; large surface, low reuse of the TUI. |

**Micro-wins (do opportunistically, each < 1 day):** fuzzy `@`-file picker (Codex has autocomplete; minima's `@path` only inlines a known path), external prompt editor via `$EDITOR`/Ctrl+G (Codex), shell completions (`codex completion …`), `/copy` of last output (minima has `/copy`+`/export` already — mostly covered).

---

## Recommended roadmap (sequenced)

**Sprint 1 — Quick wins (≈2 weeks, all days-scale, high visibility):**
`#3 image input` → `#2 web search/fetch` → `#4 plan mode` → `#5 auto-compaction` → `#6 /review`. These close five obvious "why doesn't it do X" gaps for ~10–16 engineer-days total and touch only the tools/TUI/route-mode layers.

**Sprint 2 — Table-stakes core (≈2 weeks):**
`#1 MCP client` (the single most important gap; unlocks the whole external-tool ecosystem) + `#10 git integration`.

**Sprint 3 — Strategic differentiators (≈4–6 weeks):**
`#7 cost-routed sub-agents` and `#8 LSP re-add`. These are the two places where minima's wedge (routing + outcome feedback) turns a copied feature into a *better* feature. Add `#11 best-of-N` and `#9 checkpoints` as they fit.

**Backlog / heavy bets:** `#12 sandboxing`, `#13 sharing`, `#14 IDE`, `#15 desktop/web`.

---

## Detail & build notes

### Tier 1 — Quick wins

- **Image/vision input (#3).** The hard part is done: `ImageContent(data: base64, mime_type)` is fully defined (`ai/types.py:104`) and all three providers (`anthropic-messages`, `google-generative-ai`, `openai-completions`) already serialize images. Missing: a user path to attach one — `editor.py:21` only inline-expands *text* `@path`. Add a `-i/--image` CLI flag and a paste/`@image.png` route that builds an `ImageContent` and injects it. ~1–2 days.
- **Web search / fetch (#2).** Append two `AgentTool`s to `default_toolset()` (`tools/builtin.py:13`) backed by a search API (Brave/Tavily/Exa) or provider-native grounding. Minima already routes to web-grounded models (Perplexity Sonar) but has no tool. ~2–3 days.
- **Plan mode (#4).** `ROUTE_MODES = ("auto","confirm")` at `app.py:99`; the plan/act split is explicitly deferred to "Phase‑3" in the comment at `app.py:98`, and tool gating (`-nt`, `--exclude-tools`) already exists. Add a read-only mode that restricts to `read/grep/find/ls`, produces a plan, and gates execution behind approval. ~3–4 days. (Team roadmap intent already documented — lower design risk.)
- **Auto-compaction (#5).** The trigger site already exists: `app.py:945` shows `"context near limit — /compact to free space"` today, and `summarize(messages, model, *, instructions="")` (`tui/compaction.py:8`) is a clean reusable async fn. Auto-compaction = call `summarize()` at that notice point instead of just warning. ~2–3 days (revised down from 4 — the hook and summarizer both exist).
- **`/review` (#6).** A slash command that diffs against a base branch / uncommitted changes (git via bash), builds a review prompt, and routes it to a strong model. Pure reuse. ~2–3 days.

### Tier 2 — Table-stakes core

- **MCP client (#1).** The highest-impact gap: all three comparators support MCP; minima has neither client nor server (grep-confirmed absent). Implement a stdio + streamable-HTTP client, register discovered tools into the existing tool registry, and add config. Because minima's tool interface is already pluggable (extensions register tools today), MCP tools slot in cleanly and are automatically eligible for routing/permissions. ~5–8 days. (A `codex mcp-server`-style server that exposes minima *as* an MCP tool is a separate, later item.)
- **Git integration (#10).** Surface `git status`/diff/branch into context, be gitignore-aware, optionally offer auto-commit with generated messages. ~3–5 days.

### Tier 3 — Strategic differentiators (lean into the wedge)

- **Cost-routed sub-agents (#7).** All three comparators spawn subagents; **none route each subagent to the cheapest capable model.** Minima can: a spawn tool + isolated context + result synthesis, with every child going through the recommend→judge→feedback loop. This makes "fan out 5 agents" measurably cheaper and is a story no competitor can tell. The loop is already anyio-parallel, so concurrency isn't from scratch. ~8–15 days.
- **LSP re-add (#8).** OpenCode's headline feature: feed compiler diagnostics back after each edit so the model self-corrects. This is *directly aligned* with minima's outcome-feedback thesis — diagnostics become a quality signal for the judge and for routing feedback. Source was scaffolded and deleted (`lsp/` and `tests/harness/lsp/` hold only stale `.pyc`), so prior design exists to mine. ~8–12 days.
- **Best-of-N routing (#11).** Codex Cloud has `--attempts` (1–4). Minima already has a judge and multi-model routing — run N candidates across models, judge, select the winner, and log outcomes. A routing-native version of a known feature. ~4–6 days.
- **Checkpoints / rewind (#9).** Users expect an undo net (Claude Code rewind, OpenCode undo/redo). Snapshot touched files per turn and restore on request; integrate with the existing session tree so a rewind can branch conversation *and* files together. ~6–10 days.

### Tier 4 — Heavy / long-term

- **Sandboxing (#12):** OS-level isolation for `bash` (seatbelt on macOS, landlock/seccomp on Linux, or containers). Real enterprise value but platform-specific and invasive. ~10–15 days.
- **Session sharing (#13):** `/share` link. Needs a hosting backend — a natural thing for Mubit to host, otherwise expensive. ~5–8 days + infra.
- **IDE integrations (#14) / Desktop-web app (#15):** New product surfaces requiring an exposed agent server protocol; high demand, weeks-to-months of work, low reuse of the current TUI.

---

## What minima already matches (not gaps)

So this doesn't read as "behind on everything" — minima is at parity or ahead here:

- **Slash commands** (~37), **skills** (Agent Skills standard + Mubit skills), **prompt templates** as `/commands`, **custom commands** — parity.
- **Hooks/extensibility:** Python extensions register tools/commands/event hooks (`text`/`tool_start`/`tool_end`/`turn`/`finish`) + a git-based **package manager** (`minima install <git-url>`) — comparable to plugins.
- **Permissions/approval modes:** PermissionRequest modal, always-allow, `/yolo`, `--dangerously-skip-permissions`, `/edits` forced diff review — parity (minus sandboxing).
- **Headless/scripting:** `--print` and `--mode json` event stream — matches `codex exec` / `claude -p`.
- **Sessions:** append-only JSONL session **tree** with continue/resume/fork/clone/branch + goals that survive resume — arguably *ahead* of the comparators on branching.
- **Themes, keybinds, mouse select+copy, `/export` to Markdown, diff preview, `/stats`+`/cost` analytics** — parity or better on cost analytics.
- **Multi-provider:** Anthropic, Google, and an OpenAI-compatible path covering OpenAI/OpenRouter/Groq/Together/Fireworks/DeepInfra/Cerebras/DeepSeek/Mistral/xAI/Perplexity, etc. — **plus first-class local-runtime specs for Ollama, LM Studio, vLLM, llama.cpp, and LocalAI** (`ai/provider_catalog.py:110–124`, no API key required, e.g. Ollama at `localhost:11434/v1`). This is *ahead* of most comparators on local-runtime breadth. *(Corrected in iteration 5 — the initial inventory wrongly reported no local provider.)*

## Minima's unique wedge (protect and lean into)

No comparator has: **cost-aware routing across a large candidate pool**, **memory-backed learning from realized outcomes** (`/recall`, `/optimize`, learned lessons), and **cost/budget tracking** (est-vs-actual-vs-baseline savings %, budgeted `/ledger` goals). The strategic read: build the table-stakes gaps to remove reasons *not* to use minima, but make sub-agents, best-of-N, and LSP feedback **routing-native** so the copied features are cheaper/smarter than the originals.

---

## Validation notes (iteration 2 — 2026-07-02)

The Tier‑1 estimates were re-checked against source (not just inferred from the inventory). All held; a couple were revised down because the reuse points exist:

| Claim | Verified against | Result |
|---|---|---|
| Image plumbed but not exposed | `ai/types.py:104` (`ImageContent(data:base64, mime_type)`), `editor.py:21` (text-only `@path`) | ✅ Confirmed — only the TUI attach path is missing. |
| Plan mode absent, scaffold exists | `app.py:98–99` (`ROUTE_MODES=("auto","confirm")`, "Phase‑3 plan/act split" comment) | ✅ Confirmed — and it's already on the team roadmap. |
| Auto-compaction absent | `app.py:945` (warn-only notice), `_compact` at `app.py:1226`, reusable `summarize()` at `compaction.py:8` | ✅ Confirmed — **estimate revised 2–4d → 2–3d** (hook + summarizer exist). |
| Web search/fetch absent | grep across `src/minima_harness/` (empty); `default_toolset()` at `tools/builtin.py:13` is the clean insertion point | ✅ Confirmed absent, insertion point trivial. |
| MCP absent | grep across `src/minima_harness/` (empty) | ✅ Confirmed absent (client and server). |

### Tier‑2/3 validation (iteration 3 — 2026-07-02)

Source-checked the expensive roadmap-driving items. All estimates held; compatibility claims confirmed, with sharpened risk notes:

| Item | Verified against | Result / refinement |
|---|---|---|
| MCP client (#1, ~5–8d, fit 5) | `AgentTool` dataclass (`agent/tools.py:42`: `name`/`description`/`parameters: type[BaseModel]`/async `execute`); extensions already register `AgentTool`s dynamically (`extensions.py:30`) | ✅ Fit confirmed. The **one real risk** is bridging MCP's JSON-Schema tool params → a pydantic model (`pydantic.create_model` or a passthrough model). Everything else is wiring. |
| Cost-routed sub-agents (#7, ~8–15d, fit 4) | `agent_loop(...)` is a plain async fn over explicit `AgentState`/`AgentLoopConfig` (`loop.py:48`); tool exec already parallel via `anyio.create_task_group()` (`loop.py:245`) | ✅ Nesting a child loop is clean (no global refactor); concurrency primitives exist. The cost-routing-per-child synergy is real — each child re-enters the same runtime. |
| LSP re-add (#8, ~8–12d, fit 4) | Only `.pyc` survives (`lsp/__pycache__/` client+manager+protocol + compiled tests); no `.py` source | ✅ Estimate holds. Module split is a **design hint only** — py3.14 decompilers are immature, so don't count on recovering the deleted code. |
| Checkpoints/rewind (#9, ~6–10d, fit 4) | `SessionStore` is a conversation DAG (`store.py`: `append`/`set_tip`/`fork_to`/`path_to`), not file state | ✅ Estimate holds; **refinement:** the DAG is a clean anchor for rewind, but the per-turn **file-snapshot layer is net-new** (fit is really 3–4). |
| Git integration (#10, ~3–5d, fit 4) | No dedicated git code (bash-only); context assembled in `tui/context.py` | ✅ Pure context injection (shell out to git, summarize into context) + optional auto-commit. Low risk. |

Tier‑4 items (sandboxing, sharing, IDE, desktop/web) remain first-pass — deliberately, as they're backlog.

---

## Changelog refresh (iteration 4 — 2026-07-02)

Swept the **June–July 2026** changelogs to keep the gap list current. Net: the existing top gaps got *reinforced* (the bar rose), a few new candidates appeared, and — notably — a competitor started copying minima's wedge.

**Existing gaps reinforced (the bar moved):**
- **Sub-agents (#7):** Claude Code now ships **nested sub-agents (3-level depth)**, `fallbackModel` chains, and background-subagent permission prompts routed to the main session. The expectation moved from "has subagents" to "has *nested, resilient* subagents" — which makes minima's cost-routed-fan-out angle more valuable, not less.
- **MCP (#1):** now table-stakes-plus — Claude `claude mcp login/logout`, Codex smarter MCP tool-search, OpenCode MCP OAuth + refresh tokens + resource autocomplete. Minima is still at zero; this remains the #1 gap.
- **Checkpoints/rewind (#9):** Claude `/rewind` can now restore from *before* `/clear` was run.
- **Web search (#2):** Codex added an **indexed mode** (live search but restricted to server-approved URLs) — a safer default worth copying when minima builds this.

**New candidate gaps (June 2026):**

| Candidate | Who shipped it | Pop. | Effort | Fit | Where it slots |
|---|---|:--:|---|:--:|---|
| Test-runner auto-detection + run | OpenCode (cargo/uv/bun/dotnet) | 3 | ~2–3d (**S**) | 5 | Confirmed absent in minima (no in-agent test integration; bash-only). A tool/context add that routes a "run tests" action. Tier-1-sized quick win. |
| Mobile / remote control | Codex Remote GA (QR pairing), CC remote | 4 | ~20–40d (**XL**) | 2 | New surface (server + device pairing). Backlog, alongside IDE. |
| Org/admin policy controls (default model, governance) | Claude Code org defaults | 2–3 | ~5–8d (**M**) | 3 | Enterprise/team governance. Backlog. |

*Dropped candidate (iteration 5):* "first-class Ollama support" — **minima already has it** (see parity list below). OpenCode's only edge here is *optimized* local streaming (Ollama streaming v2, ~−40% first-token latency) — a minor perf item, not a feature gap.

**Already at parity with newly-shipped features (no action needed):**
- OpenCode just added a **yolo mode** to auto-approve permissions — minima has `/yolo` + `--dangerously-skip-permissions` already.
- OpenCode's `--session` transcript pinning — minima has `--session` **plus** a full session tree.
- **Local models** — OpenCode/Ollama focus notwithstanding, minima ships first-class specs for Ollama, LM Studio, vLLM, llama.cpp, and LocalAI (`ai/provider_catalog.py:110–124`). Minima is ahead here on breadth; the only competitor edge is streaming latency tuning.
- **Codex just shipped "rollout token budgets" that abort a turn when exhausted** — a step *toward* minima's existing cost/budget wedge (`/ledger` budgeted goals, per-turn est-vs-actual-vs-baseline savings). Signal: the market is moving toward minima's differentiator. **Suggested move:** add a hard budget-abort to `/ledger` to stay a step ahead of where Codex just landed.

---

## Sources

- Claude Code — [25 Features Guide 2026 (MarkTechPost)](https://www.marktechpost.com/2026/06/14/claude-code-guide-2026-25-features-with-examples-demo/), [Subagents docs](https://code.claude.com/docs/en/sub-agents), [Hooks/Subagents/Skills guide](https://ofox.ai/blog/claude-code-hooks-subagents-skills-complete-guide-2026/)
- Codex CLI — [Features](https://developers.openai.com/codex/cli/features), [CLI docs](https://developers.openai.com/codex/cli), [Changelog](https://developers.openai.com/codex/changelog), [Codex as MCP server](https://codex.danielvaughan.com/2026/05/12/codex-cli-agents-sdk-mcp-server-multi-agent-workflows/)
- OpenCode — [Docs / intro](https://opencode.ai/docs/), [GitHub](https://github.com/opencode-ai/opencode), [Developer guide 2026](https://www.developersdigest.tech/blog/opencode-developer-guide-2026)
- June–July 2026 changelogs — [Codex changelog](https://developers.openai.com/codex/changelog), [Codex June 2026 recap](https://www.developersdigest.tech/blog/codex-changelog-june-2026), [Claude Code what's new](https://code.claude.com/docs/en/whats-new), [Claude Code June 2026 features](https://www.sitepoint.com/claude-code-june-2026-10-new-features-devs-need-to-know/), [OpenCode changelog](https://opencode.ai/changelog)
- minima — codebase inventory (`src/minima_harness/`), `docs/harness.md`, `README.md`

*Build estimates assume one engineer familiar with the codebase. Tier‑1 through Tier‑3 estimates have been source-validated (see Validation notes); Tier‑4 remains first-pass by design.*

---

## Revision history

- **Iteration 1** — Initial report: minima feature inventory + competitor research → ranked 15-item gap table + 3-sprint roadmap.
- **Iteration 2** — Source-validated Tier‑1 estimates; revised auto-compaction down (2–4d → 2–3d).
- **Iteration 3** — Source-validated Tier‑2/3 estimates (MCP JSON-Schema bridge risk, clean sub-agent nesting, LSP `.pyc`-only remnants, net-new checkpoint file layer).
- **Iteration 4** — June–July 2026 changelog refresh: reinforced gaps, new candidates, and the signal that Codex is converging on minima's cost-budget wedge.
- **Iteration 5** — Validated new candidates; **corrected a factual error** — minima already ships first-class local-runtime providers (Ollama/LM Studio/vLLM/llama.cpp/LocalAI); confirmed test-runner detection is a genuine gap. Report considered complete.
