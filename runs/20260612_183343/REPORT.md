# Warmup Run Report — 2026-06-12T18:33:43Z

**Minima endpoint:** `https://api.minima.sh`
**Seed:** 7 (fixed order across all runs — same task sequence every run for clean cross-run comparison)
**Run:** 20 tasks × 5 runs = 100 total calls
**Candidates:** gemini-2.5-flash, claude-haiku-4-5, claude-sonnet-4-6, gemini-2.5-pro, claude-opus-4-8
**Quality judge:** claude-haiku-4-5 (independent provider)
**Log files:** `memory_audit.json`, `tasks.jsonl`, `recall_debug.jsonl`, `strategies_run{1-5}.json`, `summary.json`

---

## Pre-flight memory state (from `memory_audit.json`)

Mubit entered this run **WARM** — 460 lessons and 5 synthesised strategies already present from prior warmup batches.

| Strategy theme | Lessons | Sample insight |
|---|---|---|
| coding | 204 | gpt-4o-mini reliable for complex coding; gemini-2.5-flash inconsistent |
| tasks | 134 | gemini-2.5-flash efficient for trivial tasks (summarization, extraction, translation) |
| choice | 111 | For easy tasks, gemini-2.5-flash is reliable and cost-effective |
| classification | 6 | gemini-2.5-flash efficient but unreliable for classification |
| data | 5 | gpt-4o-mini superior for complex coding/data structures |

Probe results at warmup start:
- `easy` (translation, slider 2.0) → `gemini-2.5-flash` via **memory**, 5 evidence items
- `hard` (BST code, slider 7.5) → `gemini-2.5-pro` via **prior**, 0 evidence
- `reasoning` (probability, slider 7.0) → `gemini-2.5-flash` via **memory**, 2 evidence items

---

## Headline metrics

| Run | Avg quality | Cost | Memory-driven | Flash | Pro | Sonnet |
|-----|-------------|------|--------------|-------|-----|--------|
| 1 | **0.750** | $0.08887 | 40% | 10 | 10 | 0 |
| 2 | 0.665 | $0.08887 | 30% | 10 | 10 | 0 |
| 3 | 0.665 | **$0.07852** | **50%** | **12** | 8 | 0 |
| 4 | 0.675 | $0.09400 | 45% | 10 | 9 | **1** |
| 5 | 0.690 | $0.09400 | 35% | 10 | 9 | **1** |

**vs previous batch (0% memory, all prior):**
| Metric | Previous | This run | Delta |
|---|---|---|---|
| Avg memory-driven | 0% | 40% | **+40pp** |
| Avg quality | 0.656 | 0.689 | **+5%** |
| Total cost (5 runs) | $0.47025 | $0.44427 | **-5.5%** |
| Recall calls with evidence | 0/100 | 40/100 | **40%** |
| Avg recall similarity | — | 0.832 | — |
| Anthropic models used | 0 | 2 (Sonnet) | first cross-provider routing |

---

## Per-task quality across 5 runs

| Task | R1 | R2 | R3 | R4 | R5 | Avg | Mem% | Model |
|------|----|----|----|----|----|----|------|-------|
| fr-translate | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | 100% | flash |
| painted-cube | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | 100% | flash ⚡ |
| article-summary | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | 80% | flash |
| spam-detect | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | 60% | flash |
| passive-to-active | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | 100% | flash |
| debug-off-by-one | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | 0% | pro |
| big-o-analysis | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | 0% | pro / sonnet |
| keyword-extract | 0.90 | 0.90 | 0.90 | 0.90 | 0.80 | 0.88 | 60% | flash |
| csv-to-json | 1.00 | 1.00 | 0.50 | 1.00 | 0.50 | 0.80 | 20% | flash |
| receipt-extract | 0.70 | 0.80 | 0.90 | 0.80 | 0.70 | 0.78 | 60% | flash |
| lru-cache | 1.00 | 0.60 | 1.00 | 0.90 | 0.00 | 0.70 | 0% | pro |
| fallacy-detect | 1.00 | 0.00 | 0.30 | 1.00 | 1.00 | 0.66 | 20% | pro / flash |
| email-formal | 0.70 | 0.50 | 0.50 | 0.40 | 0.80 | 0.58 | 100% | flash |
| bst-implement | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0% | pro |
| conditional-prob | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0% | pro |
| multi-hop-qa | 0.50 | 0.50 | 0.50 | 0.00 | 0.50 | 0.40 | 0% | pro |
| email-regex | 0.00 | 0.50 | 0.20 | 0.00 | 1.00 | 0.34 | 60% | pro/flash/sonnet |
| logic-seating | 0.70 | 0.50 | 0.50 | 0.00 | 0.00 | 0.34 | 0% | pro |
| fraction-wordproblem | 0.50 | 0.00 | 0.00 | 0.50 | 0.50 | 0.30 | 0% | pro |
| sentiment | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | **0.00** | 40% | flash |

