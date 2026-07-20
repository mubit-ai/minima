/**
 * CostMeter — per-prompt cost observability for a MinimaAgent run.
 *
 * Port of the Python harness's minima/meter.py. The routing decision isn't part of the
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
  /** F1: prompt-cache reads vs fresh input this row (0/0 on legacy rows). */
  cacheReadTokens: number;
  inputTokens: number;
  /** F1: this row's outcome came from a REAL label (gate verdict or judge grade) — the
   * only rows cost-of-pass may count as passes. */
  labeled: boolean;
}

export interface CostTotals {
  n: number;
  estCostUsd: number;
  actualCostUsd: number;
  /** Harness overhead (LLM judge spend) — real money outside every routed row, so it is
   * never part of actualCostUsd/savings and never reaches feedback's actual_cost_usd. */
  overheadUsd: number;
  baselineCostUsd: number;
  baselineRows: number;
  successes: number;
  /** F1 KV-cache accounting: Σ cache-read vs Σ fresh input tokens across rows. */
  cacheReadTokens: number;
  inputTokens: number;
  /** F1 cost-of-pass inputs: labeled rows only (gate/judge) — never self-assessed. */
  labeledRows: number;
  labeledSuccesses: number;
  get savingsUsd(): number;
  get savingsPct(): number;
  get successRate(): number;
  /** cache_read / (cache_read + input); null before any token telemetry. A 10x realized-
   * cost lever — a harness change that breaks prefix stability shows up HERE first. */
  get kvCacheHitRate(): number | null;
  /** USD per LABELED success (arXiv:2504.13359) — spend is total (all rows; money is
   * money), passes only from labeled rows. Null until a labeled success exists. */
  get costOfPassUsd(): number | null;
  /** Share of rows carrying a real label — the coverage disclosure cost-of-pass needs. */
  get labelCoverage(): number;
}

export function emptyTotals(): CostTotals {
  return {
    n: 0,
    estCostUsd: 0,
    actualCostUsd: 0,
    overheadUsd: 0,
    baselineCostUsd: 0,
    baselineRows: 0,
    successes: 0,
    cacheReadTokens: 0,
    inputTokens: 0,
    labeledRows: 0,
    labeledSuccesses: 0,
    get savingsUsd() {
      return this.baselineCostUsd - this.actualCostUsd;
    },
    get savingsPct() {
      return this.baselineCostUsd <= 0 ? 0 : (100 * this.savingsUsd) / this.baselineCostUsd;
    },
    get successRate() {
      return this.n ? (100 * this.successes) / this.n : 0;
    },
    get kvCacheHitRate() {
      const denom = this.cacheReadTokens + this.inputTokens;
      return denom > 0 ? this.cacheReadTokens / denom : null;
    },
    get costOfPassUsd() {
      return this.labeledSuccesses > 0
        ? (this.actualCostUsd + this.overheadUsd) / this.labeledSuccesses
        : null;
    },
    get labelCoverage() {
      return this.n ? this.labeledRows / this.n : 0;
    },
  };
}

export class CostMeter {
  readonly rows: CostRow[] = [];
  overheadUsd = 0;

  /** Book harness overhead (judge spend). Rejects NaN/Infinity/negatives — the hook fires
   * with 0 on judge transport errors and must never corrupt the accumulator. */
  addOverhead(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.overheadUsd += usd;
  }

  record(opts: {
    label: string;
    routing: RoutingResult | null;
    actualCostUsd: number;
    quality: number | null;
    outcome: string;
    turns?: number;
    /** F1: this row's token telemetry (prompt-cache reads vs fresh input). */
    cacheReadTokens?: number;
    inputTokens?: number;
    /** F1: a real label (gate/judge) backs this outcome. Defaults to quality-present. */
    labeled?: boolean;
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
      cacheReadTokens: opts.cacheReadTokens ?? 0,
      inputTokens: opts.inputTokens ?? 0,
      labeled: opts.labeled ?? opts.quality !== null,
    };
    this.rows.push(row);
    return row;
  }

  totals(): CostTotals {
    const t = emptyTotals();
    t.overheadUsd = this.overheadUsd;
    for (const r of this.rows) {
      t.n += 1;
      t.estCostUsd += r.estCostUsd;
      t.actualCostUsd += r.actualCostUsd;
      if (r.baselineCostUsd !== null) {
        t.baselineCostUsd += r.baselineCostUsd;
        t.baselineRows += 1;
      }
      if (r.outcome === "success") t.successes += 1;
      t.cacheReadTokens += r.cacheReadTokens;
      t.inputTokens += r.inputTokens;
      if (r.labeled) {
        t.labeledRows += 1;
        if (r.outcome === "success") t.labeledSuccesses += 1;
      }
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
    if (t.overheadUsd > 0) {
      lines.push(
        `judge overhead $${t.overheadUsd.toFixed(6)} | ` +
          `session total $${(t.actualCostUsd + t.overheadUsd).toFixed(6)}`,
      );
    }
    // F1 honest metrics: KV-cache hit rate (a realized-cost lever AND a canary — a harness
    // change that breaks prefix stability corrupts the cost basis the server learns from)
    // and cost-of-pass with its coverage disclosure (labeled passes only, never vibes).
    const hitRate = t.kvCacheHitRate;
    const cop = t.costOfPassUsd;
    const honest: string[] = [];
    if (hitRate !== null) honest.push(`kv-cache hit ${(100 * hitRate).toFixed(1)}%`);
    honest.push(
      cop !== null
        ? `cost-of-pass $${cop.toFixed(6)} (${t.labeledSuccesses} labeled pass${t.labeledSuccesses === 1 ? "" : "es"}, label coverage ${(100 * t.labelCoverage).toFixed(0)}%)`
        : `cost-of-pass n/a (no labeled successes; label coverage ${(100 * t.labelCoverage).toFixed(0)}%)`,
    );
    lines.push(honest.join(" | "));
    return lines.join("\n");
  }
}
