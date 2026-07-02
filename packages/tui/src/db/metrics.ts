/**
 * Metric primitives over persisted routing_decisions — the numbers that prove (or
 * disprove) the routing thesis, computed honestly:
 *
 *  - qualityPerDollar: judged rows ONLY (abstain/cadence-skip excluded — a fabricated
 *    quality would poison the metric exactly like it poisons the server; quality=0
 *    failures are INCLUDED — failures are real signal). Reported with coverage.
 *  - savings: dual-baseline vocabulary — vs the all-premium anchor (generous; max over
 *    ranked[] est) and vs the user's configured baseline model (honest). Never conflated.
 *  - optimalCostRatio: oracle cost = per row, the cheapest ranked candidate whose
 *    predicted success clears that row's τ. Confidence-gated: prior-basis rows (no
 *    evidence) are excluded from coverage rather than pretending the estimate is an
 *    oracle. OCR ∈ (0, 1]; 1 = already routing optimally.
 */

export interface DecisionRowLike {
  quality: number | null;
  judged: number | boolean;
  outcome: string | null;
  actual_cost_usd: number | null;
  est_cost_usd: number | null;
  all_premium_cost_usd: number | null;
  configured_baseline_cost_usd: number | null;
  decision_basis: string | null;
  threshold_used: number | null;
  routed: string;
  ranked: string | null; // JSON Ranking[]
}

interface RankedLike {
  modelId?: string;
  estCostUsd?: number;
  predictedSuccess?: number;
}

export interface QpDResult {
  /** Sum(quality) / sum(actual USD) over judged rows; null when nothing judged/spent. */
  qpd: number | null;
  judgedRows: number;
  totalRows: number;
  judgedQualitySum: number;
  judgedCostUsd: number;
}

export function qualityPerDollar(rows: DecisionRowLike[]): QpDResult {
  let qualitySum = 0;
  let costSum = 0;
  let judgedRows = 0;
  for (const r of rows) {
    if (!r.judged || r.quality === null) continue; // abstain/cadence-skip: excluded
    judgedRows += 1;
    qualitySum += r.quality; // quality=0 failures included — real signal
    costSum += r.actual_cost_usd ?? 0;
  }
  return {
    qpd: judgedRows > 0 && costSum > 0 ? qualitySum / costSum : null,
    judgedRows,
    totalRows: rows.length,
    judgedQualitySum: qualitySum,
    judgedCostUsd: costSum,
  };
}

export interface SavingsResult {
  actualUsd: number;
  /** vs max(ranked est) — the generous "if every call ran premium" anchor. */
  vsAllPremiumUsd: number;
  premiumRows: number;
  /** vs the user's configured baseline model — the honest comparison. */
  vsBaselineUsd: number;
  baselineRows: number;
  totalRows: number;
  /** Spend that never routed (offline/pinned) — reported, never hidden. */
  unroutedUsd: number;
}

export function savings(rows: DecisionRowLike[]): SavingsResult {
  const out: SavingsResult = {
    actualUsd: 0,
    vsAllPremiumUsd: 0,
    premiumRows: 0,
    vsBaselineUsd: 0,
    baselineRows: 0,
    totalRows: rows.length,
    unroutedUsd: 0,
  };
  for (const r of rows) {
    const actual = r.actual_cost_usd ?? 0;
    out.actualUsd += actual;
    if (r.routed !== "server") {
      out.unroutedUsd += actual;
      continue;
    }
    if (r.all_premium_cost_usd !== null) {
      out.vsAllPremiumUsd += r.all_premium_cost_usd - actual;
      out.premiumRows += 1;
    }
    if (r.configured_baseline_cost_usd !== null) {
      out.vsBaselineUsd += r.configured_baseline_cost_usd - actual;
      out.baselineRows += 1;
    }
  }
  return out;
}

export interface OcrResult {
  /** Sum(oracle est) / sum(actual) over covered rows, capped at 1. Null = no coverage. */
  ocr: number | null;
  coveredRows: number;
  totalRows: number;
  oracleUsd: number;
  actualUsd: number;
}

export function optimalCostRatio(rows: DecisionRowLike[]): OcrResult {
  let oracleUsd = 0;
  let actualUsd = 0;
  let covered = 0;
  for (const r of rows) {
    // Confidence gate: only evidence-backed server decisions with a usable ladder.
    if (r.routed !== "server" || r.decision_basis === "prior" || !r.ranked) continue;
    let ranked: RankedLike[];
    try {
      ranked = JSON.parse(r.ranked) as RankedLike[];
    } catch {
      continue;
    }
    if (!Array.isArray(ranked) || ranked.length === 0) continue;
    const tau = r.threshold_used ?? 0;
    const clearing = ranked.filter(
      (c) => typeof c.estCostUsd === "number" && (c.predictedSuccess ?? 0) >= tau,
    );
    const pool = clearing.length ? clearing : ranked;
    const oracle = Math.min(...pool.map((c) => c.estCostUsd ?? Number.POSITIVE_INFINITY));
    if (!Number.isFinite(oracle)) continue;
    covered += 1;
    oracleUsd += oracle;
    actualUsd += r.actual_cost_usd ?? 0;
  }
  return {
    ocr: covered > 0 && actualUsd > 0 ? Math.min(1, oracleUsd / actualUsd) : null,
    coveredRows: covered,
    totalRows: rows.length,
    oracleUsd,
    actualUsd,
  };
}

/** Render the three metrics as terse report lines for /cost. */
export function metricsReport(rows: DecisionRowLike[]): string {
  if (!rows.length) return "(no persisted routing decisions yet)";
  const q = qualityPerDollar(rows);
  const s = savings(rows);
  const o = optimalCostRatio(rows);
  const lines = [
    `quality/$: ${q.qpd !== null ? q.qpd.toFixed(1) : "n/a"} (judged ${q.judgedRows}/${q.totalRows})`,
    `savings vs all-premium: $${s.vsAllPremiumUsd.toFixed(4)} over ${s.premiumRows} row(s)${
      s.baselineRows > 0
        ? ` · vs baseline: $${s.vsBaselineUsd.toFixed(4)} over ${s.baselineRows}`
        : ""
    }`,
    `optimal-cost-ratio: ${o.ocr !== null ? o.ocr.toFixed(2) : "n/a"} (covered ${o.coveredRows}/${o.totalRows})`,
  ];
  if (s.unroutedUsd > 0)
    lines.push(`unrouted spend (offline/pinned): $${s.unroutedUsd.toFixed(4)}`);
  return lines.join("\n");
}
