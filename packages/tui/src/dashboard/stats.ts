/**
 * Aggregation for the dashboard — the whole JSON contract (`/api/v1/*`) is built here.
 *
 * Honesty rules carried over from `/cost` and the scoreboard, because a dashboard that
 * disagrees with the TUI is worse than no dashboard:
 *  - quality-per-dollar over JUDGED rows only, always reported with its coverage;
 *  - savings never conflates the all-premium anchor with the configured-baseline comparison;
 *  - a cell is green only when a DETERMINISTIC gate said green (a judge's green is not);
 *  - cells under SCOREBOARD_MIN_N are suppressed, never rendered as weak signal;
 *  - every derived rate ships the n it was computed from.
 *
 * Pure functions over row arrays — no DB handle, so all of it is testable without SQLite.
 */

import { optimalCostRatio, qualityPerDollar, savings } from "../db/metrics.ts";
import { SCOREBOARD_MIN_N } from "../minima/scoreboard.ts";
import type {
  DashboardStore,
  DayRow,
  DecisionRecord,
  ModelMixRow,
  Scope,
  ScoreboardRow,
  TierRow,
} from "./queries.ts";

/** A headline number for a stat tile. `raw` is null when there is nothing to report. */
export interface Kpi {
  key: string;
  label: string;
  value: string;
  raw: number | null;
  /** Coverage or caveat — rendered under the number, never omitted. */
  note: string;
}

export interface ScoreboardCell {
  taskType: string;
  model: string;
  n: number;
  greens: number;
  reds: number;
  greenRate: number;
  redRate: number;
  medianCostUsd: number | null;
}

export interface ModelStat extends ModelMixRow {
  share: number;
  avgQuality: number | null;
  avgLatencyMs: number | null;
  costPerCall: number | null;
}

export interface GateTiers {
  green: number;
  yellow: number;
  red: number;
  ungraded: number;
  total: number;
  greenRate: number | null;
}

export interface OverviewPayload {
  scope: Scope;
  ledger: { path: string; schemaVersion: number };
  kpis: Kpi[];
  spendByDay: DayRow[];
  models: ModelStat[];
  gates: GateTiers;
  scoreboard: ScoreboardCell[];
  minN: number;
}

const usd = (n: number): string => {
  const mag = Math.abs(n);
  return `${n < 0 ? "-" : ""}${mag >= 1 ? `$${mag.toFixed(2)}` : `$${mag.toFixed(4)}`}`;
};
const pct = (rate: number): string => `${Math.round(rate * 100)}%`;

/**
 * Savings can be NEGATIVE — routing overspent the anchor. Say so instead of printing a
 * minus sign under a tile labeled "Saved" and letting the reader draw the wrong conclusion.
 */
const savingsNote = (amount: number, rows: number, anchor: string): string =>
  amount < 0
    ? `overspent this anchor by ${usd(Math.abs(amount))} · ${rows} rows priced`
    : `${anchor} · ${rows} rows priced`;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function gateTiers(rows: TierRow[]): GateTiers {
  const out: GateTiers = { green: 0, yellow: 0, red: 0, ungraded: 0, total: 0, greenRate: null };
  for (const r of rows) {
    const n = r.n ?? 0;
    out.total += n;
    if (r.tier === "green") out.green += n;
    else if (r.tier === "yellow") out.yellow += n;
    else if (r.tier === "red") out.red += n;
    else out.ungraded += n;
  }
  const graded = out.green + out.yellow + out.red;
  out.greenRate = graded > 0 ? out.green / graded : null;
  return out;
}

export function modelStats(rows: ModelMixRow[]): ModelStat[] {
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  return rows.map((r) => ({
    ...r,
    share: total > 0 ? r.n / total : 0,
    avgQuality: r.judged_n > 0 ? r.quality_sum / r.judged_n : null,
    avgLatencyMs: r.latency_n > 0 ? r.latency_sum / r.latency_n : null,
    costPerCall: r.n > 0 ? r.cost_usd / r.n : null,
  }));
}

/**
 * Per-(task_type, model) cells. Mirrors `taskTypeScoreboard` exactly — green means a
 * deterministic gate said green; anything under `minN` is dropped rather than shown weak.
 */