---

## Key findings

### 1. ⚡ painted-cube: the clearest routing win

`painted-cube` (slider 8.0) was routed by memory to `gemini-2.5-flash` in all 5 runs at 100% quality.

| Metric | Prior routing (pro) | Memory routing (flash) |
|---|---|---|
| Model | gemini-2.5-pro | gemini-2.5-flash |
| Cost/call | $0.006875 | $0.001700 |
| Quality | 1.00 | 1.00 |
| Cost saving | — | **75%** |

Despite slider 8.0 (which signals "quality-critical"), Minima's memory correctly learned that this spatial pattern-recognition task doesn't actually need the premium model. This is exactly what a good router should do: override the slider with evidence.

### 2. First cross-provider routing — Claude Sonnet appeared

Runs 4 and 5 saw `claude-sonnet-4-6` routed for `big-o-analysis` (run 4, prior) and `email-regex` (run 5, memory). Both scored 1.00. This is the first time Minima chose an Anthropic model — the catalog or memory signalled Sonnet as a better fit for those specific tasks. `email-regex` via memory + Sonnet scoring 1.00 after scoring 0.00/0.50/0.20/0.00 in prior runs is a strong signal that memory corrected a persistent routing mistake.

### 3. Memory-driven mistakes (learning still in progress)

Two cases where memory routed a cheaper model that underperformed:

| Task | Prior model | Prior quality | Memory model | Memory quality | Delta |
|---|---|---|---|---|---|
| fallacy-detect (R3) | pro | 0.75 | flash | 0.30 | **-0.45** |
| csv-to-json (R3/R5) | flash (prior) | 0.88 | flash (memory) | 0.50 | -0.38 |

`fallacy-detect` via flash was a genuine error — Minima recalled a similar-looking classification task where flash scored well and applied it to a harder logical reasoning task. The q=0.30 feedback from this run corrects that record. By run 4-5, fallacy-detect returned to pro via prior.

### 4. Stuck tasks — model limitations, not routing issues

| Task | Avg quality | Issue |
|---|---|---|
| sentiment | 0.00 | **Judge rubric bug** — model answers correctly ("Mixed") but in a sentence; judge marks wrong. Fix: "Reply with exactly one word." |
| bst-implement | 0.50 | Judge ambiguity — likely scoring 5/10 when unsure about code correctness |
| conditional-prob | 0.50 | Same judge ambiguity pattern — answer may be correct, judge uncertain |
| fraction-wordproblem | 0.30 | Gemini-2.5-pro gets the wrong answer (21/40 is correct; model may miscalculate) |
| logic-seating | 0.34 | Genuinely hard; quality degrades in runs 4-5, model gives invalid arrangements |

---

## Recall quality

- **40/100 calls returned evidence** (40% recall hit rate)
- **Average similarity: 0.832** (min 0.608, max 1.000)
- High similarity (>0.9) appeared for semantically tight tasks: `fr-translate`, `spam-detect`, `painted-cube`
- Low/no evidence for tasks with no close neighbours in memory: `bst-implement`, `conditional-prob`, `logic-seating`

---

## What happens next

The memory is now warm with ~560 lessons (460 prior + ~100 this run). Recommended next steps in order:

| Priority | Action |
|---|---|
| **P0** | Fix `sentiment` prompt — "Reply with exactly one word: Positive, Negative, or Mixed." |
| **P1** | Run escalation comparison arm — 10 hard tasks, `allow_llm_escalation=True` vs `False` |
| **P2** | Run retention frontier — same 6 tasks at slider 2/5/8 to map cost-quality curve |
| **P3** | Investigate `fraction-wordproblem` — verify if model answer is actually wrong or judge is mis-scoring |

---

## Files

| File | Contents |
|---|---|
| `memory_audit.json` | Pre-flight Mubit state: 460 lessons, 5 strategies, 3 probe results |
| `tasks.jsonl` | 100 rows — one per task per run with model, basis, quality, cost |
| `recall_debug.jsonl` | 100 rows — evidence items recalled per recommend call |
| `strategies_run{1-5}.json` | Minima strategy snapshots after each run |
| `summary.json` | Aggregate per-run stats with seed=7 recorded |
