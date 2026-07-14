"""H2 fixed-probe learning curve — does Minima route better as feedback accumulates?

Implements CRITERIA.md §10: hold out a fixed, leak-free probe set; grow memory in chunks
(checkpoints 0, K, 2K, …, full); re-score the SAME probe at every checkpoint at a FIXED,
pre-registered slider; run a shuffled-label negative-control arm; average over ≥3 train
orderings. Checkpoint 0 (empty memory, flat priors) is the cold/stateless baseline.

Validity guards (temporal analogs of the H1 guards — CRITERIA.md §6):
- V6 causal ordering: probe rows are NEVER seeded; a checkpoint's picks use only feedback
  from earlier chunks. Enforced by construction and asserted (probe∩train fingerprints = ∅,
  probe near-dup-filtered against the FULL train stream before any seeding).
- V7 ingest barrier: after every chunk we wait until recall evidence saturates before the
  probe is re-scored, so the curve reflects learning, not ingest lag.

Shuffled arm (L3, "signal not volume"): per train row, the models' quality/outcome labels
are randomly permuted AMONG the candidates (volume, per-task difficulty mix, and each
model's true serving cost are preserved; which-model-succeeded is destroyed). If this arm
lifts performance like the real arm, the eval is measuring rows-in-the-DB, not learning.

The L1–L4 verdicts are REPORTED, not asserted: a negative H2 is a result, not a bug. The
pytest wrapper asserts only run validity (guards + both arms + cold/warm present).
"""

from __future__ import annotations

import random
import uuid
from dataclasses import dataclass, field

from minima.config import Settings
from minima.memory.adapter import MubitMemory
from minima.memory.keys import build_content, task_cluster
from minima.memory.records import OutcomeRecord
from minima.seeding.items import SeedItem, build_item
from tests.eval import harness as h

REAL, SHUFFLED = "real", "shuffled"


@dataclass(slots=True)
class CheckpointPoint:
    arm: str
    ordering_seed: int
    memory_size: int  # train rows seeded so far (records = rows × n_candidates)
    accuracy: float
    cost: float
    savings_vs_premium: float
    retention: float
    pick_counts: dict[str, int]
    row_scores: list[float]  # per-probe-row picked score (for paired bootstrap)
    row_costs: list[float]


@dataclass(slots=True)
class H2Result:
    candidates: list[str]
    premium: str
    slider: float
    probe_n: int
    checkpoints: list[int]
    ordering_seeds: list[int]
    points: list[CheckpointPoint]
    # L1 (real arm): warm − cold accuracy delta, paired bootstrap CI over probe rows
    lift_acc: float = 0.0
    lift_acc_ci: tuple[float, float] = (0.0, 0.0)
    lift_savings: float = 0.0
    # L2: Spearman rho(memory_size, accuracy) over all real-arm points
    trend_rho: float = 0.0
    # L3
    shuffled_lift_acc: float = 0.0
    # L4: smallest memory size reaching 90% of (warm − cold) on the averaged real curve
    convergence_k: int | None = None
    guards: dict[str, bool] = field(default_factory=dict)


def _spearman(xs: list[float], ys: list[float]) -> float:
    """Spearman rank correlation (average ranks for ties, no scipy)."""
    def ranks(v: list[float]) -> list[float]:
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r
    rx, ry = ranks(xs), ranks(ys)
    n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry, strict=True))
    dx = sum((a - mx) ** 2 for a in rx) ** 0.5
    dy = sum((b - my) ** 2 for b in ry) ** 0.5
    return num / (dx * dy) if dx and dy else 0.0


def _shuffle_labels(rows: list[h.Row], candidates: list[str], rng: random.Random) -> list[h.Row]:
    """Per row, permute WHICH model gets WHICH quality label; keep each model's true cost."""
    out: list[h.Row] = []
    for r in rows:
        perm = candidates[:]
        rng.shuffle(perm)
        scores = {m: r.scores[src] for m, src in zip(candidates, perm, strict=True)}
        out.append(h.Row(r.prompt, r.task_type, scores, dict(r.costs), r.fp, r.eval_name))
    return out


