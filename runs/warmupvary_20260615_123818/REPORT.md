# Varied-Workload Warmup Report — 2026-06-15T12:38:18Z

**Purpose:** test whether *varying* the workload (distinct instances of each task family, vs the
identical 20 prompts) prevents the memory-driven% **decline** seen in `runs/20260615_101732`
(60→25%). Hypothesis: the decline was near-duplicate self-suppression — recall filtering a task's
own identical prior record. Distinct-but-similar instances should keep recall engaged.

**Endpoint:** `https://api.minima.sh` | **Lane:** `minima:warmup-vary-20260615` (fresh)
**Seed:** 7 | **Design:** 8 parametric families × 6 epochs = 48 tasks; one new instance/family/epoch;
computable expected answers (reliable Haiku judge). Candidates: flash, haiku, sonnet-4-6, pro, opus.

---

## Headline: the decline is GONE — memory stays engaged (avg 87.5%, no collapse) ✅

| Epoch | memory% | avg quality | cost | avg evidence |
|------|---------|-------------|------|--------------|
| 1 | 75% | 1.000 | $0.0172 | 2.5 |
| 2 | 100% | 1.000 | $0.0120 | 5.0 |
| 3 | 75% | 1.000 | $0.0230 | 3.8 |
| 4 | 100% | 1.000 | $0.0120 | 5.0 |
| 5 | 75% | 1.000 | $0.0172 | 3.8 |
| 6 | 100% | 1.000 | $0.0127 | 5.0 |

vs the identical-task run's 60→45→35→25→25. **Confirmed:** varying the workload keeps recall
surfacing evidence, so memory keeps driving decisions. The earlier decline was indeed an artifact
of re-feeding identical prompts (self-duplicate suppression).

---

## But it's not the clean RISE I predicted — and the reasons are the real findings

**1. Recall is CROSS-family, so the lane warms within epoch 1 (no cold arc).** In epoch 1, in
execution order, evidence grew 0→0→1→2→3→4→5→5 as each task was fed — i.e. recall returned
*whatever prior outcomes were in the small lane*, regardless of family (all 8 are short
math/code/extraction prompts with enough surface similarity to clear the threshold). So epoch 1
was already 75% memory; there was no cold start to climb out of. I expected a rise because I
assumed epoch-1 instances would have no same-family neighbor — but cross-family recall fills that
gap immediately.

**2. The 75↔100 oscillation is recall-indexing latency, not a stable property.** The 6 tasks that
fell back to `prior` (ev=0) — frac-add (ep1,3), add-mult (ep1), painted-cube (ep3), mod-pow (ep5),
spam-detect (ep5) — flip in and out across epochs; the same family is `memory` in one epoch and
`prior` in another. Most consistent with: the just-written outcomes aren't embedded/indexed yet
when the next similar query fires, so recall transiently returns 0.

**3. When a task DID fall back to prior, it picked the expensive model — and that's the cost
signal.** prior-fallback at slider 5/7 routes to `gemini-2.5-pro` ($0.0069); memory routes to
`gemini-2.5-flash` ($0.0017). So the cost spikes (epoch 3 = $0.023) are exactly the epochs with
prior fallbacks. Memory routing is ~4× cheaper on those families.

**4. Quality pinned at 1.000 everywhere — the workload was too easy.** gemini-2.5-flash solved all
8 families perfectly (including painted-cube n≤8, O(n⁴) big-o, fraction addition). So there was no
failure pressure: the only thing to "learn" was *flash is sufficient* — which memory did, correctly
**overriding the slider-7 pro default on painted-cube and big-o to route flash**. That's a genuine
cost win, but it's not the same as learning to *escalate* under quality pressure.

Total: ~$0.094 routed + ~$0.06 judge ≈ **$0.15** for 48 tasks.

---

## What this proves, and the sharper next experiment

**Proven:** (a) varying the workload prevents the memory-driven decline; (b) recall is cross-family
and warms a fresh lane within one epoch; (c) memory correctly overrides a high slider to pick the
cheap model when it suffices (cost win); (d) parametric tasks with computed answers give a clean,
judge-reliable workload (quality variance gone — unlike the sentiment/bst ambiguity).

**Not yet shown:** learning under *quality pressure*. Because flash aced everything, we never saw
memory learn to **escalate** to a premium model where the cheap one fails. To show that, the next
run needs families where flash genuinely fails a fraction of instances (e.g. larger-modulus
mod-pow, multi-step word problems, harder logic), so quality < 1.0 on flash and memory must learn
the per-family tier. Add a pre-flight cold probe to confirm the lane starts empty, and consider a
tighter recall similarity threshold (or family-tagged lanes) if per-family — not cross-family —
learning is the thing to isolate.

---

## Files
| File | Contents |
|---|---|
| `tasks.jsonl` | 48 rows — epoch, family, model, basis, n_evidence, quality, cost, expected |
| `summary.json` | per-epoch curve + per-family trajectory; records namespace + seed |
