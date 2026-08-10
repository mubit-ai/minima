/**
 * Metric primitives over persisted routing_decisions — the numbers that prove (or
 * disprove) the routing thesis, computed honestly:
 *
 *  - qualityPerDollar: judged rows ONLY (abstain/cadence-skip excluded — a fabricated
 *    quality would poison the metric exactly like it poisons the server; quality=0
 *    failures are INCLUDED — failures are real signal). Reported with coverage in
 *    DOLLARS as well as rows: 47 of 492 rows sounds survivable, 2.5% of the money
 *    does not.
 *  - savings: realized spend and the share of it that never routed. It no longer
 *    subtracts anything, because the two columns it used to subtract are different
 *    units — `all_premium_cost_usd` and `configured_baseline_cost_usd` are per-CALL
 *    estimates while `actual_cost_usd` is a per-TURN realized cost, ~10.75x larger on
 *    a real ledger. That subtraction reported a generous anchor as a $34 loss. Anchor
 *    comparisons live in `anchors.ts`, in one unit.
 *
 * `optimalCostRatio` was removed with the same subtraction: its oracle was an estimate
 * over a realized denominator, so it read 4%; repaired to est-over-est it is >= 1 by
 * construction on real data and its own cap pins it at exactly 1.0 forever. A metric
 * that can only ever print one value is not a measurement.
 */

import { type AnchorTotals, anchorBoard, anchorTotals, defaultAnchor } from "./anchors.ts";

export interface DecisionRowLike {
  quality: number | null;
  judged: number | boolean;
  outcome: string | null;
  chosen_model: string | null;
  actual_cost_usd: number | null;
  est_cost_usd: number | null;
  all_premium_cost_usd: number | null;
  configured_baseline_cost_usd: number | null;
  decision_basis: string | null;
  threshold_used: number | null;
  routed: string;
  ranked: string | null; // JSON Ranking[]
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
  totalRows: number;
  /** Spend that never routed (offline/pinned) — reported, never hidden. */
  unroutedUsd: number;
  /** Spend the router decided, and the only population an anchor can speak for. */
  routedUsd: number;
  routedRows: number;
}

/**
 * Realized spend, split by whether the router decided it. No subtraction happens here — see the
 * module header for why the two "baseline" columns cannot be subtracted from `actual_cost_usd`.
 */
export function savings(rows: DecisionRowLike[]): SavingsResult {
  const out: SavingsResult = {
    actualUsd: 0,
    totalRows: rows.length,
    unroutedUsd: 0,
    routedUsd: 0,
    routedRows: 0,
  };
  for (const r of rows) {
    const actual = r.actual_cost_usd ?? 0;
    out.actualUsd += actual;
    if (r.routed === "server") {
      out.routedUsd += actual;
      out.routedRows += 1;
    } else {
      out.unroutedUsd += actual;
    }
  }
  return out;
}

/**
 * The evidence sentence that must travel with every anchor number: how much of it is two stored
 * numbers (direct) versus a recovered token vector (solved), and how much money went unpriced.
 */
export function anchorEvidence(t: AnchorTotals, routedUsd: number): string {
  const priced = routedUsd > 0 ? (t.actualUsd / routedUsd) * 100 : 0;
  const parts = [`${t.directRows} direct / ${t.solvedRows} solved`];
  if (t.excludedRows > 0) parts.push(`${t.excludedRows} unpriced`);
  parts.push(`${priced.toFixed(1)}% of routed $`);
  return parts.join(" · ");
}

/**
 * The counterweight to a negative saving. A cheap anchor "saves" money on turns it would have
 * failed, and without this the minus sign reads as "routing wasted that much".
 */
export function tauMissNote(t: AnchorTotals): string | null {
  // "missed ... on 0 of 5 rows" is not a weaker counterweight, it is a misleading one: it plants a
  // quality doubt where the evidence says there is none. No misses means no sentence.
  if (t.tauKnownRows === 0 || t.tauMissRows === 0) return null;
  const pct = (t.tauMissRows / t.tauKnownRows) * 100;
  return `missed the row's own threshold on ${t.tauMissRows} of ${t.tauKnownRows} rows (${pct.toFixed(0)}%)`;
}

/**
 * Terse report lines for `/cost`. Reads the SAME `anchors.ts` functions the dashboard reads, so
 * one command's output and one browser tab cannot print different savings for one ledger.
 */
export function metricsReport(rows: DecisionRowLike[], anchorId?: string): string {
  if (!rows.length) return "(no persisted routing decisions yet)";
  const q = qualityPerDollar(rows);
  const s = savings(rows);
  const judgedShare = s.actualUsd > 0 ? (q.judgedCostUsd / s.actualUsd) * 100 : 0;
  const lines = [
    `quality/$: ${q.qpd !== null ? q.qpd.toFixed(1) : "n/a"} (judged ${q.judgedRows}/${q.totalRows} rows — $${q.judgedCostUsd.toFixed(4)} of $${s.actualUsd.toFixed(4)}, ${judgedShare.toFixed(1)}% of spend)`,
    `spend: $${s.actualUsd.toFixed(4)} realized${
      s.unroutedUsd > 0 ? ` · $${s.unroutedUsd.toFixed(4)} unrouted (offline/pinned)` : ""
    }`,
  ];
  const board = anchorBoard(rows);
  const anchor = anchorId ?? defaultAnchor(board);
  if (anchor) {
    const t = anchorId
      ? anchorTotals(rows, anchorId)
      : board.models.find((m) => m.modelId === anchor);
    if (t && t.directRows + t.solvedRows > 0) {
      const pct = t.savedPct !== null ? ` (${(t.savedPct * 100).toFixed(1)}%)` : "";
      lines.push(
        `vs ${anchor}: $${t.anchorUsd.toFixed(4)} → saved $${t.savedUsd.toFixed(4)}${pct} · estimated · ${anchorEvidence(t, s.routedUsd)}`,
      );
      const miss = t.savedUsd < 0 ? tauMissNote(t) : null;
      if (miss) lines.push(`  ${anchor} ${miss} — the cheaper bill is not the same work`);
    }
  }
  return lines.join("\n");
}