async def _seed_chunk(memory: MubitMemory, lane: str, chunk: list[h.Row], offset: int,
                      candidates: list[str], provider_for, source_dataset: str) -> int:
    """seed_train with GLOBAL item indices — the harness version restarts at 0 per call,
    which collides across chunks under deduplicate=True."""
    provider_for = h._provider if provider_for is None else provider_for
    items: list[dict] = []
    for i, row in enumerate(chunk, start=offset):
        tt, diff = row.task_type.value, "medium"
        cluster, content = task_cluster(tt, diff), build_content(tt, diff, row.prompt)
        for m in candidates:
            q = row.scores[m]
            rec = OutcomeRecord(
                model_id=m, provider=provider_for(m), task_type=tt, difficulty=diff,
                task_fingerprint=row.fp, task_cluster=cluster, cost_usd=row.costs[m],
                quality_score=q, outcome="success" if q >= 0.5 else "failure",
                source_dataset=source_dataset,
            )
            items.append(build_item(SeedItem(f"h2train-{i}-{m}", content, rec, ["seed:h2eval"])))
    inserted = 0
    for start in range(0, len(items), 100):
        res = await memory.batch_insert(run_id=lane, items=items[start:start + 100], deduplicate=True)
        inserted += int(res.get("count", 0))
    return inserted


async def _score_probe(memory: MubitMemory, lane: str, probe: list[h.Row], cards: dict,
                       candidates: list[str], premium: str, slider: float,
                       settings: Settings) -> tuple[float, float, dict[str, int], list[float], list[float]]:
    acc = cost = 0.0
    picks: dict[str, int] = {}
    row_scores: list[float] = []
    row_costs: list[float] = []
    for row in probe:
        aggs, _, _ = await h._recall_aggs(memory, lane, row, candidates, settings)
        m = h._pick(aggs, cards, row.task_type, slider, h._est_in_tokens(row.prompt), settings)
        picks[m] = picks.get(m, 0) + 1
        acc += row.scores[m]
        cost += row.costs[m]
        row_scores.append(row.scores[m])
        row_costs.append(row.costs[m])
    return acc / len(probe), cost, picks, row_scores, row_costs


