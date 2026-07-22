/**
 * Preference probes (tuner) — numeric A/B tuning of the per-repo cost/quality slider.
 *
 * Hooked on the SAME plan-closed seam the zero-context diff reviewer uses: after a plan
 * closes fully completed, ask the user ONE bounded either/or question — keep the
 * profile's effective slider, or move it one hill-climb step (±TUNER_STEP, clamped to
 * [TUNER_SLIDER_MIN, TUNER_SLIDER_MAX]). Both options are summarized from REALIZED
 * ledger data (routing_decisions costs ⋈ deterministic-green gate labels — the
 * scoreboard's latest-gate semantics), never hypotheticals. Picking the candidate
 * nudges the profile via upsertRoutingProfile(source='tuner'); keeping current backs
 * the direction off (the next probe proposes the direction NOT rejected last time).
 * EVERY probe shown writes one `field='probe'` profile_events row — the cooldown
 * ledger — regardless of the answer (new_value = the chosen option, old_value = the
 * offered candidate).
 *
 * Opt-in (MINIMA_TUI_TUNER=1) and deliberately timid: every trigger gate fails open
 * and silent, at most one probe per session (in-memory latch), one bounded step per
 * probe, probes are never chained. The overlay arrives through an injected AskUserRef
 * (the stop-gate's dep pattern) — this module never imports the TUI.
 */

import type { MinimaDb, ProfileEventRow } from "../db/minima_db.ts";
import type { AskUserRef } from "../tools/question.ts";

export const TUNER_STEP = 1.5;
export const TUNER_SLIDER_MIN = 2;
export const TUNER_SLIDER_MAX = 8;
/** Reconciled decisions (non-null outcome) the project needs before any probe. */
export const TUNER_MIN_RECONCILED_DECISIONS = 8;
export const TUNER_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;
/** First-probe default: lean cheaper when the verified-green rate is at least this. */
export const TUNER_CHEAPER_GREEN_RATE = 0.8;

export type ProbeDirection = 1 | -1;

export type ProbeSkip =
  | "flag_off"
  | "no_profile"
  | "insufficient_decisions"
  | "session_latch"
  | "cooldown"
  | "no_overlay"
  | "no_candidate"
  | "error";

export type ProbeResult =
  | { probed: false; reason: ProbeSkip }
  | { probed: true; accepted: boolean; current: number; candidate: number };

/** Realized project-level trade-off stats backing both probe options. */
export interface TradeoffStats {
  /** Decisions with a non-null outcome — the "reconciled" trigger-gate count. */
  reconciled: number;
  /** Gate-labeled decisions (one label per decision: its latest gate). */
  labeled: number;
  /** Deterministic-green rate over labeled decisions (0 when none are labeled). */
  greenRate: number;
  medianCostUsd: number | null;
  /** Green rate / median cost over the cheaper half of labeled calls (by realized $). */
  cheapHalfGreenRate: number | null;
  cheapHalfMedianUsd: number | null;
  /** Green rate / median cost over the pricier half of labeled calls. */
  priceyHalfGreenRate: number | null;
  priceyHalfMedianUsd: number | null;
}

const RECONCILED_COUNT_SQL = `
  SELECT COUNT(*) AS n FROM routing_decisions
  WHERE run_id IN (SELECT run_id FROM runs WHERE project_key = ?)
    AND outcome IS NOT NULL`;

const LABELED_ROWS_SQL = `
  SELECT d.actual_cost_usd AS cost, g.confidence AS confidence, g.verified_by AS verified_by
  FROM routing_decisions d
  JOIN gates g ON g.rowid = (
    SELECT g2.rowid FROM gates g2 WHERE g2.rec_id = d.rec_id
    ORDER BY g2.created_at DESC, g2.rowid DESC LIMIT 1
  )
  WHERE d.run_id IN (SELECT run_id FROM runs WHERE project_key = ?)
  ORDER BY d.ts, d.rowid
  LIMIT 5000`;

interface LabeledRow {
  cost: number | null;
  confidence: string | null;
  verified_by: string | null;
}

