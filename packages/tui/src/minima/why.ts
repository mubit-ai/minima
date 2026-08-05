import type { GateRow, MinimaDb } from "../db/minima_db.ts";
import { CHECK_ORIGINS } from "./big_plan_contract.ts";
import type { CheckOrigin, ConfidenceTier, Factors } from "./big_plan_contract.ts";
import { confidence } from "./confidence.ts";

const TIER_GLYPHS: Record<ConfidenceTier, string> = {
  green: "🟢",
  yellow: "🟡",
  red: "🔴",
};

/**
 * A gate reduced to what the UI needs: its recorded outcome, the confidence tier (stored, or
 * derived from `factors_json` when Track A hasn't stamped one yet), and a human reason. Shared
 * between `/why` and the M6.2 tier→behavior wiring so both read a gate identically.
 */
export interface GateVerdict {
  outcome: GateRow["outcome"];
  tier: ConfidenceTier | null;
  reason: string;
}

export function whyReportFor(
  db: MinimaDb | null,
  sessionId: string | null,
  sessionTotalUsd = 0,
): string {
  if (!db || !sessionId) return "No plan ledger available.";
  const plan = db.getLatestPlan(sessionId, { excludeCancelled: true });
  if (!plan) {
    const orphans = orphanLines(db, sessionId);
    return orphans.length > 0
      ? ["No plan recorded for this run.", ...orphans].join("\n")
      : "No plan recorded for this run.";
  }

  const steps = db.getPlanSteps(plan.id);
  const latestGateByStep = new Map<string, GateRow>();
  for (const gate of db.getGates(plan.id)) {
    if (gate.step_id) latestGateByStep.set(gate.step_id, gate);
  }

  const driftByStep = new Map<string, string[]>();
  const unattributedDrift: string[] = [];
  for (const change of db.getFileChanges(plan.id)) {
    if (change.origin !== "off_plan") continue;
    if (!change.step_id) {
      unattributedDrift.push(change.path);
      continue;
    }
    const paths = driftByStep.get(change.step_id) ?? [];
    paths.push(change.path);
    driftByStep.set(change.step_id, paths);
  }

  const lines = [`Plan verification - ${plan.title?.trim() || plan.id}`];
  if (steps.length === 0) lines.push("No plan steps recorded.");
  for (const step of steps) {
    const gate = latestGateByStep.get(step.id);
    const display = gateVerdictFor(gate);
    const icon = outcomeIcon(display.outcome);
    const verdict = display.tier
      ? `${TIER_GLYPHS[display.tier]} ${display.reason}`
      : display.reason;
    lines.push(`${icon} step ${step.idx + 1} ${verdict} - ${step.content ?? ""}`);
    lines.push(`  check: ${step.verify?.trim() || "(none)"}`);
    for (const path of driftByStep.get(step.id) ?? []) lines.push(`  ⚠ drift: ${path}`);
  }
  for (const path of unattributedDrift) lines.push(`⚠ drift: ${path} (unattributed)`);
  // J1: plan-level gates (closure milestones, the refutation pass) were previously
  // invisible here — they have no step_id, so the per-step map skips them.
  const planGates = db.getGates(plan.id).filter((gate) => !gate.step_id);
  if (planGates.length > 0) {
    lines.push("plan gates:");
    for (const gate of planGates) {
      lines.push(gateLine(gate));
      for (const reason of gateReasons(gate).slice(0, 5)) lines.push(`  - ${reason}`);
    }
  }
  // R8: the same three figures as the Plan Overview's Σ footer — the text path is the only
  // cost surface for plan-verification-off/narrow terminals. Omitted when every figure is 0.
  const stampedUsd = db.stepCosts(plan.id).totalUsd;
  const unattributedUsd = Math.max(0, db.runRoutedTotal(sessionId) - stampedUsd);
  if (stampedUsd > 0 || sessionTotalUsd > 0 || unattributedUsd > 0) {
    lines.push(`Σ $${stampedUsd.toFixed(4)} realized (stamped steps)`);
    lines.push(
      `session total $${sessionTotalUsd.toFixed(4)} · unattributed $${unattributedUsd.toFixed(4)}`,
    );
  }
  lines.push(...orphanLines(db, sessionId));
  return lines.join("\n");
}

