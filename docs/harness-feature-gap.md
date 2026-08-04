# The harness feature gap — what Minima is missing, and what only Minima could build

**Status:** living tracker · **Surveyed:** 2026-07-31 · **Last updated:** 2026-08-04
**Branch:** `research/new-features-research` · **Subject:** `packages/tui` only. The service is context
for *why* the harness exists, not a comparison row.

> **This is now a tracker, not just a survey.** §0 is the ledger — what shipped, what is in flight, what
> is next. The matrix (§3) is kept in sync with it, so a row's `M` column is always the *current* answer.
> Every claim below the ledger is still the original survey's, re-ranked but not re-researched.

---

## 0. Delivery ledger

**Progress: 4 of 19 table-stakes gaps closed** (A10, C9, D7, D9). Matrix moved **40 → 44 YES**, and the
harness's worst-scoring category is unchanged: extensibility, still 2 YES / 1 PARTIAL / 8 NO.

### ✅ Shipped — Track A, Tier 1

All merged into `research/new-features-research`. **Not yet on `main`** — PR **#329** is open and green;
these land together when it merges.

| row | feature | PR | kill switch | notes |
| -- | -- | -- | -- | -- |
| **A10** | Image input (`read` returns the image) | #322 | `MINIMA_TUI_IMAGES` | closed the study's only 9/9 gap |
| **A10** | Image input (**Ctrl+V from the clipboard**) | #330 | `MINIMA_TUI_IMAGES` | second surface; not a comparator row — see D6 |
| **C9** | Context-window indicator | #324 | `MINIMA_TUI_CONTEXT_METER` | also unified auto-compact onto the same number |
| **D7** | Desktop notifications | #323 | `MINIMA_TUI_NOTIFY` | OSC 9 + bell |
| **D9** | `$EDITOR` composing | #325 | `MINIMA_TUI_EDITOR` | Ctrl+X Ctrl+E, not Ctrl+G — see the re-rank note in §4 |
| — | CI gate for the branch | #321 | — | `ci.yml` `pull_request.branches` |
| — | `read` description tracks vision, per turn | #326 | — | fix: dispatch 4/9 → 8/9 |
| — | `gpt-5.6-*` unusable with tools | #328 | — | fix: `reasoning_effort:"none"` quirk flag |

### 🚧 In flight — 13 open PRs. **Check here before starting anything.**

⚠️ **Nothing below is merged.** `main` has not moved since **#308 (2026-07-27)**; every PR here is
`OPEN` against `main`, none has a review decision recorded. "In flight" means *do not start it* — it does
**not** mean the row is closed. The matrix (§3) therefore still scores these rows as gaps, and will until
they land.

**Closes a gap row — do not build these:**

| PR | author | row | feature | size | state |
| -- | -- | -- | -- | -- | -- |
| **#327** | ammar | **E5** | **Skills (`SKILL.md`)** — discovery, `skill` tool, `/<name>` invocation | +1206/−9 | open, mergeable |
| **#318** | ammar | **D1** | **Themes** — 10 colorschemes, live-preview picker | +581/−178 | open, mergeable |
| **#312** | ammar | **A2** | Plan-delegated steps; **carries #309's user-defined agent types** | +5239/−97 | open, mergeable |
| ~~#309~~ | ammar | A2 | user-defined agent types — **superseded by #312**, its body says to close this one | +2979/−140 | open, **CONFLICTING** |
| **#315** | eldar | **F6** | localhost dashboard — read-only ledger UI | +10288/−579 | open, mergeable |
| **#329** | eldar | A10 C9 D7 D9 | Track A Tier 1 (this arc) | +5142/−207 | open, CI 4/4 green |

**No gap row — defects, refactors and already-YES rows:**

| PR | author | what | touches |
| -- | -- | -- | -- |
| **#320** | ammar | force reasoning off for non-reasoning models | ⚠️ **collides with our #328 — see below** |
| **#331** | ammar | `options.timeout` never read; cached tokens not credited | `openai_compat.ts` |
| **#319** | ammar | fullscreen renderer, **made the default** | F1 (already YES). Reverses the earlier inline-only renderer decision; the PR says this is recorded as ADR amendments — worth confirming that is the decision you think it is |
| **#310** | shankha | routing P0 — "give the optimizer something to vary" | M3 (already YES); Track B adjacent |
| **#317** | ammar | provider SDK bumps; Gemini abort + OAuth | — |
| **#316** | ammar | lift `HarnessApp` effects into named hooks | refactor |
| **#314** | ammar | untrack `runs/` | chore |

### ⚔️ Collision owed a decision: #320 vs our #328

Two people fixed the **same defect** — `gpt-5.6-luna` 400ing with
*"Function tools with reasoning_effort are not supported"* — two different ways, and both are open
against `main`. They overlap in **five files** (`provider_quirks.ts`, `openai_compat.ts`, `cli/main.ts`,
`runtime.ts`, `openai-compat.test.ts`), so the second to merge takes conflicts.

They are **not** equivalent:

| | **#320** (ammar) | **#328** (this arc) |
| -- | -- | -- |
| trigger | `model.reasoning === false` | `tools_require_effort_none` **and** tools present |
| scope | per **provider** (`openai`, `openrouter`) | per **model** |
| seeds changed | `gpt-5.6-luna` → `reasoning: false` | all three gpt-5.6 keep `reasoning: true` |
| sol / terra | **still broken** — untouched | fixed |
| tool-less calls (judge, classifier, `--no-tools`) | effort forced off too | keep the model's own effort |
| routing side effect | luna leaves the reasoning-capable pool | pool unchanged |

The substantive question is whether **`reasoning: false` is metadata or a mechanism**. gpt-5.6-luna *is*
a reasoning model; #320 marks it non-reasoning to trigger an off-switch, which also removes it from the
router's reasoning-capable filter. #328 treats the 400 as a wire quirk and leaves the capability claim
true. **One of these has to be withdrawn or merged into the other — pick before either lands.**
#320 also covers OpenRouter's `reasoning.enabled=false`, which #328 does not; #328 covers sol and terra,
which #320 does not. A merged fix would want both halves.

### ⛔ Not shipped from the original Tier 1

| row | feature | why it slipped |
| -- | -- | -- |
| **D1** | Themes | the only original Tier-1 item not built. Still 7/9. Re-ranked in §4. |

### 🔁 Debt created by shipping — none of it comparator-visible

Found while building, tracked here so it is not rediscovered. None blocks a release; all four are honest
limits stated in the shipping PRs.

| # | debt | where |
| -- | -- | -- |
| 1 | `Model.input` unset on **7 of 20 seeds** (deepseek ×2, xai ×2, openrouter ×3) — fail-closed, so those models silently cannot receive images. Needs provider keys to verify, not a decision. | `cli/main.ts` |
| 2 | **Resume drops images.** User messages rehydrate as text only, so base64 never reaches SQLite and a resumed session shows `[Image #1]` with nothing behind it. | `db/rehydrate.ts` |
| 3 | The context meter **under-counts a fresh image** by ~1.5k tokens until the first reply reports real usage. | `tui/context_meter.ts` |
| 4 | The **Linux clipboard path is unverified** against a real X11/Wayland pasteboard — unit-tested through a spawn seam only. | `tui/clipboard_image.ts` |

### ▶️ Recommended next — revised 2026-08-04 against what is already in flight

