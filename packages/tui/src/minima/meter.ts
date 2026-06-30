/**
 * CostMeter — per-prompt cost observability for a MinimaAgent run.
 *
 * Port of minima_harness/minima/meter.py. The routing decision isn't part of the
 * AgentEvent stream, so the meter is fed directly from prompt() rather than via
 * subscribe(). Accumulates one row per prompt and renders a report + summary totals.
 */

import type { RoutingResult } from "./router.ts";

export interface CostRow {
  label: string;
  model: string;
  decisionBasis: string;
  estCostUsd: number;
  actualCostUsd: number;
  baselineCostUsd: number | null;
  quality: number | null;
  outcome: string;
  turns: number;
}

export interface CostTotals {
  n: number;
  estCostUsd: number;
  actualCostUsd: number;
  baselineCostUsd: number;
  baselineRows: number;
  successes: number;
  get savingsUsd(): number;
  get savingsPct(): number;
  get successRate(): number;
}

export function emptyTotals(): CostTotals {
  return {
    n: 0,
    estCostUsd: 0,
    actualCostUsd: 0,
    baselineCostUsd: 0,
    baselineRows: 0,
    successes: 0,
    get savingsUsd() {
      return this.baselineCostUsd - this.actualCostUsd;
    },
    get savingsPct() {
      return this.baselineCostUsd <= 0 ? 0 : (100 * this.savingsUsd) / this.baselineCostUsd;
    },
    get successRate() {
      return this.n ? (100 * this.successes) / this.n : 0;
    },
  };
}

export class CostMeter {
  readonly rows: CostRow[] = [];

  record(opts: {
    label: string;
    routing: RoutingResult | null;
    actualCostUsd: number;
    quality: number | null;
    outcome: string;
    turns?: number;
  }): CostRow {
    const { routing } = opts;
    const row: CostRow = {
      label: opts.label,
      model: routing?.chosenModelId ?? "(offline)",
      decisionBasis: routing?.decisionBasis ?? "-",
      estCostUsd: routing?.estCostUsd ?? 0,
      actualCostUsd: opts.actualCostUsd,
      baselineCostUsd: routing?.baselineCostUsd ?? null,
      quality: opts.quality,
      outcome: opts.outcome,
      turns: opts.turns ?? 0,
    };
    this.rows.push(row);
    return row;
  }

  totals(): CostTotals {
    const t = emptyTotals();
    for (const r of this.rows) {
      t.n += 1;
      t.estCostUsd += r.estCostUsd;
      t.actualCostUsd += r.actualCostUsd;
      if (r.baselineCostUsd !== null) {
        t.baselineCostUsd += r.baselineCostUsd;
        t.baselineRows += 1;
      }
      if (r.outcome === "success") t.successes += 1;
    }
    return t;
  }

  report(): string {
    if (!this.rows.length) return "(cost meter: no prompts recorded)";
    const cols = [
      "label",
      "model",
      "basis",
      "est$",
      "actual$",
      "save$",
      "turns",
      "quality",
      "outcome",
    ] as const;
    const rendered = this.rows.map((r) => ({
      label: r.label,
      model: r.model,
      basis: r.decisionBasis,
      est$: r.estCostUsd.toFixed(6),
      actual$: r.actualCostUsd.toFixed(6),
      save$: r.baselineCostUsd !== null ? (r.baselineCostUsd - r.actualCostUsd).toFixed(6) : "-",
      turns: String(r.turns),
      quality: r.quality !== null ? r.quality.toFixed(2) : "-",
      outcome: r.outcome,
    }));
    const widths = Object.fromEntries(
      cols.map((c) => [c, Math.max(c.length, ...rendered.map((row) => String(row[c]).length))]),
    ) as Record<(typeof cols)[number], number>;
    const header = cols.map((c) => c.padEnd(widths[c])).join("  ");
    const lines = [header, "-".repeat(header.length)];
    for (const row of rendered) {
      lines.push(cols.map((c) => String(row[c]).padEnd(widths[c])).join("  "));
    }
    const t = this.totals();
    lines.push("");
    lines.push(
      `total actual $${t.actualCostUsd.toFixed(6)} | ` +
        `baseline $${t.baselineCostUsd.toFixed(6)} (${t.baselineRows} rows) | ` +
        `savings ${t.savingsPct.toFixed(1)}% ($${t.savingsUsd.toFixed(6)}) | ` +
        `success ${t.successRate.toFixed(1)}% (${t.successes}/${t.n})`,
    );
    return lines.join("\n");
  }
}
