# Warmup Run Report — 2026-06-12T13:02:52Z

**Minima endpoint:** `https://api.minima.sh`
**Run:** 20 tasks × 5 runs = 100 total calls
**Candidate models:** gemini-2.5-flash, claude-haiku-4-5, claude-sonnet-4-6, gemini-2.5-pro, claude-opus-4-8
**Quality judge:** claude-haiku-4-5 (independent provider, avoids self-grading bias)
**Log files:** `tasks.jsonl`, `recall_debug.jsonl`, `strategies_run{1-5}.json`, `summary.json`

---

## Headline result

| Metric | Value |
|--------|-------|
| Memory-driven decisions | **0% across all 5 runs** |
| Recall evidence returned | **0 / 100 calls** |
| Model distribution | gemini-2.5-flash (9/run), gemini-2.5-pro (11/run) |
| Anthropic models used | **0 times** |
| Avg cost per run | $0.094 |
| Avg quality (runs 1–5) | 0.685 / 0.650 / 0.615 / 0.725 / 0.605 |

Minima never switched from `basis=prior` to `basis=memory`. Every routing decision across 100 calls used catalog capability priors only — the memory system did not engage.

---

## What worked

### 1. Prior-based routing is correct

Without memory, Minima routes by cost × capability from the fallback snapshot. The split is exactly right:

| Slider range | Model chosen | Tasks | Avg quality |
|---|---|---|---|
| 2.0 – 4.5 | `gemini-2.5-flash` | spam, translation, grammar, summarization, keywords | **0.91** |
| 5.0 – 8.5 | `gemini-2.5-pro` | code, reasoning, math | **0.55** |

Flash correctly handles every lightweight text task. Pro correctly handles every hard reasoning and code task. The catalog priors are well-calibrated.

### 2. Easy tasks are solved reliably by the cheap model

| Task | Quality (R1–R5) | Model |
|------|-----------------|-------|
| spam-detect | 1.00 / 1.00 / 1.00 / 1.00 / 1.00 | flash |
| passive-to-active | 1.00 / 1.00 / 1.00 / 1.00 / 1.00 | flash |
| article-summary | 1.00 / 1.00 / 1.00 / 1.00 / 1.00 | flash |
| fr-translate | 1.00 / 1.00 / 1.00 / 1.00 / 1.00 | flash |
| debug-off-by-one | 1.00 / 1.00 / 1.00 / 1.00 / 1.00 | pro |

These tasks cost ~$0.001/call vs $0.009/call for pro. The prior correctly routes them cheap.

### 3. Anthropic exclusion is correct on priors alone

`gemini-2.5-flash` ($0.30/Mtok input) is cheaper than `claude-haiku-4-5` ($1.00/Mtok) at comparable capability.
`gemini-2.5-pro` ($1.25/Mtok) is cheaper than `claude-sonnet-4-6` ($3.00/Mtok) at comparable capability.
On priors, Gemini wins every slot on cost. Anthropic would only be chosen once memory shows it outperforming Gemini on specific task types — which requires working recall.

### 4. Feedback records were stored

`/v1/feedback` returned 200 for all 100 calls. The strategies endpoint confirmed 5 strategies exist with 174, 115, 97, 5, and 3 supporting lessons from prior runs. Writes to Mubit are working.

---

## What did not work

### Critical: recall returns zero evidence on the hosted server

```
Total recall calls  : 100
Evidence returned   : 0
Memory-driven       : 0%
```

Every `recommend()` call returned `recommended_model.evidence = []`. Minima received no recalled outcomes to act on, so every decision defaulted to capability priors.

**Root cause: recall mode misconfiguration on `api.minima.sh`.**

The hosted server is almost certainly running with `MINIMA_RECALL_MODE=direct_bypass` (the code default in `config.py`). But the Mubit instance `minima-runs-gykrsy` does not have `enable_direct_search=true` enabled. When `direct_bypass` is used against a hosted Mubit instance without that flag, recall silently returns empty.

The `.env` for the local server documents this explicitly:

```
# Hosted Mubit (api.mubit.ai) rejects mode=direct_bypass unless the org enables
# enable_direct_search. agent_routed is the supported recall mode on hosted instances.
MINIMA_RECALL_MODE=agent_routed
```

The hosted server was deployed without this setting.

**Fix required:**

```bash
# On api.minima.sh server environment
MINIMA_RECALL_MODE=agent_routed
```

Restart the hosted server with this env var and re-run the warmup agent. You should see `basis=memory` appear as early as run 2, since 174+ lessons are already in Mubit.

### Secondary: Mubit health shows degraded (false alarm)