const isGreen = (r: LabeledRow): boolean =>
  r.confidence === "green" && r.verified_by === "deterministic";

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Pure READ over the ledger — same latest-gate join as the task-type scoreboard. */
export function projectTradeoffStats(db: MinimaDb, projectKey: string): TradeoffStats {
  const reconciled = (db.db.query(RECONCILED_COUNT_SQL).get(projectKey) as { n: number }).n;
  const rows = db.db.query(LABELED_ROWS_SQL).all(projectKey) as LabeledRow[];
  const greens = rows.filter(isGreen).length;
  const priced = rows
    .filter((r): r is LabeledRow & { cost: number } => Number.isFinite(r.cost))
    .sort((a, b) => a.cost - b.cost);
  const mid = Math.floor(priced.length / 2);
  const cheap = priced.length >= 2 ? priced.slice(0, mid) : [];
  const pricey = priced.length >= 2 ? priced.slice(mid) : [];
  const rate = (half: LabeledRow[]): number | null =>
    half.length > 0 ? half.filter(isGreen).length / half.length : null;
  return {
    reconciled,
    labeled: rows.length,
    greenRate: rows.length > 0 ? greens / rows.length : 0,
    medianCostUsd: median(priced.map((r) => r.cost)),
    cheapHalfGreenRate: rate(cheap),
    cheapHalfMedianUsd: median(cheap.map((r) => r.cost as number)),
    priceyHalfGreenRate: rate(pricey),
    priceyHalfMedianUsd: median(pricey.map((r) => r.cost as number)),
  };
}

const num = (v: string | null): number | null => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Hill-climb direction memory, read from the probe ledger:
 *  - no prior probe → cheaper (-1) when the green rate clears TUNER_CHEAPER_GREEN_RATE,
 *    else quality (+1);
 *  - last probe kept current (chosen ≠ offered) → flip AWAY from the rejected offer;
 *  - last probe accepted (chosen = offered) → keep climbing the direction the paired
 *    source='tuner' slider event moved; unreadable history → the first-probe default.
 */
export function probeDirection(
  lastProbe: Pick<ProfileEventRow, "old_value" | "new_value"> | null,
  lastTunerSlider: Pick<ProfileEventRow, "old_value" | "new_value"> | null,
  greenRate: number,
): ProbeDirection {
  const fallback: ProbeDirection = greenRate >= TUNER_CHEAPER_GREEN_RATE ? -1 : 1;
  if (!lastProbe) return fallback;
  const offered = num(lastProbe.old_value);
  const chosen = num(lastProbe.new_value);
  if (offered === null || chosen === null) return fallback;
  if (chosen !== offered) return chosen > offered ? 1 : -1;
  const prev = lastTunerSlider ? num(lastTunerSlider.old_value) : null;
  const next = lastTunerSlider ? num(lastTunerSlider.new_value) : null;
  if (prev !== null && next !== null && next !== prev) return next > prev ? 1 : -1;
  return fallback;
}

/**
 * One bounded step from `current`, clamped to [TUNER_SLIDER_MIN, TUNER_SLIDER_MAX].
 * A step the clamp collapses back onto `current` (already at a bound) flips to the
 * other direction; null = no distinct candidate exists (degenerate range).
 */
export function boundedCandidate(current: number, direction: ProbeDirection): number | null {
  const clamp = (v: number): number => Math.min(TUNER_SLIDER_MAX, Math.max(TUNER_SLIDER_MIN, v));
  const primary = clamp(current + direction * TUNER_STEP);
  if (primary !== current) return primary;
  const flipped = clamp(current - direction * TUNER_STEP);
  return flipped !== current ? flipped : null;
}