export function scoreboardCells(rows: ScoreboardRow[], minN = SCOREBOARD_MIN_N): ScoreboardCell[] {
  const groups = new Map<string, { taskType: string; model: string; rows: ScoreboardRow[] }>();
  for (const row of rows) {
    const key = `${row.task_type} ${row.model}`;
    const group = groups.get(key) ?? { taskType: row.task_type, model: row.model, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  const cells: ScoreboardCell[] = [];
  for (const g of groups.values()) {
    const n = g.rows.length;
    if (n < minN) continue;
    const greens = g.rows.filter(
      (r) => r.confidence === "green" && r.verified_by === "deterministic",
    ).length;
    const reds = g.rows.filter((r) => r.confidence === "red").length;
    const costs = g.rows
      .map((r) => r.cost)
      .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
    cells.push({
      taskType: g.taskType,
      model: g.model,
      n,
      greens,
      reds,
      greenRate: greens / n,
      redRate: reds / n,
      medianCostUsd: median(costs),
    });
  }
  cells.sort(
    (a, b) =>
      a.taskType.localeCompare(b.taskType) ||
      b.greenRate - a.greenRate ||
      a.model.localeCompare(b.model),
  );
  return cells;
}

/**
 * The stat-tile row. Every rate carries its n; a metric with no coverage reports "no data"
 * rather than a zero, because a fabricated zero reads as a real measurement.
 */
export function kpis(decisions: DecisionRecord[], runs: number, tiers: GateTiers): Kpi[] {
  const qpd = qualityPerDollar(decisions);
  const sav = savings(decisions);
  const ocr = optimalCostRatio(decisions);
  const judgedShare = decisions.length > 0 ? qpd.judgedRows / decisions.length : 0;

  return [
    {
      key: "runs",
      label: "Sessions",
      value: String(runs),
      raw: runs,
      note: `${decisions.length} routed decisions`,
    },
    {
      key: "spend",
      label: "Realized spend",
      value: usd(sav.actualUsd),
      raw: sav.actualUsd,
      note:
        sav.unroutedUsd > 0
          ? `${usd(sav.unroutedUsd)} of it unrouted (offline/pinned)`
          : "all of it routed",
    },
    {
      key: "savings_baseline",
      label: "Saved vs baseline",
      value: sav.baselineRows > 0 ? usd(sav.vsBaselineUsd) : "no data",
      raw: sav.baselineRows > 0 ? sav.vsBaselineUsd : null,
      note:
        sav.baselineRows > 0
          ? savingsNote(sav.vsBaselineUsd, sav.baselineRows, "honest comparison")
          : "no configured baseline recorded",
    },
    {
      key: "savings_premium",
      label: "Saved vs all-premium",
      value: sav.premiumRows > 0 ? usd(sav.vsAllPremiumUsd) : "no data",
      raw: sav.premiumRows > 0 ? sav.vsAllPremiumUsd : null,
      note:
        sav.premiumRows > 0
          ? savingsNote(sav.vsAllPremiumUsd, sav.premiumRows, "generous anchor")
          : "no premium anchor recorded",
    },
    {
      key: "qpd",
      label: "Quality per dollar",
      value: qpd.qpd === null ? "no data" : qpd.qpd.toFixed(1),
      raw: qpd.qpd,
      note:
        qpd.judgedRows > 0
          ? `judged rows only · ${qpd.judgedRows}/${qpd.totalRows} (${pct(judgedShare)})`
          : "nothing judged yet",
    },
    {
      key: "ocr",
      label: "Optimal cost ratio",
      value: ocr.ocr === null ? "no data" : pct(ocr.ocr),
      raw: ocr.ocr,
      note:
        ocr.coveredRows > 0
          ? `1.0 = already optimal · ${ocr.coveredRows}/${ocr.totalRows} covered`
          : "no evidence-backed rows",
    },
    {
      key: "gate_green",
      label: "Gate green rate",
      value: tiers.greenRate === null ? "no data" : pct(tiers.greenRate),
      raw: tiers.greenRate,
      note:
        tiers.greenRate === null
          ? "no graded gates yet"
          : `${tiers.green} green of ${tiers.green + tiers.yellow + tiers.red} graded`,
    },
  ];
}

/** Assemble the full overview payload — the shape `/api/v1/overview` returns verbatim. */
export function overview(store: DashboardStore, scope: Scope): OverviewPayload {
  const decisions = store.decisions(scope);
  const tiers = gateTiers(store.gateTiers(scope));
  return {
    scope,
    ledger: { path: store.path, schemaVersion: store.schemaVersion() },
    kpis: kpis(decisions, store.runs(scope, 1000).length, tiers),
    spendByDay: store.spendByDay(scope),
    models: modelStats(store.modelMix(scope)),
    gates: tiers,
    scoreboard: scoreboardCells(store.scoreboardRows(scope)),
    minN: SCOREBOARD_MIN_N,
  };
}