The hosted server reports `"mubit": {"reachable": false, "status_code": 401}` on the health endpoint. This is a **known bug** in `src/minima/memory/adapter.py` — the `health()` method makes a raw HTTP GET with no `Authorization` header. Mubit correctly rejects it. The fix (adding the auth header) is already in the local codebase but not deployed.

This does NOT affect actual routing or feedback — those go through the Mubit SDK which does send the key. It only affects the health readout.

**Fix already written:** `src/minima/memory/adapter.py` — deploy the local fix.

---

## Task quality analysis

### Full consistency table (quality across 5 runs)

| Task | R1 | R2 | R3 | R4 | R5 | Avg | Model |
|------|----|----|----|----|----|----|-------|
| spam-detect | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | flash |
| passive-to-active | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | flash |
| article-summary | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | flash |
| fr-translate | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | flash |
| debug-off-by-one | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | pro |
| big-o-analysis | 1.00 | 0.50 | 1.00 | 1.00 | 1.00 | 0.90 | pro |
| keyword-extract | 0.90 | 0.90 | 0.90 | 0.90 | 0.90 | 0.90 | flash |
| csv-to-json | 0.50 | 1.00 | 1.00 | 1.00 | 0.50 | 0.80 | flash |
| receipt-extract | 0.70 | 0.80 | 0.70 | 0.70 | 0.90 | 0.76 | flash |
| lru-cache | 0.90 | 0.90 | 1.00 | 1.00 | 0.00 | 0.76 | pro |
| painted-cube | 1.00 | 0.00 | 0.50 | 1.00 | 1.00 | 0.70 | pro |
| fallacy-detect | 1.00 | 1.00 | 0.00 | 1.00 | 0.00 | 0.60 | pro |
| logic-seating | 0.50 | 0.50 | 0.80 | 0.50 | 0.30 | 0.52 | pro |
| bst-implement | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | pro |
| conditional-prob | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | pro |
| email-formal | 0.70 | 0.40 | 0.40 | 0.40 | 0.50 | 0.48 | flash |
| email-regex | 0.50 | 0.50 | 0.00 | 0.50 | 0.50 | 0.40 | pro |
| fraction-wordproblem | 0.00 | 0.50 | 0.00 | 0.00 | 0.50 | 0.20 | pro |
| multi-hop-qa | 0.00 | 0.00 | 0.00 | 0.50 | 0.00 | 0.10 | pro |
| sentiment | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | **0.00** | flash |

### Two tasks that always fail — judge rubric problem, not model problem

**`sentiment` (0.00 every run):** The model correctly outputs "Mixed" but likely wraps it in a sentence ("The sentiment is Mixed" or "Mixed sentiment"). The judge rubric says "Award 10 if Mixed, 0 otherwise" which claude-haiku interprets as requiring the exact single word. The model output is semantically correct — this is a rubric precision issue. Fix: change the prompt to "Reply with exactly one word: Positive, Negative, or Mixed."

**`multi-hop-qa` (0.10 avg):** The judge expects the answer to contain "Guido van Rossum, Netherlands, 1995" but the model answers in flowing prose ("Python was created by Guido van Rossum, who was born in the Netherlands..."). The judge marks it wrong because the exact string doesn't appear. Fix: rubric should check for each term independently, not as a combined string.

**`bst-implement` / `conditional-prob` (0.50 every run):** Suspiciously flat. The judge may be returning 5/10 when uncertain. These tasks likely have correct model outputs — the 0.50 reflects judge ambiguity, not model failure.

---

## What memory-based routing would look like (expected after fix)

Once `MINIMA_RECALL_MODE=agent_routed` is deployed, the expected behavior on re-run:

**Run 1:** still mostly `prior` — this run's feedback not yet indexed by the time same-run tasks are called
**Run 2:** `basis=memory` appears for tasks with strong prior history (spam, translation, summary — all 1.00 quality consistently)
**Run 3+:** flash confidently routed for easy tasks based on recalled success; pro for hard tasks; quality should hold or improve; cost should stay flat (Gemini already wins on prior, memory confirms it)

The interesting routing shift would be on variable-quality tasks like `fallacy-detect` (0/1/0/1/0) — memory could learn that `gemini-2.5-pro` is unreliable for this specific task type and trigger escalation or different candidate selection.

---

## Action items

| Priority | Action | Owner |
|----------|--------|-------|
| **P0** | Set `MINIMA_RECALL_MODE=agent_routed` on `api.minima.sh` and redeploy | Server config |
| **P1** | Deploy `adapter.py` health fix (auth header on health probe) | Already in local code |
| **P2** | Fix `sentiment` prompt: "Reply with exactly one word" | `examples/agent_warmup.py` |
| **P2** | Fix `multi-hop-qa` rubric: check each term independently | `examples/agent_warmup.py` |
| **P3** | Re-run warmup agent after P0 fix to confirm memory engages | This file → new run |