const fmtUsd = (v: number | null): string => (v === null ? "$—" : `$${v.toFixed(4)}`);
const fmtPct = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 100)}%`);

function currentSummary(stats: TradeoffStats, current: number): string {
  return (
    `observed at slider ${current}: ${stats.reconciled} routed decisions · ` +
    `verified-green ${fmtPct(stats.labeled > 0 ? stats.greenRate : null)} · ` +
    `median ${fmtUsd(stats.medianCostUsd)}/call`
  );
}

function candidateSummary(stats: TradeoffStats, current: number, candidate: number): string {
  const cheaper = candidate < current;
  const half = cheaper
    ? { name: "cheaper half", green: stats.cheapHalfGreenRate, cost: stats.cheapHalfMedianUsd }
    : { name: "pricier half", green: stats.priceyHalfGreenRate, cost: stats.priceyHalfMedianUsd };
  return (
    `${cheaper ? "cost-leaning" : "quality-leaning"}, one bounded step; the ${half.name} ` +
    `of realized calls here ran verified-green ${fmtPct(half.green)} at median ${fmtUsd(half.cost)}/call`
  );
}

function lastProfileEvent(db: MinimaDb, projectKey: string, field: string): ProfileEventRow | null {
  return (
    (db.db
      .query(
        `SELECT * FROM profile_events WHERE project_key = ? AND field = ?
         ORDER BY ts DESC, id DESC LIMIT 1`,
      )
      .get(projectKey, field) as ProfileEventRow) ?? null
  );
}

function lastTunerSliderEvent(db: MinimaDb, projectKey: string): ProfileEventRow | null {
  return (
    (db.db
      .query(
        `SELECT * FROM profile_events WHERE project_key = ? AND field = 'slider' AND source = 'tuner'
         ORDER BY ts DESC, id DESC LIMIT 1`,
      )
      .get(projectKey) as ProfileEventRow) ?? null
  );
}

export interface PreferenceProbeDeps {
  db: MinimaDb;
  projectKey: string;
  /** config.tuner (MINIMA_TUI_TUNER=1, default off). */
  tuner: boolean;
  /** config.costQualityTradeoff — the effective slider when the profile row has none. */
  defaultSlider: number;
  /** Late-bound question overlay (the stop-gate's dep pattern); null current = headless, no probe. */
  askUser: AskUserRef;
  /** Injectable clock (epoch seconds) for tests. */
  now?: () => number;
}

/**
 * Build the per-session probe runner. Call it from the plan-closed seam; it evaluates
 * every trigger gate, shows at most ONE probe for the life of the returned function
 * (the in-memory session latch), and never throws.
 */
export function createPreferenceProbe(deps: PreferenceProbeDeps): () => Promise<ProbeResult> {
  let latched = false;
  return async (): Promise<ProbeResult> => {
    try {
      if (!deps.tuner) return { probed: false, reason: "flag_off" };
      const profile = deps.db.getRoutingProfile(deps.projectKey);
      if (!profile) return { probed: false, reason: "no_profile" };
      const stats = projectTradeoffStats(deps.db, deps.projectKey);
      if (stats.reconciled < TUNER_MIN_RECONCILED_DECISIONS)
        return { probed: false, reason: "insufficient_decisions" };
      if (latched) return { probed: false, reason: "session_latch" };
      const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
      const lastProbe = lastProfileEvent(deps.db, deps.projectKey, "probe");
      if (lastProbe && lastProbe.ts !== null && now - lastProbe.ts < TUNER_COOLDOWN_SECONDS)
        return { probed: false, reason: "cooldown" };
      const ask = deps.askUser.current;
      if (!ask) return { probed: false, reason: "no_overlay" };
      const current = profile.slider ?? deps.defaultSlider;
      const direction = probeDirection(
        lastProbe,
        lastTunerSliderEvent(deps.db, deps.projectKey),
        stats.greenRate,
      );
      const candidate = boundedCandidate(current, direction);
      if (candidate === null) return { probed: false, reason: "no_candidate" };
      latched = true;
      const keepLabel = `keep slider ${current}`;
      const tryLabel = `try slider ${candidate}`;
      const answer = await ask({
        question:
          "Tune routing for this repo? Pick the cost/quality trade-off the numbers " +
          "support — one bounded step, always reversible via /profile.",
        header: "routing tuner",
        options: [
          { label: keepLabel, description: currentSummary(stats, current) },
          { label: tryLabel, description: candidateSummary(stats, current, candidate) },
        ],
        allow_freetext: true,
      });
      const accepted = answer !== null && answer.trim() === tryLabel;
      if (accepted) deps.db.upsertRoutingProfile(deps.projectKey, { slider: candidate }, "tuner");
      deps.db.insertProfileEvent(
        deps.projectKey,
        "tuner",
        "probe",
        String(candidate),
        String(accepted ? candidate : current),
        now,
      );
      return { probed: true, accepted, current, candidate };
    } catch {
      return { probed: false, reason: "error" };
    }
  };
}
