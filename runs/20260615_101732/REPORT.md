# Cold-Namespace Warmup Report — 2026-06-15T10:17:32Z

**Purpose:** test whether Minima is *operational* (API live) and *works* (learns from feedback
and shifts routing) — on a **fresh, isolated memory lane** so the cold→warm curve is observable.

**Minima endpoint:** `https://api.minima.sh`
**Memory lane:** `minima:warmup-cold-20260615` (fresh — existing default lane untouched)
**Seed:** 13 (new task order vs the prior seed-7 batches)
**Run:** 20 tasks × 5 runs = 100 calls. Candidates: gemini-2.5-flash, claude-haiku-4-5,
claude-sonnet-4-6, gemini-2.5-pro, claude-opus-4-8. Judge: claude-haiku-4-5.

---

## Verdict: Minima is operational and the live learn→recall→route loop closes **in-session** ✅

The headline question is answered yes. Evidence:

- **Namespace isolation works (for recall).** Pre-flight probes on the fresh lane returned
  `basis=prior`, **0 evidence** on all 3 probes → the lane started genuinely empty for outcome
  recall. (`memory_audit.json`: warmth = "STRATEGIES ONLY".)
- **The feedback→recall loop closes fast, within run 1.** In execution order, the first 3 tasks
  were `prior` (cold, 0 evidence); from task 4 onward recall began surfacing the just-written
  feedback (`basis=memory`, 3–5 evidence items). So after only ~3 feedbacks the loop closed.
- **This is materially better than the first cold batch** (`runs/20260612_130252`), which never
  recalled — 0% memory-driven across all 5 runs. That run's loop was broken/lagging; this one
  works live.

---

## Surprise finding: memory-driven % **declines** across runs (not a learning curve)

| Run | avg quality | cost (routed) | memory-driven | sonnet picks |
|----|-------------|---------------|---------------|--------------|
| 1 | 0.740 | **$0.1248** | **60%** | 7 |
| 2 | 0.725 | $0.0992 | 45% | 1 |
| 3 | **0.805** | $0.0941 | 35% | 0 |
| 4 | 0.675 | $0.0889 | 25% | 0 |
| 5 | 0.725 | $0.0960 | 25% | 0 |
| **All** | **0.734** | **$0.5029** | avg 38% | — |

(Routed-model cost only; add ~$0.10–0.15 for the 100 Haiku judge calls. Total ≈ **$0.62**.)

memory% drops 60→25 even though the **same 20 tasks** are re-fed every run. Diagnostics
(`recall_debug.jsonl`): fewer tasks return any evidence over time (avg evidence/task 2.4 → 1.2),
though tasks that *do* match saturate at 5. Six tasks flip mem→prior after run 1
(big-o-analysis, conditional-prob, email-regex, fraction-wordproblem, multi-hop-qa, painted-cube).

**Leading hypothesis (unconfirmed — recall ranking is server-side, not in this repo):** a
near-duplicate / self-match exclusion in recall. In run 1 a task has no own record, so recall
returns its (only-available) neighbors → `memory`. From run 2 the task's *own* near-identical
record from run 1 is the top match and gets filtered as a near-dup, leaving only dissimilar
neighbors below threshold → `prior`. If true, this is *correct* anti-leakage behavior (don't
"learn" a task by recalling its own identical past outcome), not a bug — but it means re-running
an identical task set is the wrong workload to show a rising learning curve. Other candidates:
reflection consolidating raw lessons (strategy count stayed at 5), or a recency/propensity term.

---

## Other findings

- **Architecture nuance — strategies/lessons are GLOBAL, recall is lane-isolated.** The audit
  reported **876 lessons / 5 strategies** on the "fresh" lane (up from 460 last batch). The
  `strategies` endpoint and the reflection/lesson pool are org-global; only the k-NN
  outcome-evidence recall is scoped to `minima:<namespace>`. So "cold lane" = empty recall, not
  an empty global brain.
- **Memory-driven ≠ cheaper here.** Run 1 was the *most* memory-driven (60%) AND the *most
  expensive* ($0.125) because memory routed 7 tasks to mid-priced sonnet-4-6 ($3/$15). Run 3 hit
  the *best* quality (0.805) at low cost with only 35% memory. Memory shifted the mix toward a
  quality-good mid model, not toward the cheapest.
- **Sentiment P0 fix did NOT resolve it — still q=0.00 in all 5 runs.** The prompt now says
  "Reply with exactly one word… No other text" and the rubric awards 10 for containing "Mixed",
  yet gemini-2.5-flash scores 0.00 every run. The warmup-report root cause ("model says Mixed but
  in a sentence, judge marks wrong") looks **misdiagnosed** — most likely the model emits a
  defensible "Negative" (the example ends "ruined the whole evening"), which the rubric's single
  "Mixed" gold label marks wrong. `tasks.jsonl` does not store the model's output text, so this
  can't be confirmed from the logs.

---

## Recommended next steps

1. **To show a real learning curve, vary the workload** — feed *paraphrases / new instances* of
   each task family, not the identical 20 prompts. If memory% then rises run-over-run, the
   near-dup-suppression hypothesis is confirmed and the system is working as intended.
2. **Capture model output text** in `tasks.jsonl` (one field) so judge disagreements like
   `sentiment` are diagnosable — then decide if `sentiment`'s gold label should accept "Negative".
3. **Confirm the recall mechanism** with Mubit core owners: does recall suppress near-duplicate /
   self matches, and at what similarity threshold? That single fact explains the whole curve.

---

## Files
| File | Contents |
|---|---|
| `memory_audit.json` | Pre-flight: 876 global lessons, 5 strategies, 3 probes (all 0-evidence → COLD recall) |
| `tasks.jsonl` | 100 rows — model, basis, quality, cost per task per run |
| `recall_debug.jsonl` | 100 rows — evidence recalled per recommend (basis, similarity, per-model) |
| `strategies_run{1-5}.json` | Strategy snapshots (count stayed 5 throughout) |
| `summary.json` | Per-run aggregates; records `namespace` + `seed` |
