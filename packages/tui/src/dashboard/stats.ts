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
import type { GateRow } from "../db/minima_db.ts";
import { SCOREBOARD_MIN_N } from "../minima/scoreboard.ts";
import { gateVerdictFor, parseFactors } from "../minima/why.ts";
import type {
  DashboardStore,
  DayRow,
  DecisionRecord,
  FileChangeRow,
  ModelMixRow,
  PlanDetail,
  PlanStepRow,
  PlanSummary,
  RunSummary,
  Scope,
  ScoreboardRow,
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

export interface GateReason {
  tier: string;
  reason: string;
  n: number;
}

export interface GateTiers {
  green: number;
  yellow: number;
  red: number;
  /** No tier even after deriving from factors_json — genuinely unverified. */
  ungraded: number;
  total: number;
  greenRate: number | null;
  /** Why gates landed where they did, worst-first — the actionable part of the chart. */
  reasons: GateReason[];
}

export interface OverviewPayload {
  scope: Scope;
  ledger: { path: string; schemaVersion: number };
  kpis: Kpi[];
  spendByDay: DayRow[];
  models: ModelStat[];
  gates: GateTiers;
  /** Deterministic step-check outcomes — the one gate series with full coverage. */
  passRate: PassRate;
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

/**
 * Tier distribution over gate rows, derived exactly as `/why` derives it: prefer the tier
 * stamped on the row, else recompute it from `factors_json`.
 *
 * Reading the raw `confidence` column instead would be wrong — a `step_check` gate is
 * written with `confidence: null` by design (the stored tier is a milestone-level rollup),
 * so the column reports every step check as ungraded even when it carries a real
 * deterministic outcome.
 */
export function gateTiers(rows: GateRow[]): GateTiers {
  const out: GateTiers = {
    green: 0,
    yellow: 0,
    red: 0,
    ungraded: 0,
    total: rows.length,
    greenRate: null,
    reasons: [],
  };
  const tally = new Map<string, GateReason>();
  for (const row of rows) {
    const verdict = gateVerdictFor(row);
    const tier = verdict.tier;
    if (tier === "green") out.green += 1;
    else if (tier === "yellow") out.yellow += 1;
    else if (tier === "red") out.red += 1;
    else out.ungraded += 1;

    const key = `${tier ?? "ungraded"}::${verdict.reason}`;
    const seen = tally.get(key);
    if (seen) seen.n += 1;
    else tally.set(key, { tier: tier ?? "ungraded", reason: verdict.reason, n: 1 });
  }
  const graded = out.green + out.yellow + out.red;
  out.greenRate = graded > 0 ? out.green / graded : null;
  const badness: Record<string, number> = { red: 0, yellow: 1, ungraded: 2, green: 3 };
  out.reasons = [...tally.values()].sort(
    (a, b) => (badness[a.tier] ?? 9) - (badness[b.tier] ?? 9) || b.n - a.n,
  );
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
  const gateRows = store.gateRows(scope);
  const tiers = gateTiers(gateRows);
  return {
    scope,
    ledger: { path: store.path, schemaVersion: store.schemaVersion() },
    kpis: kpis(decisions, store.runs(scope, 1000).length, tiers),
    spendByDay: gapFillDays(store.spendByDay(scope)),
    passRate: stepCheckPassRate(gateRows),
    models: modelStats(store.modelMix(scope)),
    gates: tiers,
    scoreboard: scoreboardCells(store.scoreboardRows(scope)),
    minN: SCOREBOARD_MIN_N,
  };
}

/* ───────────────────────────── sessions: freshness, not liveness ──────────────────────────── */

export interface SessionRow extends RunSummary {
  /** Seconds since the newest recorded event, or null when the run recorded none. */
  ageSeconds: number | null;
}

export interface SessionList {
  rows: SessionRow[];
  /** Runs with zero events — empty shells, not ambiguous sessions. Reported, never rendered. */
  hidden: number;
  /** Newest activity across every shown run; null when nothing has any. */
  newest: number | null;
}

/**
 * Sessions ordered by ACTUAL recorded activity, with empty shells dropped.
 *
 * `runs.status` is not liveness (it never closes on a crash: 135 of 268 runs read 'active' on
 * a real ledger) and neither is `runs.updated` (written at create and close only). The single
 * honest signal is MAX(events.ts), and 87 of those 135 'active' runs had zero events at all —
 * filtering them removes most of the noise before any heuristic is applied.
 *
 * This deliberately returns an AGE, not a boolean. Events are written at turn boundaries, so
 * the resolution is turn-granular: 89% of inter-event gaps are under 10s and p95 is 34s, but a
 * session mid-way through one long model response can read minutes stale. A timestamp degrades
 * gracefully under that; a green "live" dot would simply be wrong.
 */
export function sessionList(runs: RunSummary[], now: number): SessionList {
  const shown = runs.filter((r) => r.events > 0);
  const rows: SessionRow[] = shown.map((r) => ({
    ...r,
    ageSeconds: r.last_event === null ? null : Math.max(0, now - r.last_event),
  }));
  const stamps = shown.map((r) => r.last_event).filter((t): t is number => t !== null);
  return {
    rows,
    hidden: runs.length - shown.length,
    newest: stamps.length > 0 ? Math.max(...stamps) : null,
  };
}

/* ──────────────────────────────── writes: recomputed attribution ───────────────────────────── */

/** How a step laid claim to a path. `path` is a real path match; `filename` is basename-only. */
export type ClaimRule = "path" | "filename";

export type ChangeVerdict = "on_plan" | "off_plan" | "unattributable";

export interface ChangeClass {
  change: FileChangeRow;
  verdict: ChangeVerdict;
  /** The step that claims this path — searched across ALL steps, not just the active one. */
  stepId: string | null;
  stepIdx: number | null;
  rule: ClaimRule | null;
  /**
   * The claiming step comes AFTER the step that was in progress when the write landed. This
   * recovers the one signal that matching against every step would otherwise hide: work done
   * out of order is not drift, but it is not nothing either.
   */
  workedAhead: boolean;
  /** Absolute path, when the run's project root is known. */
  absPath: string | null;
}

const normPath = (p: string): string => p.toLowerCase().replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * Every path suffix of at least two segments, longest first. `src/dashboard/queries.ts` yields
 * the full path, then `dashboard/queries.ts` — so a step naming any real portion of the path
 * counts, while a step that merely happens to contain a common basename does not.
 */
function pathSuffixes(path: string): string[] {
  const segs = normPath(path).split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i <= segs.length - 2; i++) out.push(segs.slice(i).join("/"));
  return out;
}

/**
 * Does this step's text lay claim to this path?
 *
 * Deliberately stricter than the harness's write-time `isPathClaimed`, which accepts a bare
 * basename anywhere in the text — under that rule a step saying "add the readonly option to
 * the DB layer" claims `minima_db.ts` only by accident, and a step mentioning `index.ts`
 * claims every index in the tree. A two-segment suffix is reported as a `path` claim and a
 * bare basename as the weaker `filename` claim, counted separately so the split is visible.
 */
export function claimRule(stepContent: string | null | undefined, path: string): ClaimRule | null {
  if (!stepContent || !path) return null;
  const hay = stepContent.toLowerCase().replace(/\\/g, "/");
  for (const suffix of pathSuffixes(path)) if (hay.includes(suffix)) return "path";
  const base = normPath(path).split("/").pop() ?? "";
  return base.length > 0 && hay.includes(base) ? "filename" : null;
}

/** Absolute path for a recorded write. Relative rows resolve against the run's project root. */
export function resolveChangePath(projectKey: string | null, path: string): string | null {
  if (!path) return null;
  if (path.startsWith("/")) return path;
  if (!projectKey) return null;
  return `${projectKey.replace(/\/+$/, "")}/${path.replace(/^\.?\//, "")}`;
}

/**
 * Recompute write attribution across the WHOLE plan.
 *
 * `file_changes.origin` is frozen at write time and computed against only the then-in-progress
 * step — and because that check short-circuits on a null step, 73 of 208 off-plan rows on a
 * real ledger were labelled without any comparison being evaluated at all. Matching every step
 * is the only way those rows get assessed even once. Rows whose path is opaque cannot be
 * assessed by any rule and stay a third state rather than being counted as drift.
 */
export function classifyChanges(
  steps: PlanStepRow[],
  changes: FileChangeRow[],
  projectKey: string | null,
): ChangeClass[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  return changes.map((change) => {
    const absPath = resolveChangePath(projectKey, change.path);
    if (change.origin === "unknown" || change.kind === "opaque") {
      return {
        change,
        verdict: "unattributable" as const,
        stepId: null,
        stepIdx: null,
        rule: null,
        workedAhead: false,
        absPath,
      };
    }
    // A `path` claim always beats a `filename` claim, whichever step it came from.
    let hit: { step: PlanStepRow; rule: ClaimRule } | null = null;
    for (const step of steps) {
      const rule = claimRule(step.content, change.path);
      if (!rule) continue;
      if (!hit || (hit.rule === "filename" && rule === "path")) hit = { step, rule };
      if (rule === "path") break;
    }
    if (!hit) {
      return {
        change,
        verdict: "off_plan" as const,
        stepId: null,
        stepIdx: null,
        rule: null,
        workedAhead: false,
        absPath,
      };
    }
    const atWrite = change.step_id ? byId.get(change.step_id) : undefined;
    return {
      change,
      verdict: "on_plan" as const,
      stepId: hit.step.id,
      stepIdx: hit.step.idx,
      rule: hit.rule,
      workedAhead: atWrite !== undefined && hit.step.idx > atWrite.idx,
      absPath,
    };
  });
}

/* ─────────────────────────────────── plans and their tasks ─────────────────────────────────── */

export interface TaskRow {
  stepId: string;
  idx: number;
  content: string;
  /** pending | in_progress | completed | unknown — the stored step status. */
  status: string;
  /** Derived through gateVerdictFor, never read off gates.confidence. */
  tier: string | null;
  tierReason: string | null;
  gateCount: number;
  /** The check command. Its OUTPUT is not captured anywhere in the ledger. */
  verify: string | null;
  verifyCwd: string | null;
  checkOrigin: string | null;
  /** A red baseline was captured, so a red→green transition can actually be proven. */
  hasBaseline: boolean;
  /** Latest gate's deterministic result, from factors_json. */
  pass: boolean | null;
  redToGreen: boolean | null;
  costUsd: number | null;
  claimed: ChangeClass[];
}

export interface PlanView {
  plan: PlanSummary;
  /** 1-based active step, mirroring big_plan.ts so the browser and /bp cannot disagree. */
  position: number;
  total: number;
  tasks: TaskRow[];
  offPlan: ChangeClass[];
  unattributable: ChangeClass[];
  workedAhead: ChangeClass[];
  onPlanStrong: number;
  onPlanWeak: number;
  /** Σ of step-attributed realized $, and the run-wide remainder no step can claim. */
  costUsd: number;
  unattributedUsd: number;
  gates: GateTiers;
  /** Steps with a check but no captured baseline — the honest test-evidence gap. */
  verifyWithoutBaseline: number;
  /** What the frozen column claimed, so the recompute's effect is visible, not asserted. */
  storedOffPlan: number;
}

const STATUSES = new Set(["pending", "in_progress", "completed"]);

/**
 * Active step position, mirroring `big_plan.ts` exactly: the first in-progress step, else the
 * first not-yet-completed one, else the last (all done reads "step N/N", never "step 0/N").
 */
export function planPosition(steps: PlanStepRow[]): number {
  if (steps.length === 0) return 0;
  const active = steps.findIndex((s) => s.status === "in_progress");
  if (active >= 0) return active + 1;
  const firstOpen = steps.findIndex((s) => s.status !== "completed");
  return firstOpen >= 0 ? firstOpen + 1 : steps.length;
}

/** The whole plan-detail projection: one pass over steps, gates, and reclassified writes. */
export function planView(detail: PlanDetail, gateTierRows = gateTiers): PlanView {
  const { plan, steps, gates, changes, stepCosts, runRoutedUsd } = detail;
  const classified = classifyChanges(steps, changes, plan.project_key);

  const gatesByStep = new Map<string, GateRow[]>();
  for (const gate of gates) {
    if (!gate.step_id) continue;
    const list = gatesByStep.get(gate.step_id) ?? [];
    list.push(gate);
    gatesByStep.set(gate.step_id, list);
  }
  const costByStep = new Map(stepCosts.map((c) => [c.step_id, c.cost_usd]));
  const claimedByStep = new Map<string, ChangeClass[]>();
  for (const c of classified) {
    if (!c.stepId) continue;
    const list = claimedByStep.get(c.stepId) ?? [];
    list.push(c);
    claimedByStep.set(c.stepId, list);
  }

  const tasks: TaskRow[] = steps.map((step) => {
    const stepGates = gatesByStep.get(step.id) ?? [];
    const latest = stepGates[stepGates.length - 1];
    const verdict = gateVerdictFor(latest);
    const factors = latest ? parseFactors(latest.factors_json) : null;
    const verify = step.verify?.trim() || null;
    return {
      stepId: step.id,
      idx: step.idx,
      content: step.content ?? "",
      status: STATUSES.has(step.status ?? "") ? (step.status as string) : "unknown",
      tier: verdict.tier ?? null,
      tierReason: verdict.tier ? verdict.reason : stepGates.length > 0 ? verdict.reason : null,
      gateCount: stepGates.length,
      verify,
      verifyCwd: step.verify_cwd,
      checkOrigin: step.check_origin,
      hasBaseline: step.baseline !== null,
      pass: factors ? factors.pass : null,
      redToGreen: factors ? (factors.redToGreen ?? null) : null,
      costUsd: costByStep.get(step.id) ?? null,
      claimed: claimedByStep.get(step.id) ?? [],
    };
  });

  const costUsd = stepCosts.reduce((sum, c) => sum + c.cost_usd, 0);
  return {
    plan,
    position: planPosition(steps),
    total: steps.length,
    tasks,
    offPlan: classified.filter((c) => c.verdict === "off_plan"),
    unattributable: classified.filter((c) => c.verdict === "unattributable"),
    workedAhead: classified.filter((c) => c.workedAhead),
    onPlanStrong: classified.filter((c) => c.verdict === "on_plan" && c.rule === "path").length,
    onPlanWeak: classified.filter((c) => c.verdict === "on_plan" && c.rule === "filename").length,
    costUsd,
    unattributedUsd: Math.max(0, runRoutedUsd - costUsd),
    gates: gateTierRows(gates),
    verifyWithoutBaseline: tasks.filter((t) => t.verify !== null && !t.hasBaseline).length,
    storedOffPlan: changes.filter((c) => c.origin === "off_plan").length,
  };
}

/* ─────────────────────────────────── charts that have a series ─────────────────────────────── */

/**
 * Fill missing days with zero.
 *
 * `spendByDay` GROUPs BY day, so a day with no decisions is simply absent — and an area chart
 * over absent days draws a straight line across them, which reads as "steady spend" when the
 * truth is "no spend". Zero-filling is the honest shape for a time series; the caller says so
 * in a note rather than leaving the reader to guess.
 */
export function gapFillDays(rows: DayRow[]): DayRow[] {
  if (rows.length < 2) return [...rows];
  const sorted = [...rows].sort((a, b) => a.day.localeCompare(b.day));
  const byDay = new Map(sorted.map((r) => [r.day, r]));
  const out: DayRow[] = [];
  const cursor = new Date(`${sorted[0]!.day}T00:00:00Z`);
  const last = new Date(`${sorted[sorted.length - 1]!.day}T00:00:00Z`);
  // Bounded by construction: the range is [first recorded day, last recorded day].
  while (cursor.getTime() <= last.getTime()) {
    const key = cursor.toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? { day: key, n: 0, cost_usd: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export interface PassRate {
  pass: number;
  fail: number;
  /** Gates carrying no parseable `pass` factor — excluded from the rate, never counted as fail. */
  unknown: number;
  rate: number | null;
}

/**
 * Deterministic step-check outcomes from `factors_json.pass`.
 *
 * This is the one gate series with real coverage: `pass` is populated on 146 of 146 step checks
 * on a real ledger (103 / 43 = 70.5%), even though `gates.confidence` is NULL on 143 of them.
 * Charting the raw column would say nothing; charting this says something true.
 *
 * A tier rate over TIME is deliberately not offered anywhere: 1 green in 177 graded gates makes
 * a trend line a flat zero that implies a precision the data does not have.
 */
export function stepCheckPassRate(rows: GateRow[]): PassRate {
  const out: PassRate = { pass: 0, fail: 0, unknown: 0, rate: null };
  for (const row of rows) {
    if (row.kind !== "step_check") continue;
    const factors = parseFactors(row.factors_json);
    if (!factors) out.unknown += 1;
    else if (factors.pass) out.pass += 1;
    else out.fail += 1;
  }
  const graded = out.pass + out.fail;
  out.rate = graded > 0 ? out.pass / graded : null;
  return out;
}