Three of the five items this document recommended a week ago are **already being built by someone else**:
E5 Skills (#327), D1 Themes (#318), A2 agent types (#312). Removing those, the recommendation is:

**1. `.minima/` project config (E9)** — 8/9, S–M, and the case for it got *stronger*, not weaker.
Two open PRs have each independently invented a `.minima/` subdirectory: #327 reads `.minima/skills/`,
#312/#309 read `.minima/agents/*.md`. **The convention is being set piecemeal, by whoever ships first,
with no config file and no precedence rules.** E9 is no longer greenfield — it is consolidation, and it
gets more expensive every week it waits.

**2. Reasoning-effort control for the main model (M8)** — 8/9, S. Still free, but **coordinate**:
#320 and #331 both touch `openai_compat.ts` and the quirks table, and #320 is entangled with our #328.
Settle the collision above first.

**3. ACP (§4 Tier 3 #12)** — unchanged, and now the strongest *uncontested* item. Nobody is on it, and it
is still the highest reach-per-unit-effort in Track A: implement once, run inside Zed, JetBrains and
VS Code with no extension work.

Also free and uncontested: **F9** git commit authoring (6/9), **D3** custom keybindings (6/9),
**E6** hooks (7/9), **E1/E2** MCP (8/9, but see §6 — two ADRs owed first).

---

Two ranked tracks, deliberately never merged:

| track | what it contains | ranked by |
| --- | --- | --- |
| **A — Parity** | features comparators ship that Minima does not | adoption denominator, effort as tiebreak |
| **B — Leverage** | features that compound cost routing + plan verification; **no comparator has these** | thesis fit |

They are not commensurable. One merged list would either bury a strategic bet under a keybinding, or the
reverse. §3 and §4 are read separately and funded separately.

---

## 1. Terminology

This repo's `CLAUDE.md` already uses **"harness"** to mean `packages/tui`. The word is also the natural
label for the products being compared. To keep both meanings usable:

- **the harness** — Minima's, `packages/tui`, the `minima` CLI.
- **comparator** — any competing product measured here.
- **primary set** — the nine terminal-native comparators that form the denominator (§2).
- **feature source** — IDE-embedded agents mined for portable ideas but **excluded from the denominator**.

Defined here rather than in a `CONTEXT.md`, deliberately: `CONTEXT.md` does not exist on `main` — it lives
only on the unlanded `integration/confidence-arc`. Starting a second one here would collide with it. If
these terms earn permanence they should be lifted into that file when the arc lands.

---

## 2. Method, and what makes a row true

### The primary set (the denominator, n=9)

Claude Code · OpenAI Codex CLI · GitHub Copilot CLI · Google Antigravity CLI · opencode · Amp · Goose ·
Crush · Aider.

**Table stakes is an operational definition, not a judgement:** a feature is table stakes when **≥6 of the
9** primary comparators ship it (YES, not PARTIAL). Every row prints its count. Nothing is called
"standard" or "expected" without one.

### Feature sources (mined, not counted)

Cursor · Cline · Windsurf/Devin Desktop · Zed. Their features enter Track A only if portable to a terminal.

**The exclusion rule, written down so it can be checked:** a feature is excluded when it requires a live
editor buffer, viewport, selection model, or renderer. Excluded by this rule: inline autocomplete / Cursor
Tab · Edit Prediction ghost text · Follow the Agent · Review Changes multibuffer with per-hunk keep/reject ·
Problems-panel auto-fix loop and Agent Diff Zones · Inline Assistant on the current selection · Cmd+K
inline edit and hover menus · Jupyter cell actions · Design Mode · Debug Mode's local debug server.

### Evidence bar

- **Presence/absence**: primary sources only — official docs, official changelog, or the product's own repo.
  A third-party blog is not a primary source for whether a feature exists.
- **"Praised"**: ≥2 independent sources, cited. Where the bar could not be met it is stated, not padded —
  the Antigravity researcher returned three praise clusters instead of five and said why.
- **`UNKNOWN` is a real verdict** and appears throughout rather than being resolved by inference.
- **Minima's own column was derived by reading source**, every row traced to a `file:line`. Not from docs,
  not from recall.

**The tally, recounted mechanically 2026-08-04.** As surveyed: **40 YES · 6 PARTIAL · 30 NO · 0 UNKNOWN**
(76 rows). After the four Tier-1 features shipped: **44 YES · 5 PARTIAL · 27 NO**.

Two corrections fall out of that recount, recorded rather than quietly patched, because this document's
whole claim is that its counts are checkable:

- The original **§2 tally read 38/6/32**, which never matched the sum of its own category headers (those
  summed to 40/6/30). The row-level data was right; the summary line was wrong.
- Two **category headers were also wrong**: *Model & cost* read 7 YES / 3 PARTIAL where its rows are
  8 / 2 (M3 is YES), and *Developer experience* read 5 YES where its rows were 4. Both now match their rows.

No verdict in any row changed. The counts are now derived from the table by script, so the next drift is
detectable rather than accumulated.

### Two distinctions this study had to invent

**1. `NO (removed)` ≠ `NO (never had)`.** Amp shipped custom commands, TODO lists, file-rollback
checkpoints, custom themes and BYOK — and then **deleted all five**. A product that built a feature and
removed it is evidence *against* that feature being necessary, and much stronger evidence than never having
built it. Counting those as ordinary absences would have inflated several table-stakes verdicts.

**2. Name collisions are not feature matches.** `MINIMA_TUI_STEER` and Zed's "Steer" share a word and
nothing else — Minima's blocks `grep`/`cat` shell-outs in favour of native tools; Zed's delivers queued user
input at a step boundary between a tool call and the response. Every "Minima might already have this" flag
was checked against source before being resolved. Three were checked: one was a real gap behind a collision,
one (`doom_loop` ≈ `MINIMA_TUI_SPIRAL_REPEATS`) was already shipped, one (`question`) was near parity.

---

## 3. The matrix — 76 rows

`M` = Minima. `n/9` = primary comparators shipping it (YES only). **TS** = table stakes (≥6/9).
Gaps are bold.

### Extensibility & integration — Minima 2 YES / 1 PARTIAL / 8 NO

| id | feature | M | n/9 | TS | note |
| -- | -- | -- | -- | -- | -- |
| E1 | MCP client, stdio | **NO** | 8 | ✅ | only non-adopter is Aider, the dormant one |
| E2 | MCP client, HTTP/SSE | **NO** | 8 | ✅ | OAuth is standard across all eight |
| E3 | MCP server mode | NO | 2 | ✗ | Claude Code + Codex only |
| E4 | User-authored slash commands | **NO** | 7 | ✅ | Amp removed its own, superseded by skills |
| E5 | Skills (`SKILL.md`) | **NO** | 8 | ✅ | 🚧 **PR #327 open** — still scored NO until it merges. agentskills.io standard; Crush/opencode/Copilot also read `.claude/skills` |
| E6 | User-configurable hooks | **NO** | 7 | ✅ | +2 PARTIAL. Minima's hooks are internal code seams only |
| E7 | Plugin registry/marketplace | NO | 4 | ✗ | +3 PARTIAL; Amp removed its installer |
| E8 | Embeddable SDK | PARTIAL | 6 | ✅ | Minima exports `src/index.ts`, undocumented, no built entry |
| E9 | Project config file | **NO** | 8 | ✅ | ⚠️ no `.minima/` config file exists — yet **#327 and #312 both already read `.minima/` subdirectories**. The convention is being set without it |
| E10 | Global config file | YES | 9 | ✅ | `~/.minima-harness/config.env` |
| E11 | Rules files | YES | 8 | ✅ | reads `AGENTS.md` + `CLAUDE.md` |

### Agent capability — Minima 10 YES / 0 PARTIAL / 1 NO

| id | feature | M | n/9 | TS | note |
| -- | -- | -- | -- | -- | -- |
| A1 | Sub-agents | YES | 9 | ✅ | universal |
| A2 | User-defined custom agents | **NO** | 6 | ✅ | 🚧 **PR #312 open** (supersedes #309). Minima has one hardcoded `PLANNER_PERSONA` |
| A3 | Plan mode | YES | 6 | ✅ | Amp and Crush ship none and are praised anyway |
| A4 | Persistent plan/todo | YES | 6 | ✅ | Amp removed its TODO list Jan 2026 |
| A5 | Background jobs | YES | 8 | ✅ | |
| A6 | Parallel tool execution | YES | 4 | ✗ | poorly documented everywhere; count is a floor |
| A7 | LSP | YES | 3 | ✗ | **Minima strength** — opencode/Crush/Copilot only, and both open-source ones are *praised* for it |
| A8 | Web search | YES | 7 | ✅ | |
| A9 | Web fetch | YES | 9 | ✅ | universal |
| A10 | **Image input** | ✅ YES | **9** | ✅ | **SHIPPED #322** — was the only 9/9 gap. `read` returns png/jpeg/webp; **#330** added Ctrl+V clipboard paste |
| A11 | Structured output | YES | 4 | ✗ | Minima on the right side of a minority |

### Autonomy & safety — Minima 6 YES / 1 PARTIAL / 2 NO

| id | feature | M | n/9 | TS | note |
| -- | -- | -- | -- | -- | -- |
| S1 | Permission modes | YES | 8 | ✅ | |
| S2 | Per-tool allowlists | YES | 9 | ✅ | universal |
| S3 | OS sandbox | NO | 3 | ✗ | `_io.ts:22` is explicit it is "not a sandbox" |
| S4 | Network egress control | PARTIAL | 3 | ✗ | Minima's is an SSRF guard on fetch only |
| S5 | Checkpoints | YES | 3 | ✗ | **Minima strength** — Amp *removed* its own |
| S6 | Rewind | YES | 5 | ✗ | **Minima strength** |
| S7 | Undo | YES | 4 | ✗ | **Minima strength** |
| S8 | Diff review before apply | **NO** | 6 | ✅ | `app.tsx:7` records this as deliberately deferred |
| S9 | Auto-accept edits | YES | 8 | ✅ | |

### Context management — Minima 8 YES / 0 PARTIAL / 1 NO

| id | feature | M | n/9 | TS | note |
| -- | -- | -- | -- | -- | -- |
| C1 | Auto compaction | YES | 8 | ✅ | Antigravity dropped it; open request |
| C2 | Manual compaction | YES | 6 | ✅ | |
| C3 | Session resume | YES | 9 | ✅ | universal |
| C4 | Session list | YES | 9 | ✅ | universal |
| C5 | Named sessions | YES | 8 | ✅ | |
| C6 | Cross-session memory | YES | 4 | ✗ | **Minima strength** — opencode, Zed, Cline, Antigravity all lack it |
| C7 | @-mentions | YES | 8 | ✅ | |
| C8 | Multi-dir / multi-repo | **NO** | 5 | ⚠️ | one short of the bar; `projects.json` is a repo→project map, not multi-root |
| C9 | **Context usage display** | ✅ YES | **8** | ✅ | **SHIPPED #324** — `ctx N% (used/window)`; auto-compact now fires on the same number |

### Model & cost — Minima 8 YES / 2 PARTIAL / 0 NO

| id | feature | M | n/9 | TS | note |
| -- | -- | -- | -- | -- | -- |
| M1 | Multi-provider | YES | 6 | ✅ | Claude Code is Claude-only; Antigravity has no BYOK |
| M2 | Model switching | YES | 9 | ✅ | universal |
| M3 | **Automatic per-task routing** | YES | 2 | ✗ | see §4.1 — the picture is more contested than the count suggests |
| M4 | Cost display | YES | 6 | ✅ | |
| M5 | Budget enforcement | YES | 3 | ✗ | **Minima strength** |
| M6 | Token telemetry | YES | 9 | ✅ | universal |
| M7 | Thinking display | YES | 9 | ✅ | universal |
| M8 | Reasoning effort control | PARTIAL | 8 | ✅ | Minima exposes it for sub-agents, not the main model |
| M9 | Local models | PARTIAL | 5 | ⚠️ | `base_url` works; no first-class Ollama entry |
| M10 | Prompt caching | YES | 9 | ✅ | universal |

### Surfaces — Minima 3 YES / 0 PARTIAL / 8 NO

| id | feature | M | n/9 | TS | note |
| -- | -- | -- | -- | -- | -- |
| F1 | Terminal TUI | YES | 8 | ✅ | |
| F2 | Headless one-shot | YES | 9 | ✅ | universal; `--print` |
| F3 | JSON event stream | YES | 8 | ✅ | `--mode json` |
| F4 | VS Code extension | NO | 4 | ✗ | |
| F5 | JetBrains extension | NO | 2 | ✗ | most reach it via ACP instead |
| F6 | Web UI | NO | 1 | ✗ | 🚧 **PR #315 open** — localhost read-only ledger dashboard. Note this row is 1/9 and sits in "deliberately not recommended"; it is being built for the ledger thesis, not for parity |
| F7 | Desktop app | NO | 4 | ✗ | |
| F8 | GitHub Action | NO | 4 | ✗ | +3 PARTIAL documented-workflow-only |
| F9 | Git commit authoring | **NO** | 6 | ✅ | reachable only via `bash` today |
| F10 | PR create / review | **NO** | 7 | ✅ | |
| F11 | Issue tracker | NO | 4 | ✗ | mostly delivered through MCP |

### Team & enterprise — Minima 1 YES / 1 PARTIAL / 4 NO

| id | feature | M | n/9 | TS | note |
| -- | -- | -- | -- | -- | -- |
| T1 | Shared team config | **NO** | 6 | ✅ | `/profile` is per-repo and local |
| T2 | Org analytics | YES | 3 | ✗ | **Minima strength** — `/cost fleet` |
| T3 | Audit logging | PARTIAL | 3 | ✗ | event-sourced locally; no org surface |
| T4 | SSO | NO | 4 | ✗ | Zed lacks it too and says so plainly |
| T5 | Seat management | NO | 4 | ✗ | |
| T6 | Managed cloud | NO | 3 | ✗ | collides with recommend-only — see §5 |

### Developer experience — Minima 6 YES / 0 PARTIAL / 3 NO

| id | feature | M | n/9 | TS | note |
| -- | -- | -- | -- | -- | -- |
| D1 | Themes | **NO** | 7 | ✅ | 🚧 **PR #318 open** — 10 colorschemes. Was deferred at `app.tsx:7`; Amp *removed* theirs |
| D2 | Vim keybindings | NO | 3 | ✗ | Copilot CLI has open issues #13/#398 |
| D3 | Custom keybindings | **NO** | 6 | ✅ | Minima's are hardcoded |
| D4 | Command palette | YES | 9 | ✅ | universal |
| D5 | Prompt history | YES | 9 | ✅ | universal |
| D6 | Clipboard | YES | 9 | ✅ | universal. **#330** extended Ctrl+V to images — counted under A10, not here |
| D7 | Notifications | ✅ YES | 8 | ✅ | **SHIPPED #323** — OSC 9 + bell. Was the cheapest table-stakes gap in the study |
| D8 | Shell suspend | YES | 6 | ✅ | |
| D9 | Multi-line / `$EDITOR` | ✅ YES | 8 | ✅ | **SHIPPED #325** — Ctrl+X Ctrl+E + `/editor` |

### Not in the taxonomy — the one that matters most

| feature | who ships it | Minima |
| -- | -- | -- |
| **ACP (Agent Client Protocol)** | Copilot CLI (`--acp`), opencode (`opencode acp`), Goose, Zed (host), JetBrains, Cursor; there is an **ACP Agent Registry** | **NO** |

---

## 4. Track A — Parity, ranked

Every row states its denominator. Effort is a t-shirt estimate against a codebase surveyed, not built in —
treat it as the softest number here.

### ✅ Tier 1 as originally ranked — 4 of 5 shipped

Kept for the record, and because the *estimates* are the thing worth auditing. Four of the five landed in
one arc (#322–#326, #328, #330); see §0 for PRs and kill switches.

| # | feature | n/9 | est. | outcome |
| -- | -- | -- | -- | -- |
| 1 | Image input | **9/9** | S | ✅ **#322** — estimate was **wrong**. The doc said *"providers already carry image plumbing; `read.ts:50` is the single refusal point."* They carry it for **user** messages; all three dropped images from a `toolResult`. Real effort M, and it needed a coalescing hoist. |
| 2 | Context-window indicator | 8/9 | S | ✅ **#324** — premise **wrong**: `ctx NN%` had shipped since B1.2. It was not missing, it was *incorrect* (bare uncached input ÷ window). The work was a correction plus unifying auto-compact onto the same number. |
| 3 | Desktop notifications | 8/9 | S | ✅ **#323** — the one row estimated accurately. OSC 9 + bell, small delta. |
| 4 | `$EDITOR` composing | 8/9 | S | ✅ **#325** — binding **wrong**: the doc said *"Ctrl+G is the near-universal binding."* Ctrl+G is already Plan Overview / gate-arm in three handlers. Shipped as Ctrl+X Ctrl+E (readline) + `/editor`. |
| 5 | **Themes** | 7/9 | S–M | ⛔ **not built** — carried forward, re-ranked below. |

**What that says about the effort column:** three of five rows had a wrong premise, and every error was in
the same direction — the survey read the codebase from the outside and under-estimated. §7 already warned
the effort numbers were the weakest in the document; that warning is now measured, not hypothetical.
**Treat every `S` below as at least `S–M`.**

### Tier 1 (revised) — table stakes Minima still lacks, cheap

Re-ranked 2026-08-04, twice: first against what this arc shipped, then against **what the rest of the
team already has open**. Adoption first, effort as tiebreak, as before. Two rows moved on information
from *building* rather than new research (E9, M8); three left the tier entirely because someone else is
building them. Nothing here was re-surveyed — the denominators are the original study's.

| # | row | feature | n/9 | effort | why |
| -- | -- | -- | -- | -- | -- |
| 1 | **E9** | **`.minima/` project config** | **8/9** | S–M | **Promoted from Tier 2 to the top, and the case strengthened since.** Two open PRs already read `.minima/` subdirectories (#327 `skills/`, #312 `agents/`) with no config file and no precedence rules between them. This is no longer greenfield — it is consolidating a convention three features are inventing separately, and it gets more expensive every week it waits. Still unblocks E6 and E4 on top. |
| 2 | **M8** | **Reasoning-effort control for the main model** | **8/9** | **S** | **Newly cheap, and newly a defect.** #328 established that `effortForLevel` has exactly one caller (`anthropic.ts`), so `--thinking` is **inert on every openai-compat provider today** — the survey scored that PARTIAL, but it is a live bug. ⚠️ **Coordinate:** #320 and #331 both touch `openai_compat.ts` and the quirks table, and #320 is entangled with #328. Settle that collision first (§0). |
| 3 | **F9** | **Git commit authoring** | 6/9 | S–M | Reachable only through `bash` today. Attribution trailers as Crush, Amp and Copilot do. Uncontested. |
| 4 | **D3** | **Custom keybindings** | 6/9 | M | `~/.minima-harness/keybindings.json`. More attractive than at survey time and getting more so: this arc added two hardcoded chords (Ctrl+X Ctrl+E, Ctrl+V) and #318/#319 add more surface still. Uncontested. |

**Removed from this tier because someone else is already building it** — the single most important thing
this table does now:

| row | feature | n/9 | taken by |
| -- | -- | -- | -- |
| **D1** | Themes | 7/9 | 🚧 **#318** — was #3 here a week ago |
| **E5** | Skills | 8/9 | 🚧 **#327** — was the §0 "next" recommendation a week ago |
| **A2** | User-defined custom agents | 6/9 | 🚧 **#312** |

**Deliberately not promoted:** **S8** diff-review-before-apply (6/9, M) and **E8** embeddable SDK
(6/9, PARTIAL). Both are real, both are Tier 3/2 material, neither is cheap. S8 in particular is easy to
confuse with `diff_review.ts`, which is a post-hoc zero-context reviewer and a different thing.

### Tier 2 — the extensibility hole

Category E is Minima's only structurally weak axis: **2 YES / 1 PARTIAL / 8 NO**, while every other
category is majority-YES. It is also where the praise concentrates — of Claude Code's five most-praised
features, hooks and `CLAUDE.md` memory are category E; Gemini CLI's extensions ecosystem, Goose's
"everything is an extension" core, and the MCP marketplaces of both Cursor and Cline are all the same axis.

| # | feature | n/9 | effort | why |
| -- | -- | -- | -- | -- |
| 6 | **MCP client (stdio + HTTP)** | **8/9** | **L** | The clearest table-stakes verdict in the study; the sole non-adopter is the dormant one. See §5 — this collides with two invariants. Minima already *renders* MCP-shaped tool names in `layout.ts` without supporting MCP. |
| 7 | **Skills (`SKILL.md`)** 🚧 #327 | 8/9 | M | A genuine cross-vendor standard, not one vendor's idea: Crush, opencode and Copilot all read `.claude/skills/` as well as their own. Cline's three-tier progressive loading (~100-token metadata → <5k instructions → on-demand resources) is a context-budget technique that fits Minima's "projections in the context" principle exactly. |
| 8 | **Project config file (`.minima/`)** | 8/9 | S–M | ⬆️ **PROMOTED to Tier 1 #1** (2026-08-04). Minima has no repo-checked config surface at all. Prerequisite for 7, 9, 10 and 11 — which is why it moved: with Tier 1 spent, its dependents are the remaining list. |
| 9 | **User-configurable hooks** | 7/9 | M | The transplantable design is Windsurf's and Copilot's: JSON over stdin/stdout, **pre-hooks deny on exit code 2 and their stderr returns as model-visible context**, layered system → user → workspace. Fits "enforcement in the dispatcher" — a hook is dispatcher-side, not prompt text. |
| 10 | **User-authored slash commands** | 7/9 | S–M | Markdown files with argument substitution. Amp's removal is instructive: it deleted commands *in favour of* skills, so build 7 first and this may collapse into it. |
| 11 | **User-defined custom agents** 🚧 #312 | 6/9 | M | Markdown + YAML frontmatter in `.minima/agents/`. Minima has one hardcoded persona; six comparators let users define their own with per-agent model selection. |

### Tier 3 — interop, and the git surface

| # | feature | n/9 | effort | why |
| -- | -- | -- | -- | -- |
| 12 | **ACP server mode** | not in taxonomy; 4+ implementors + a registry | **M** | The highest leverage-per-unit-effort item in Track A. JSON-RPC over stdio — the shape Minima's `--mode json` already speaks. Implementing it once makes Minima runnable inside **Zed, JetBrains and VS Code with no extension work**, which is a different proposition from writing three plugins (F4/F5 rank poorly precisely because everyone reaches editors via ACP instead). Zed's single most-praised feature is hosting other agents this way. |
| 13 | **PR create / review** | 7/9 | M | Currently reachable only through `bash`. Note Copilot's cloud agent is praised specifically for *auditability* — every step is a commit — which is adjacent to Minima's ledger thesis. |
| 14 | **Diff review before apply** | 6/9 | M | Deferred at `app.tsx:7`. Distinct from `diff_review.ts`, which is a post-hoc zero-context reviewer. |
| 15 | **Git commit authoring** | 6/9 | S–M | With attribution trailers, as Crush, Amp and Copilot all do. |
| 16 | **Custom keybindings** | 6/9 | M | `~/.minima-harness/keybindings.json`. |
| 17 | **Shared team config** | 6/9 | M | `/profile` exists but is local-only; the delta is distribution. |

### Deliberately **not** recommended

Below the bar, and each would cost real effort for a feature most of the field has judged unnecessary:

**MCP server mode** (2/9) · **OS sandbox** (3/9 — and Minima is honest about not having one) ·
**vim keybindings** (3/9, and Copilot CLI has shipped without it through open issues) ·
**VS Code extension** (4/9 — do ACP instead) · **JetBrains extension** (2/9 — do ACP instead) ·
**GitHub Action** (4/9) · **SSO** (4/9 — Zed ships enterprise without it) · **seat management** (4/9) ·
**web UI** (1/9) · **desktop app** (4/9) · **issue-tracker integration** (4/9 — arrives free with MCP).

### Where Minima is already ahead — surface these, don't build them

| feature | M | n/9 | note |
| -- | -- | -- | -- |
| Checkpoints / rewind / undo | YES | 3 / 5 / 4 | Weak in the terminal, strong and *praised* among IDE agents. Amp **removed** its rollback. Minima has all three. |
| Cross-session memory | YES | 4 | opencode, Zed, Cline and Antigravity all lack it. Cline's "Memory Bank" is explicitly a documentation methodology, not a store. |
| Budget enforcement | YES | 3 | Most comparators show cost; few enforce a ceiling. |
| LSP | YES | 3 | opencode and Crush both make it a *headline praised feature* — "edit tools return errors and the LLM immediately fixes them." Minima has it and never markets it. |
| Org analytics | YES | 3 | `/cost fleet`. |
| Structured output | YES | 4 | `output_schema.ts`. |

---

## 5. Track B — Leverage

Features that compound Minima's thesis. **No comparator ships these**, so a gap analysis structurally
cannot surface them — which is why the tracks are separate.

### 5.1 First, the honest version of the routing claim

Routing is **not** uncontested, and the doc should not pretend otherwise. Four comparators auto-route per
task: **Copilot CLI** (`--model auto`, with a 10% discount attached), **Cursor** (a classifier per request on
task type and complexity, in Cost / Balance / Intelligence modes), **Windsurf** ("Adaptive"), and
**Gemini CLI** (simple prompts → Flash). Six more route auxiliary calls — titles, summaries, commit
messages — to a cheap model.

Two facts complicate the picture in Minima's favour:

- **Google's own replacement dropped it.** Gemini CLI routed; Antigravity CLI does not, and has an open
  feature request for it. Per-task routing is not yet settled even for a vendor that shipped it.
- **Every shipped router is closed.** Cursor: *"can't hand-pick which model handles a request"*, and the
  model name is **hidden by default** — their docs say so *"results are judged on their own merit rather
  than by model name."* Copilot's runs inside GitHub's hosting. Windsurf's is single-vendor.

So the surviving claim is narrower than "nobody routes", and it is a claim about **ownership and
transparency**, not novelty: *Minima is the only router that is cross-vendor, recommend-only, and
evidence-owned — the user runs the model, sees the decision, and the routing history is theirs.*

Track B should be built on that sentence, and Amp's most-praised routing line shows the market wants the
opposite framing too — *"someone else has evaluated which model fits which job"* — so both propositions have
buyers.

### 5.2 The ranked bets

**B1 — Evidence-backed tool-call adjudication.** *The strongest item in this document.*

Three comparators independently shipped the same idea under three names: Claude Code's **auto mode** (a
classifier judging each action against ~60 risk rules), Cursor's **auto-review tier** (allowlist → sandbox +
classifier → run-everything), and Goose's **Adversary Mode** (an independent reviewer agent that inspects
every tool call pre-execution and can block it). Three vendors replacing the human approval prompt with a
model's judgement.

Minima is the only party in this space with **measured evidence about that mechanism's failure modes**. The
classifier-confidence arc established, on its own corpus: self-reported confidence predicts neither
correctness nor the model's own repeatability; the mean absolute calibration gap is 0.20 on a 0–1 scale;
**a third of classifier errors occur at modal frequency 1.00** — ten identical draws, all wrong — and are
therefore invisible to *any* confidence signal, logprobs included.

That is a competitive asset, not a footnote. Everyone else is shipping a gate whose failure mode they have
not measured. Minima can ship the same category of feature with a published falsification standard, and —
uniquely — can say which decisions the gate must *not* be trusted to make. It also pairs with the one
signal in the arc that *is* grounded in falsifiable evidence rather than opinion: the verification tier.

**B2 — Route on verified outcomes, not judge opinion.** Minima's gates already produce `evidence_source="gate"`
verdicts — the only origin permitted to claim verified-in-production. Every comparator that routes does so
on priors or a vendor's curation. Routing on *did the verify command actually go red→green* is a basis
nobody else can construct, because nobody else has the gate ledger.

**B3 — Cost attribution per plan step.** The gates ledger and the budget ledger both exist and are joined by
`rec_id`. "This plan step cost $0.42 and its gate went green" is a sentence no comparator can produce. Amp
and opencode do per-subagent cost; nobody does per-*verified-outcome* cost.

**B4 — Publish the routing decision.** Cursor hides the model name deliberately. Minima's opposite move —
`/why`-style provenance for *routing* as well as verification, showing candidates, realized-cost basis, and
why this model won — is a product position, not just a feature. It is also nearly free: the decision log
already exists server-side.

**B5 — Local-first evidence portability.** Every hosted router's evidence dies with the vendor relationship.
Minima's routing history is in the user's own SQLite. Making that explicitly exportable turns an
implementation detail into a switching-cost argument that runs the right way.

### 5.3 Two ideas worth stealing that are neither parity nor thesis

- **Aider's architect/editor split** — expensive reasoner plans, cheap model edits; two independent HN
  sources praise it for *better quality at lower cost*. Aider routes by **role within a turn**; Minima routes
  by **task across turns**. Nobody does both, and Minima's plan spine is exactly the seam where a
  role-split would attach.
- **Zed's "Steer"** — queued input delivered at a step boundary between a tool call and the response,
  rather than interrupting mid-stream. Purely a scheduling decision in the agent loop; rarely implemented;
  fixes the worst ergonomic flaw of a streaming TUI. (Unrelated to `MINIMA_TUI_STEER` despite the name.)

---

## 6. Invariant collisions

Invariants hold by default. These features collide; each names the principle and what an ADR must settle.

**MCP (Track A #6) — collides with two.**

1. *Propensity integrity / spend accounting.* Every MCP tool call is spend the budget ledger and the
   feedback path do not currently model. Realized cost per turn would silently exclude third-party tool
   spend, and feedback carrying wrong realized cost degrades the single biggest accuracy lever the service
   has. **An ADR must decide whether MCP tool spend books to the session ledger, and what `actual_cost_usd`
   means once a turn includes non-model spend.**
2. *Enforcement in the dispatcher.* MCP puts arbitrary third-party tools behind the permission system.
   Cursor's typed grammar — `Mcp(server:tool)` with deny-over-allow — is the proven shape; Zed's shell-aware
   parser with non-overridable built-in rules is the hardened version. **An ADR must decide the permission
   grammar before the first server is loaded, not after.**

**User hooks (Track A #9) — collides with "enforcement in the dispatcher, guidance in the prompt."**
Arguably it *satisfies* the principle: a hook runs dispatcher-side, not as prompt text. But a hook that can
block a tool call is user code with veto power over harness guarantees. **An ADR must decide whether a hook
may override a plan gate or a permission denial, or only add restrictions.** Windsurf's fail-open/fail-closed
policy field is the prior art.

**Managed cloud (T6) — collides with "recommend-only server stands."** Not recommended anyway (3/9), but
recorded so the collision is not rediscovered: plan state must never become server-authoritative.

**ACP server mode (Track A #12) — no collision found.** It is an alternate transport over the existing
event stream. Worth stating explicitly, because its adjacency to MCP invites the assumption that it carries
the same problems. It does not.

---

## 7. What this evidence does not support

- **The comparator set moved while it was being measured.** Four of thirteen products changed lifecycle or
  governance inside the study window: Gemini CLI retired for consumer tiers (2026-06-18) and was replaced by
  Antigravity CLI; Windsurf was rebranded Devin Desktop (2026-06-02) with Cascade legacy "through July 2026";
  Goose moved to the Agentic AI Foundation under the Linux Foundation; Aider's release cadence stalled (last
  PyPI release 2026-02-12). **The matrix is a snapshot of an unstable field, not a stable ranking.**
- **Aider is carried in the denominator despite being dormant.** It is the sole non-adopter of MCP, skills
  and hooks. Excluding it moves those rows from 8/9 to 8/8 — *strengthening* every Tier-2 conclusion. No
  conclusion here depends on including it; several would be stronger without it.
- **Copilot CLI was initially mis-bucketed** as an IDE agent when it is terminal-native. Its data is
  complete and it is counted in the primary set. Disclosed because the denominator was wrong at the time
  the research was commissioned, and a reader checking the agent transcripts would otherwise find the
  discrepancy unexplained.
- **`PARTIAL` is doing real work in these counts.** Table-stakes verdicts use YES only. Several rows near
  the bar (C8 at 5/9, M9 at 5/9) would cross it if PARTIAL counted. Both are marked ⚠️ rather than resolved.
- **Effort estimates are the weakest numbers in this document.** They come from a survey of the codebase,
  not from having built in it. Do not plan against them without re-estimating.
- **"Praised" evidence is not uniformly available.** Antigravity CLI is ~6 weeks old and yielded three
  praise clusters, not five. No sentiment claim here should be read as a measurement of market share.
- **No claim about Minima's users.** Every table-stakes verdict measures what *comparators ship*, not what
  Minima's own users want. Amp is praised specifically for having *no* approval prompts and *no* token
  rationing, with users explicitly accepting higher cost for better results — direct counter-evidence to
  cost minimisation being universally the binding user need. Nothing here substitutes for asking them.

---

## 8. Reading order for review

0. **§0 Delivery ledger** — what shipped, **what 13 open PRs are already building**, and what is next.
   Start here, and re-read the in-flight table before starting anything: three of last week's five
   recommendations are now taken. The rest of the document is the argument behind it.
1. **§4 Tier 1 (revised)** — four items, after three were removed as already-in-flight. Read the
   *shipped* table above it first: three of the original five estimates had a wrong premise, all in the
   same direction, which is the calibration you need before trusting any effort number below.
2. **§4 Tier 2** — the extensibility hole. One decision (do we do MCP + skills at all), not six. Note E9
   has been promoted out of it into Tier 1, as the cheapest unblock for the rest.
3. **§4 #12 ACP** — the single highest leverage-per-effort item, and easy to miss because it was not in the
   taxonomy this study started from.
4. **§5.2 B1** — the strongest strategic item, and the only one where an asset you already own
   (the confidence arc) is the moat.
5. **§6** — three ADRs are owed before any of Tier 2 starts.