/**
 * ✓ verified · ✗ a real check that failed/couldn't run · ○ everything else (unchecked step, or
 * no gate). `unchecked` is NOT a failure — a step that completed with no check must not read
 * as ✗, or every check-less plan looks like a wall of failures.
 */
function outcomeIcon(outcome: GateVerdict["outcome"]): string {
  if (outcome === "verified") return "✓";
  if (outcome === "failed" || outcome === "unrunnable") return "✗";
  return "○";
}

/** One gate as `/why` prints it — shared by the plan-level list and the per-commit list. */
function gateLine(gate: GateRow, indent = ""): string {
  const display = gateVerdictFor(gate);
  const tier = display.tier ? `${TIER_GLYPHS[display.tier]} ` : "";
  return `${indent}${outcomeIcon(display.outcome)} ${gate.kind ?? "milestone"} ${tier}${display.reason}`;
}

/**
 * F9b: is this `/why` argument a commit hash or a plan step index?
 *
 * Disambiguated by SHAPE, not by a new command — seven or more hex characters is a hash,
 * anything else is a step index. Seven is git's own abbreviation floor, and the rule is
 * deliberately stated in that order: "1234567" is both all-digits and valid hex, and it is
 * read as a hash, because no plan has a millionth step but every repo has short hashes.
 */
const SHA_ARG = /^[0-9a-f]{7,40}$/i;

export function isCommitArg(arg: string): boolean {
  return SHA_ARG.test(arg.trim());
}

/**
 * `/why <sha>` — which models wrote this commit, what it cost, and how its gates went.
 *
 * The commit end of the join lives in `commits`; the models, cost and verdicts are read
 * LIVE from routing_decisions and gates rather than from the row's snapshot, so feedback
 * that landed after the commit is reflected. Every unhappy path reports plainly: an unknown
 * hash, an ambiguous prefix, and a commit with no routed rungs are all answers, not errors.
 */
export function whyCommitReport(db: MinimaDb | null, shaArg: string, ledgerOn = true): string {
  const sha = shaArg.trim();
  if (!ledgerOn) {
    return `The commits ledger is OFF (MINIMA_TUI_COMMIT_LEDGER=0) — unset it to look commits up by hash.\nCommits still carry their Co-Authored-By and Minima-Run-Id trailers: git log ${sha}`;
  }
  if (!db) return "No commits ledger available.";

  const found = db.findCommitBySha(sha);
  if (found.kind === "unknown") {
    return `No ledger entry for commit ${sha}.\nOnly commits authored through git_commit or /commit while the ledger was on are recorded.`;
  }
  if (found.kind === "ambiguous") {
    const list = found.shas.map((s) => `  ${s.slice(0, 12)}`).join("\n");
    return `Ambiguous commit prefix ${sha} — ${found.shas.length} ledger entries match:\n${list}\nUse more characters.`;
  }

  const row = found.row;
  const short = row.sha.slice(0, 7);
  const claimed = db.commitRecIds(row.sha);
  const contributions = db.commitContributions(row.sha);
  const lines = [`Commit ${short} — run ${row.run_id}`];

  if (claimed.length === 0) {
    // A real, recorded commit that no routed rung produced: an unrouted session, or work done
    // before routing started. Saying so is the point — an empty card would read as a bug.
    lines.push(
      "No routed recommendations contributed to this commit — it was authored outside a routed turn, so there are no models, cost or gates to attribute.",
    );
    return lines.join("\n");
  }
  if (contributions.length === 0) {
    // The commit claimed rungs, but none has a decision row yet: a turn's row is written when
    // it ends, so a commit authored mid-turn is briefly ahead of its own evidence. Distinct
    // from the unrouted case above, and it resolves itself.
    lines.push(
      `${claimed.length} recommendation(s) contributed, but none has finished its turn yet — cost and gates land when the turn ends.`,
    );
    return lines.join("\n");
  }

  // Realized $ only, summed live over the contributing rungs. Estimates never masquerade as
  // spend, so a rung still awaiting feedback contributes 0 rather than its estimate.
  let totalUsd = 0;
  const perModel = new Map<string, { calls: number; usd: number }>();
  for (const c of contributions) {
    const usd = c.actual_cost_usd ?? 0;
    totalUsd += usd;
    const model = c.chosen_model ?? "(unrecorded)";
    const acc = perModel.get(model) ?? { calls: 0, usd: 0 };
    acc.calls += 1;
    acc.usd += usd;
    perModel.set(model, acc);
  }

  lines.push(`models (${perModel.size}):`);
  for (const [model, acc] of perModel) {
    lines.push(`  ${model} — ${acc.calls} call(s), $${acc.usd.toFixed(4)}`);
  }
  lines.push(`realized cost $${totalUsd.toFixed(4)} across ${contributions.length} call(s)`);

  const gates = db.commitGates(row.sha);
  if (gates.length === 0) {
    lines.push("gates: none recorded for these calls");
  } else {
    lines.push(`gates (${gates.length}):`);
    for (const gate of gates) lines.push(gateLine(gate, "  "));
  }
  return lines.join("\n");
}

