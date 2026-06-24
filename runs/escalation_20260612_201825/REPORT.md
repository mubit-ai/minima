# Escalation Comparison Report — 2026-06-12T20:18:25Z

**Setup:** 10 hard tasks × 3 rounds × 2 arms = 60 total calls  
**Arm A:** `allow_llm_escalation=True`  
**Arm B:** `allow_llm_escalation=False`  
**Candidates:** gemini-2.5-flash, claude-haiku-4-5, claude-sonnet-4-6, gemini-2.5-pro, claude-opus-4-8  
**Memory state at start:** WARM (460+ lessons, 5 strategies)

---

## Headline result

| Metric | Arm A (ON) | Arm B (OFF) | Delta |
|--------|-----------|------------|-------|
| Avg quality | 0.8233 | 0.8200 | **+0.003** |
| Total cost | $0.22520 | $0.21648 | +$0.009 |
| LLM escalations fired | **0 / 30** | 0 / 30 | — |
| Memory-driven decisions | 4 / 30 | 4 / 30 | 0 |
| Basis distribution | 26 prior, 4 memory | 26 prior, 4 memory | identical |

**The LLM reasoner never fired in either arm.** The quality difference (+0.003) is noise, not signal from the reasoner. Turning escalation on had zero measurable effect.

---

## Per-task comparison

| Task | A quality | B quality | Delta | Notes |
|------|-----------|-----------|-------|-------|
| lru-cache | 1.000 | 0.967 | +0.033 | Random variation, same model |
| bst-implement | 0.633 | 0.767 | -0.133 | Same model, judge variance |
| painted-cube | 1.000 | 1.000 | 0.000 | B got flash via memory (correct) |
| email-regex | 0.500 | 0.500 | 0.000 | Both stuck at 0.5 |
| logic-seating | **0.767** | 0.500 | **+0.267** | A got Sonnet via memory — not escalation |
| big-o-analysis | 0.767 | **0.933** | -0.167 | B got flash via memory (scored well) |
| fallacy-detect | 1.000 | 0.967 | +0.033 | Near-identical |
| conditional-prob | 0.933 | 0.833 | +0.100 | Same model, judge variance |
| fraction-wordproblem | 0.933 | 0.967 | -0.033 | Same model, near-identical |
| multi-hop-qa | 0.700 | 0.767 | -0.067 | B got Opus in r3, boosted slightly |

Quality differences across tasks are driven by **which evidence was recalled**, not by escalation. Arm A's logic-seating advantage came from Sonnet being routed via memory — the reasoner had no role.

---

## Why escalation never fired

The LLM reasoner activates when **any** of these hold:
1. Evidence too sparse (not enough recalled neighbors)
2. Recommended model's confidence below threshold
3. Top two candidates within a narrow margin

With **460+ lessons in Mubit**, memory is warm enough that:
- Minima recalls sufficient evidence for most tasks (4/10 per round return basis=memory)
- The remaining 26/30 use prior, but the priors have wide separation between candidates (`gemini-2.5-pro` clearly dominates on hard tasks vs `gemini-2.5-flash`)
- Neither sparseness nor a coin-flip between candidates occurs

**The escalation feature is most valuable during cold start** — when memory is sparse and the deterministic path is genuinely uncertain. With warm memory, it is dormant.

---

## Verdict on the feature

**Do not add escalation as a permanent separate arm.** The comparison arm methodology was correct but the timing was wrong — warm memory suppresses escalation entirely.

**When to retest:**
- Immediately after a **namespace reset** (fresh memory, cold start)
- With a **brand new task type** Minima has never seen (0 neighbors recalled)
- With **many closely-priced candidates** (e.g. all 5 candidates within 2× cost of each other)

**Recommended use:** keep `allow_llm_escalation=True` in production (the default). Cost of the reasoner when it fires is negligible ($0.001-0.003 per escalation, ~6-8s latency). The risk of leaving it off is that cold-start routing quality degrades on genuinely ambiguous cases.

---

## Files
| File | Contents |
|---|---|
| `results.jsonl` | 60 rows — per task per round per arm |
| `summary.json` | Aggregate stats both arms |
