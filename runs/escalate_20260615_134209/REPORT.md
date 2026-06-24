# Escalation-Learning Report — 2026-06-15T13:42:09Z

**Question:** does Minima learn, from failure feedback, to *escalate* a cheap model to a premium
one where the cheap one fails — while keeping easy tasks cheap?

**Setup (corrected after a routing-map probe):** fresh lane `minima:escalate2-20260615`; all 4
families sent as task_type=`other` at a uniform **slider 5.0** — the routing map showed this is
the regime where the cold prior picks **flash** (the pro crossover for `other` is slider 6), so
flash actually gets tried. Escalation families `work-rate`,`lattice` (flash fails / pro solves per
calibration); control families `add-mult`,`csv-to-json` (flash aces). 6 epochs, distinct instance
per family per epoch, computable answers. Candidates: flash, haiku, sonnet-4-6, pro, opus.

---

## Verdict: Minima did NOT escalate. It kept flash even as flash failed. ❌(for escalation)

Cold probe confirmed the lane started empty and the cold pick was **flash** for all 4 families.
Across all 6 epochs **every task stayed on flash** — including `work-rate`, whose flash quality
degraded as instances got harder:

| family | role | e1 | e2 | e3 | e4 | e5 | e6 | flash avg |
|---|---|----|----|----|----|----|----|-----------|
| work-rate | escalation | flash 1.0 | 1.0 | **0.5** | 1.0 | **0.5** | **0.0** | **0.67** |
| lattice | escalation | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.00 |
| add-mult | control | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.00 |
| csv-to-json | control | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.00 |

Escalation families avg_q 0.833, control 1.000; **all routed flash, all ~$0.0014/call**.

---

## Why it didn't escalate — and why that's defensible, not a bug

**At slider 5, the cost-quality optimizer keeps a 5×-cheaper model that mostly works.** flash on
work-rate had observed success ≈0.67 at ~$0.0014/call; pro is ~$0.0069 (5×). At a *middling*
quality bar (slider 5), 0.67-success-at-1/5-the-cost beats 1.0-at-5×. So memory computed the
tradeoff correctly and kept flash. Minima escalates on the **prior** when the slider is high
(routing map: `other`→pro at slider ≥6; `reasoning`→pro at slider ≥3), but it does **not** escalate
from *learned partial failure* at a moderate slider — it tolerates ~1/3 failures to save cost.

Contributing factors:
- **The failure signal was mild and mixed.** work-rate flash succeeded on the easy instances
  (epochs 1,2,4) and failed the ugly-fraction ones (3,5,6) → ~0.67 observed success, not a clear
  "flash is bad here" signal.
- **lattice was mis-calibrated easy.** This run's `_LP` combos (max C(11,6)=462) were easier than
  the calibration set (which hit C(11,6) via different params); flash aced all 6, so only
  work-rate actually exercised failure. One escalation family effectively didn't test escalation.
- The intermittent `prior, ev=0` rows (work-rate e4/e6, lattice e4) are the same recall-indexing
  flicker seen before; the pick stayed flash either way.

---

## What this means for the H1 / routing story

This is a *good* signal for the cost-savings thesis, read correctly: Minima behaves as a real
cost-quality optimizer — it won't pay 5× for marginal quality at a moderate bar, and it escalates
via the prior when the bar is high. The "C4 retention vs C1 savings" tension is exactly this knob.
But it means **"learns to escalate from failure" is gated by the slider**, not automatic on partial
failure.

---

## Sharpest follow-up to actually pin the escalation threshold

Make flash fail **consistently** (≈0 success), not 1/3, on the escalation families — e.g. harder
work-rate fractions / bigger lattice binomials calibrated to flash≈0.0, pro≈1.0. Then at slider 5:
- If Minima now escalates to pro → confirms escalation fires once learned success drops below the
  cost-justified floor (and we can bisect the slider/▼success threshold).
- If it still keeps flash at q≈0 → escalation is essentially prior/slider-driven, not
  failure-driven, which is a strong, specific claim about the engine.
Also re-calibrate lattice so both escalation families genuinely fail flash.

---

## Files
| File | Contents |
|---|---|
| `cold_probe.json` | Pre-flight: all 4 families basis=prior, 0 evidence → COLD ✓ |
| `tasks.jsonl` | 24 rows — epoch, family, role, model, basis, n_evidence, quality, outcome, cost |
| `summary.json` | per-family models_by_epoch + quality_by_epoch; escalation vs control aggregates |