async def run_learning_curve(
    *,
    settings: Settings,
    candidates: list[str],
    premium: str,
    train_n: int = 800,
    probe_n: int = 150,
    checkpoints: list[int] | None = None,  # memory sizes in TRAIN ROWS; must start at 0
    ordering_seeds: list[int] | None = None,
    slider: float = 1.0,  # FIXED for the whole experiment — pre-register it (V3 temporal analog)
    arms: tuple[str, ...] = (REAL, SHUFFLED),
    seed: int = 42,
    load_df=None,
    task_type_for=None,
    market_prices=None,
    provider_for=None,
    source_dataset: str = "llmrouterbench-h2",
) -> H2Result:
    checkpoints = checkpoints or [0, 100, 200, 400, 800]
    ordering_seeds = ordering_seeds or [42, 43, 44]
    assert checkpoints[0] == 0, "checkpoint 0 (cold baseline) is mandatory"
    assert checkpoints == sorted(checkpoints), "checkpoints must be increasing"
    assert checkpoints[-1] <= train_n

    load_df = (lambda: h.rb.load_routerbench_df("0shot")) if load_df is None else load_df
    task_type_for = h.rb._task_type_for if task_type_for is None else task_type_for
    df = load_df()
    full = h.prepare_rows(df, candidates, limit_rows=0, task_type_for=task_type_for)

    rng = random.Random(seed)
    rng.shuffle(full)
    probe_raw = full[:probe_n * 2]  # oversample; near-dup filtering will thin it
    train = full[probe_n * 2 : probe_n * 2 + train_n]
    # V6/V1: the probe must be leak-free against EVERYTHING that will ever be seeded.
    probe, dropped = h._filter_neardup(probe_raw, train, h._NEARDUP_JACCARD)
    probe = probe[:probe_n]
    if len(probe) < max(20, probe_n // 2):
        raise RuntimeError(f"too few leak-free probe rows: {len(probe)}")
    guard_v6_disjoint = not ({r.fp for r in probe} & {r.fp for r in train})
    assert guard_v6_disjoint, "V6 violated: probe fingerprint found in train stream"

    memory = MubitMemory(settings)
    catalog = h.build_catalog(settings, candidates, train, use_train_priors=False,
                              market_prices=market_prices, provider_for=provider_for)
    cards = {c.model_id: c for c in catalog.get().cards}
    prem_row_scores = [r.scores[premium] for r in probe]
    prem_row_costs = [r.costs[premium] for r in probe]
    prem_acc = sum(prem_row_scores) / len(probe)
    prem_cost = sum(prem_row_costs)

    points: list[CheckpointPoint] = []
    barrier_ok = True
    v8_checked = False
    for arm in arms:
        for oseed in ordering_seeds:
            orng = random.Random(oseed)
            stream = train[:]
            orng.shuffle(stream)
            if arm == SHUFFLED:
                stream = _shuffle_labels(stream, candidates, random.Random(oseed + 10_000))
            lane = f"{settings.minima_lane_prefix}:h2-{arm[:4]}-{oseed}-{uuid.uuid4().hex[:6]}"
            seeded_rows = 0
            for ck in checkpoints:
                if ck > seeded_rows:  # V7: seed the delta, then barrier before scoring
                    chunk = stream[seeded_rows:ck]
                    await _seed_chunk(memory, lane, chunk, seeded_rows, candidates,
                                      provider_for, source_dataset)
                    try:
                        await h._barrier(memory, lane, chunk[0], settings)
                    except Exception:
                        barrier_ok = False
                        raise
                    seeded_rows = ck
                    if not v8_checked:
                        # V8 — recall must be query-sensitive, else the "learning curve" only
                        # measures global stats over a fixed sample (see recall-bug-report.md).
                        q1 = "Evaluate the integral of a polynomial and simplify it."
                        q2 = "Debug an HTTP error in my Python web scraper session."
                        r1 = await memory.recall(query=q1, lane=lane, limit=settings.minima_memory_recall_limit,
                                                 timeout_ms=settings.minima_memory_recall_timeout_ms)
                        r2 = await memory.recall(query=q2, lane=lane, limit=settings.minima_memory_recall_limit,
                                                 timeout_ms=settings.minima_memory_recall_timeout_ms)
                        i1 = {e.entry_id for e in r1.outcome_evidence}
                        i2 = {e.entry_id for e in r2.outcome_evidence}
                        union = len(i1 | i2)
                        jac = (len(i1 & i2) / union) if union else 1.0
                        if jac > 0.5:
                            raise RuntimeError(
                                f"V8 FAIL: recall is query-independent (jaccard {jac:.2f}) — "
                                "H2 cannot be evaluated on this deployment. "
                                "See fieldnote/recall-bug-report.md."
                            )
                        v8_checked = True
                acc, cost, picks, rs, rc = await _score_probe(
                    memory, lane, probe, cards, candidates, premium, slider, settings)
                points.append(CheckpointPoint(
                    arm=arm, ordering_seed=oseed, memory_size=ck, accuracy=acc, cost=cost,
                    savings_vs_premium=(1.0 - cost / prem_cost) if prem_cost else 0.0,
                    retention=(acc / prem_acc) if prem_acc else 1.0,
                    pick_counts=picks, row_scores=rs, row_costs=rc,
                ))

    res = H2Result(candidates=list(candidates), premium=premium, slider=slider,
                   probe_n=len(probe), checkpoints=checkpoints, ordering_seeds=ordering_seeds,
                   points=points, guards={"v6_probe_disjoint": guard_v6_disjoint,
                                          "v7_barrier": barrier_ok})

    def _avg_rows(arm: str, ck: int) -> list[float]:
        """Per-probe-row picked score, averaged over orderings (paired across checkpoints)."""
        sel = [p for p in points if p.arm == arm and p.memory_size == ck]
        return [sum(p.row_scores[i] for p in sel) / len(sel) for i in range(len(probe))]

    def _mean_acc(arm: str, ck: int) -> float:
        sel = [p for p in points if p.arm == arm and p.memory_size == ck]
        return sum(p.accuracy for p in sel) / len(sel)

    warm_ck, cold_ck = checkpoints[-1], 0
    if REAL in arms:
        cold_rows, warm_rows = _avg_rows(REAL, cold_ck), _avg_rows(REAL, warm_ck)
        res.lift_acc = _mean_acc(REAL, warm_ck) - _mean_acc(REAL, cold_ck)
        brng = random.Random(seed)
        deltas = []
        n = len(probe)
        for _ in range(2000):
            idx = [brng.randrange(n) for _ in range(n)]
            deltas.append(sum(warm_rows[i] - cold_rows[i] for i in idx) / n)
        res.lift_acc_ci = (h._percentile(deltas, 0.025), h._percentile(deltas, 0.975))
        cold_sav = [p.savings_vs_premium for p in points if p.arm == REAL and p.memory_size == cold_ck]
        warm_sav = [p.savings_vs_premium for p in points if p.arm == REAL and p.memory_size == warm_ck]
        res.lift_savings = sum(warm_sav) / len(warm_sav) - sum(cold_sav) / len(cold_sav)
        real_pts = [p for p in points if p.arm == REAL]
        res.trend_rho = _spearman([float(p.memory_size) for p in real_pts],
                                  [p.accuracy for p in real_pts])
        target = _mean_acc(REAL, cold_ck) + 0.9 * res.lift_acc
        for ck in checkpoints:
            meets = _mean_acc(REAL, ck) >= target if res.lift_acc >= 0 else _mean_acc(REAL, ck) <= target
            if meets:
                res.convergence_k = ck
                break
    if SHUFFLED in arms:
        res.shuffled_lift_acc = _mean_acc(SHUFFLED, warm_ck) - _mean_acc(SHUFFLED, cold_ck)
    return res


def report(res: H2Result) -> str:
    lines = ["=" * 88,
             f"H2 fixed-probe learning curve   slider={res.slider} (FIXED)   probe={res.probe_n}"
             f"   orderings={res.ordering_seeds}",
             f"candidates = {res.candidates}   premium = {res.premium}",
             "-" * 88,
             f"{'arm':<9} {'memory':>7}  {'accuracy':>8}  {'retention':>9}  {'savings':>8}  picks"]
    for arm in (REAL, SHUFFLED):
        for ck in res.checkpoints:
            sel = [p for p in res.points if p.arm == arm and p.memory_size == ck]
            if not sel:
                continue
            acc = sum(p.accuracy for p in sel) / len(sel)
            ret = sum(p.retention for p in sel) / len(sel)
            sav = sum(p.savings_vs_premium for p in sel) / len(sel)
            picks: dict[str, int] = {}
            for p in sel:
                for m, c in p.pick_counts.items():
                    picks[m] = picks.get(m, 0) + c
            top = ", ".join(f"{m}:{c}" for m, c in sorted(picks.items(), key=lambda x: -x[1])[:3])
            tag = "  <-- COLD" if ck == 0 else ("  <-- WARM" if ck == res.checkpoints[-1] else "")
            lines.append(f"{arm:<9} {ck:>7}  {acc:>8.3f}  {ret:>9.1%}  {sav:>8.1%}  {top}{tag}")
        lines.append("")
    lo, hi = res.lift_acc_ci
    l1 = res.lift_acc >= 0.03 and lo > 0.0
    l2 = res.trend_rho > 0.0
    l3 = res.lift_acc > res.shuffled_lift_acc
    lines += [
        f"L1 learning_lift_acc = {res.lift_acc:+.3f}  (95% CI [{lo:+.3f}, {hi:+.3f}])"
        f"  -> >=+0.03 & CI>0? {'PASS' if l1 else 'FAIL'}",
        f"L2 trend rho(memory, acc) = {res.trend_rho:+.3f}  -> >0? {'PASS' if l2 else 'FAIL'}",
        f"L3 real {res.lift_acc:+.3f} vs shuffled {res.shuffled_lift_acc:+.3f}"
        f"  -> real>shuffled? {'PASS' if l3 else 'FAIL'}",
        f"L4 convergence_K = {res.convergence_k} train rows to 90% of lift  [reported]",
        f"   learning_lift_savings = {res.lift_savings:+.1%}",
        f"guards: {res.guards}",
        "VERDICT: H2 " + ("supported" if (l1 and l2 and l3) else "NOT supported"),
        "=" * 88,
    ]
    return "\n".join(lines)