/** Free-form reason bullets some gate writers store in factors (e.g. the refutation pass). */
function gateReasons(gate: GateRow): string[] {
  if (!gate.factors_json) return [];
  try {
    const raw = JSON.parse(gate.factors_json) as Record<string, unknown>;
    return Array.isArray(raw.reasons) ? raw.reasons.filter((r) => typeof r === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Blocked attempts written before any plan existed (plan_id NULL) are reachable only by
 * session — surfaced in /why so a pre-plan red is never invisible. Reporting only: the
 * feedback join stays rec_id-scoped.
 */
function orphanLines(db: MinimaDb, sessionId: string): string[] {
  const orphans = db.getSessionOrphanGates(sessionId);
  if (orphans.length === 0) return [];
  const lines = ["⚠ unattributed blocked attempts (no plan existed at the time):"];
  for (const gate of orphans) {
    lines.push(`  ✗ ${gate.outcome ?? "?"} - ${flipContentOf(gate) ?? "(unknown step)"}`);
  }
  return lines;
}

function flipContentOf(gate: GateRow): string | null {
  if (!gate.factors_json) return null;
  try {
    const raw = JSON.parse(gate.factors_json) as Record<string, unknown>;
    return typeof raw.flipContent === "string" && raw.flipContent.trim()
      ? raw.flipContent.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Reduce a gate row to a {@link GateVerdict}. Prefers the tier Track A stamped onto the row; when
 * that column is empty (older rows, or a gate written before the reasoner ran) it recomputes the
 * tier from `factors_json` so tier→behavior decisions never silently fall back to "no verdict".
 */
export function gateVerdictFor(gate: GateRow | undefined): GateVerdict {
  if (!gate) return { outcome: null, tier: null, reason: "not verified" };
  const factors = parseFactors(gate.factors_json);
  if (factors) {
    const derived = confidence(factors);
    return { outcome: gate.outcome, tier: gate.confidence ?? derived.tier, reason: derived.reason };
  }
  if (gate.outcome === "failed" || gate.outcome === "unrunnable") {
    return { outcome: gate.outcome, tier: gate.confidence ?? "red", reason: "check did not pass" };
  }
  return {
    outcome: gate.outcome,
    tier: gate.confidence,
    reason: gate.outcome === "verified" ? "verification recorded" : "no verdict recorded",
  };
}

/**
 * Parse and structurally validate a `factors_json` blob into {@link Factors}, returning null when
 * the column is empty or malformed. Exported so tier→behavior wiring validates gates identically
 * to `/why` rather than trusting an unchecked `JSON.parse`.
 */
export function parseFactors(raw: string | null): Factors | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const factors = value as Record<string, unknown>;
  if (
    typeof factors.pass !== "boolean" ||
    typeof factors.redToGreen !== "boolean" ||
    typeof factors.hasCheck !== "boolean" ||
    !isCheckOrigin(factors.checkOrigin) ||
    (typeof factors.coverageHit !== "boolean" && factors.coverageHit !== "unknown") ||
    typeof factors.tamper !== "boolean" ||
    (factors.blind !== undefined && typeof factors.blind !== "boolean")
  ) {
    return null;
  }
  return factors as unknown as Factors;
}

function isCheckOrigin(value: unknown): value is CheckOrigin {
  return typeof value === "string" && CHECK_ORIGINS.some((origin) => origin === value);
}
