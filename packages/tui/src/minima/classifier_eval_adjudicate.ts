/**
 * Override adjudication for the classifier evaluation (MUB-226).
 *
 * The harness classifier's only purpose is to OVERRIDE the service's task type — a caller-supplied
 * type beats the service's absolutely, so this classifier is not a second opinion sitting beside
 * the service's label, it is the mechanism for replacing it. Its standalone accuracy therefore
 * decides nothing. What decides whether to use it is how often it corrects a wrong service label
 * versus how often it breaks a right one, which is what this module counts.
 *
 * Four things meet on every scored row: the SERVICE's label, the harness classifier's REPLAYED
 * label, that classifier's SELF-REPORT, and the panel's REFERENCE label. From them:
 *
 *                  │ harness right          │ harness wrong
 *   ───────────────┼────────────────────────┼──────────────────────────
 *   service right  │ no-op                  │ HARM
 *   service wrong  │ CORRECTION (the point) │ both-wrong
 *
 * and a routing floor that follows from the data: the self-report threshold above which
 * corrections exceed breakages, reported as counts at every candidate rather than one number.
 *
 * Three seams this module deliberately does NOT own:
 *
 *   · The read-time consensus rule. ADR 0001 keeps the label cache as individual votes and derives
 *     consensus at read time, precisely so this adjudication can tell a unanimous panel from a 2-1
 *     split. Every consumer must go through that ONE function rather than writing its own quorum
 *     rule, so it arrives here as {@link ConsensusFn} — injected, never re-implemented.
 *   · The prompt hash. Rows are keyed on the sha256 of the exact prompt text and the text is never
 *     stored (ADR 0001). Nothing here ever sees prompt text, so this module is structurally
 *     incapable of leaking it.
 *   · The shipped routing floor. It is a required config field with no default: a mirrored constant
 *     is exactly how a stale 0.6 floor outlived the 0.75 the harness actually ships.
 *
 * This module is PURE: no filesystem, no ledger, no network, no clock — the same boundary as
 * `classifier_eval.ts` and `classifier_eval_correlate.ts`, and tested the same way. It never calls
 * a panel: reference labels arrive as cached vote rows, already paid for.
 */
import { type Rate, formatRate, rate } from "./classifier_eval.ts";
import type { Corroboration } from "./classifier_eval_correlate.ts";
import { TASK_TYPES, type TaskType } from "./schemas.ts";

// ---------------------------------------------------------------------------
// The reference side: cached votes, and somebody else's rule for reading them.
// ---------------------------------------------------------------------------

/**
 * One row of the consensus-label cache (ADR 0001): a single panel member's vote on a single
 * prompt. Rows are the unit because a stored verdict would discard the unanimous/split
 * distinction, and recovering it afterwards costs another paid run.
 */
export interface ReferenceVote {
  /** sha256 of the exact prompt text. The text itself never enters this module. */
  readonly promptHash: string;
  readonly modelId: string;
  /**
   * The label this panelist gave, or NULL when it answered with nothing usable as one.
   *
   * Nullable because the cache stores that case as a row (a deterministic non-answer, cached so a
   * rerun does not pay for it again). A non-nullable field here would force the caller to drop
   * those rows to satisfy the type, and a three-panelist panel with one dropped row arrives as two
   * agreeing votes — vacuously unanimous, and pseudo-gold manufactured out of a panelist that
   * never voted. Named `taskType`, like the producer's vote and the ledger's column: three names
   * for one field across a seam is how the seam drifted.
   */
  readonly taskType: TaskType | null;
  /** The corpus revision this vote was cast under. A different rev is a MISS, not a stale hit. */
  readonly corpusRev: string;
}

/**
 * What the read-time consensus function tells this module — MUB-216's `ConsensusVerdict`, narrowed
 * to the fields adjudication reads.
 *
 * Declared as a SUPERTYPE of the producer's union rather than adapted to it, so the shipped rule is
 * directly assignable and the seam carries no mapping code. A mapping is the only place an arm can
 * be dropped, and this type previously had nowhere to put one: `{label: TaskType | null}` collapsed
 * "the panel disagreed" and "the panel never finished" onto the same null.
 *
 * The arm names are 216's vocabulary, because structural assignability requires the same
 * discriminants. That is the rule's own naming, not this module's opinion about quorum (ADR 0001).
 */
export type ReferenceVerdict =
  | { readonly kind: "unanimous"; readonly label: TaskType }
  | { readonly kind: "split" }
  | { readonly kind: "incomplete" };

/**
 * The ONE read-time consensus rule, injected.
 *
 * Not a default, not an overridable strategy, and emphatically not a rule with a fallback here: a
 * second quorum rule is the drift ADR 0001 exists to prevent, so this module has none to fall back
 * to. Swapping the injected rule changes which rows are scorable at all — the paired test pins
 * that, and it is the whole reason consensus is derived at read time rather than stored.
 */
export type ConsensusFn = (votes: readonly ReferenceVote[]) => ReferenceVerdict;

// ---------------------------------------------------------------------------
// The candidate side: one corpus entry, with everything known about it.
// ---------------------------------------------------------------------------

/**
 * One decision the corpus entry's prompt drove, reduced to what adjudication reads.
 *
 * `corroboration` is MUB-225's verdict on the pairing that attached this decision to the prompt —
 * carried per decision because that is where it is measured, and collapsed to the entry below.
 */
export interface EntryDecision {
  readonly ts: number;
  /** The SERVICE's task type on this decision; null when the row carried none. */
  readonly serviceLabel: TaskType | null;
  readonly corroboration: Corroboration;
}

/**
 * One corpus entry offered for adjudication: every decision its prompt drove, plus what the replay
 * made of that prompt.
 *
 * The entry, not the decision, is the unit — the recovery ladder re-decides per rung, and three
 * rungs of one prompt are ONE observation of the classifier, not three (MUB-225). The replayed
 * label and self-report are per prompt for the same reason: the replay runs over the corpus.
 */
export interface OverrideCandidate {
  readonly promptHash: string;
  /** Every decision under this entry, in first-appearance order. The FIRST is the initial route. */
  readonly decisions: readonly EntryDecision[];
  /** The harness classifier's replayed label, or null when it declined (it fails open). */
  readonly harnessLabel: TaskType | null;
  /** The classifier's self-report in [0,1], or null when it declined. */
  readonly harnessSelfReport: number | null;
}

// ---------------------------------------------------------------------------
// Scored rows, and what cannot be scored.
// ---------------------------------------------------------------------------

/** Which label author produced the service label on a row. */
export type Regime = "before" | "after";

/** The four cells. `no-op` is reachable only when both labels are right, hence identical. */
export type Outcome = "correction" | "harm" | "no-op" | "both-wrong";

/**
 * One adjudicable observation: the four labels that decide the cell, plus the provenance every
 * figure derived from it inherits.
 */
export interface ScoredRow {
  readonly promptHash: string;
  /** The INITIAL route's service label — the one an override would have replaced. */
  readonly serviceLabel: TaskType;
  readonly harnessLabel: TaskType;
  readonly selfReport: number;
  readonly referenceLabel: TaskType;
  readonly regime: Regime;
  /** The entry's corroboration, collapsed from its pairings — see {@link entryCorroboration}. */
  readonly corroboration: Corroboration;
  /** The entry's rungs did not all carry the same service label. Scored on the initial route. */
  readonly serviceLabelVaried: boolean;
  /** Cached votes standing behind the reference label. */
  readonly panelVotes: number;
  /** Distinct labels among them: 1 is a unanimous panel, more is a split. Described, not decided. */
  readonly panelDistinctLabels: number;
}

/**
 * Why a candidate could not be adjudicated. Each is a different claim and they are never added up
 * into one "dropped" number:
 *
 *   · `no-service-label` — the initial route carried no task type (or there was no decision at
 *     all), so there is nothing for an override to have replaced.
 *   · `spans-regime-boundary` — the entry's decisions fall on both sides of the boundary, so its
 *     service labels have two different authors. Assigning such a row to one era is exactly the
 *     blending the segmentation exists to prevent.
 *
 *     Conservative, and deliberately so. The SCORED label comes from the initial route alone, so
 *     that one label does have a single author and the row could be segmented by its timestamp.
 *     But everything else the row carries — whether the rungs varied, whether the pairings
 *     corroborated — is aggregated across both eras, so a kept row would put two eras' provenance
 *     behind one era's outcome. The cost is a smaller `scored`, which is counted here rather than
 *     absorbed.
 *   · `no-replayed-label` — the replay produced no usable override: no label, or a label with no
 *     self-report, which cannot sit on a threshold sweep and so is the same non-answer.
 *   · `no-cached-label` — no vote rows for this prompt at this corpus rev. A cache MISS, including
 *     the case where votes exist at another rev; ADR 0001 makes a corpus redefinition a miss rather
 *     than a silent mis-attribution.
 *   · `panel-split` — every panelist labelled it and they disagreed. A fact about the PROMPT: it is
 *     genuinely hard, and no rule that requires agreement can give it a reference label.
 *   · `panel-incomplete` — fewer usable labels than the panel has members. A fact about the panel's
 *     COVERAGE, not about the prompt. Held apart from `panel-split` because one reason for both
 *     would put a missing panelist into the count a reader uses to judge how hard the corpus is —
 *     and two agreeing panelists out of three have not agreed.
 */
export type ExclusionReason =
  | "no-service-label"
  | "spans-regime-boundary"
  | "no-replayed-label"
  | "no-cached-label"
  | "panel-split"
  | "panel-incomplete";

/**
 * The order reasons are checked in, which is the order a candidate is walked through: does it name
 * one service label, does that label have one author, did the replay offer an override, is there a
 * reference to score against, did the panel agree. A candidate qualifying for several is counted
 * under the FIRST — so these counts partition the exclusions exactly, and `scored + excluded`
 * always equals the candidates offered.
 */
export const EXCLUSION_REASONS: readonly ExclusionReason[] = [
  "no-service-label",
  "spans-regime-boundary",
  "no-replayed-label",
  "no-cached-label",
  "panel-split",
  "panel-incomplete",
];

/** One candidate set aside, with the reason. Carried per row so nothing is silently dropped. */
export interface Exclusion {
  readonly promptHash: string;
  readonly reason: ExclusionReason;
}

/** What the adjudication is told to measure. */
export interface AdjudicationConfig {
  /** Descriptive only — it labels the readout. */
  readonly scope: string;
  /**
   * The instant the service's label author changed. Lower-inclusive: a decision at exactly this
   * timestamp is `after`, matching how the length strata cut.
   */
  readonly regimeBoundaryTs: number;
  /** The corpus revision whose votes count. Votes at any other rev are ABSENT, not stale-but-usable. */
  readonly corpusRev: string;
  /**
   * The routing floor the harness ships, so a derived floor is argued against the real baseline.
   *
   * NOT optional and NOT defaulted. Mirroring the constant here would put a second copy of a number
   * that has already moved once (0.6 → 0.75) in a file nothing keeps in sync, and a readout arguing
   * against a stale baseline is worse than one that refuses to run.
   */
  readonly currentFloor: number;
}

// ---------------------------------------------------------------------------
// Assembly.
// ---------------------------------------------------------------------------

/**
 * Collapse an entry's per-pairing corroboration to one state for the entry.
 *
 * Pessimistic on purpose, in the same direction MUB-225's mirroring is: ANY assessable pairing that
 * failed makes the entry uncorroborated, so the corroborated count can understate the correlation's
 * agreement but can never vouch for an entry it should not.
 *
 * `unassessable` is not a failure and never lands in either side of the rate — "nothing to compare"
 * is a different claim from "the comparison failed", and folding the two would inflate the failure
 * count with non-observations.
 */
export function entryCorroboration(decisions: readonly EntryDecision[]): Corroboration {
  const assessable = decisions.filter((d) => d.corroboration !== "unassessable");
  if (assessable.length === 0) return "unassessable";
  return assessable.every((d) => d.corroboration === "corroborated")
    ? "corroborated"
    : "uncorroborated";
}

/**
 * Which cell this row falls in. Both-right is `no-op` by construction: two labels that both equal
 * the reference are equal to each other, so the override changes nothing.
 */
export function outcomeOf(row: ScoredRow): Outcome {
  const serviceRight = row.serviceLabel === row.referenceLabel;
  const harnessRight = row.harnessLabel === row.referenceLabel;
  if (serviceRight) return harnessRight ? "no-op" : "harm";
  return harnessRight ? "correction" : "both-wrong";
}

/**
 * Turn candidates into scored rows, setting aside everything that cannot be adjudicated.
 *
 * Total over its input: every candidate lands in exactly one of the two lists. The consensus rule
 * is applied here and nowhere else, over the votes at the configured rev only.
 */
export function scoreCandidates(
  candidates: readonly OverrideCandidate[],
  votes: readonly ReferenceVote[],
  consensus: ConsensusFn,
  cfg: AdjudicationConfig,
): { rows: ScoredRow[]; excluded: Exclusion[] } {
  const byHash = new Map<string, ReferenceVote[]>();
  for (const v of votes) {
    if (v.corpusRev !== cfg.corpusRev) continue;
    const bucket = byHash.get(v.promptHash);
    if (bucket) bucket.push(v);
    else byHash.set(v.promptHash, [v]);
  }

  const rows: ScoredRow[] = [];
  const excluded: Exclusion[] = [];
  const setAside = (promptHash: string, reason: ExclusionReason): void => {
    excluded.push({ promptHash, reason });
  };

  for (const c of candidates) {
    const serviceLabel = c.decisions[0]?.serviceLabel ?? null;
    if (serviceLabel === null) {
      setAside(c.promptHash, "no-service-label");
      continue;
    }
    const regimes = new Set(
      c.decisions.map((d): Regime => (d.ts < cfg.regimeBoundaryTs ? "before" : "after")),
    );
    if (regimes.size > 1) {
      setAside(c.promptHash, "spans-regime-boundary");
      continue;
    }
    if (c.harnessLabel === null || c.harnessSelfReport === null) {
      setAside(c.promptHash, "no-replayed-label");
      continue;
    }
    const cached = byHash.get(c.promptHash);
    if (cached === undefined || cached.length === 0) {
      setAside(c.promptHash, "no-cached-label");
      continue;
    }
    // The rule's three arms land in three outcomes. No default branch: a fourth arm would be a
    // compile error here rather than silently joining whichever exclusion it fell past.
    const verdict = consensus(cached);
    if (verdict.kind === "split") {
      setAside(c.promptHash, "panel-split");
      continue;
    }
    if (verdict.kind === "incomplete") {
      setAside(c.promptHash, "panel-incomplete");
      continue;
    }
    const referenceLabel = verdict.label;
    // Votes that carried a label. A null vote is a paid, deterministic non-answer, so it is not
    // evidence standing behind the reference label and does not count toward it.
    const cachedLabels = cached.map((v) => v.taskType).filter((t): t is TaskType => t !== null);
    // Distinct labels among the rungs, ignoring rungs that carried none: a missing label is not a
    // different label, and counting it as one would report variation the service never produced.
    const rungLabels = new Set(
      c.decisions.map((d) => d.serviceLabel).filter((l): l is TaskType => l !== null),
    );
    rows.push({
      promptHash: c.promptHash,
      serviceLabel,
      harnessLabel: c.harnessLabel,
      selfReport: c.harnessSelfReport,
      referenceLabel,
      regime: [...regimes][0] as Regime,
      corroboration: entryCorroboration(c.decisions),
      serviceLabelVaried: rungLabels.size > 1,
      panelVotes: cachedLabels.length,
      panelDistinctLabels: new Set(cachedLabels).size,
    });
  }
  return { rows, excluded };
}

// ---------------------------------------------------------------------------
// Tabulation.
// ---------------------------------------------------------------------------

/**
 * How many rows fell in each cell, and the one comparison the decision turns on.
 *
 * The single place any population's cells are counted. Three readouts need these numbers over three
 * different populations — the whole tally, one sweep step, one service label — and counting them
 * three times is how two of them come to disagree. `net` is defined once, here.
 */
export interface OutcomeCounts {
  readonly rows: number;
  readonly corrections: number;
  readonly harms: number;
  readonly noOps: number;
  readonly bothWrong: number;
  /** Corrections minus harms. Positive means overriding paid for itself over this population. */
  readonly net: number;
}

/** Count the four cells over a population. */
export function countOutcomes(rows: readonly ScoredRow[]): OutcomeCounts {
  const n = (o: Outcome): number => rows.filter((r) => outcomeOf(r) === o).length;
  const corrections = n("correction");
  const harms = n("harm");
  return {
    rows: rows.length,
    corrections,
    harms,
    noOps: n("no-op"),
    bothWrong: n("both-wrong"),
    net: corrections - harms,
  };
}

/**
 * The four-way outcome over one population. Every cell shares one denominator, so the four rates
 * are readable against each other.
 */
export interface OutcomeTally extends OutcomeCounts {
  /** Override corrected a wrong service label — the whole point of having one. */
  readonly correctionShare: Rate;
  /** Override broke a right service label — the cell a floor exists to suppress. */
  readonly harmShare: Rate;
  /** Both right, so the labels agree and the override changes nothing. */
  readonly noOpShare: Rate;
  /** Both wrong. The override may still change the label, but not into a right one. */
  readonly bothWrongShare: Rate;
}

/** Put the four cells over their shared denominator. An empty population yields null percentages. */
export function tabulateOutcomes(rows: readonly ScoredRow[]): OutcomeTally {
  const c = countOutcomes(rows);
  return {
    ...c,
    correctionShare: rate(c.corrections, c.rows),
    harmShare: rate(c.harms, c.rows),
    noOpShare: rate(c.noOps, c.rows),
    bothWrongShare: rate(c.bothWrong, c.rows),
  };
}

/**
 * One candidate routing floor, with what it would have let through. `harms` is the ticket's
 * "breakages" — one word for the cell throughout, so `net` cannot be read as two different
 * subtractions in two different tables.
 */
export interface ThresholdPoint {
  readonly threshold: number;
  /** Rows the floor admits — self-report AT OR ABOVE it, the shipped gate's own comparison. */
  readonly overridden: number;
  readonly corrections: number;
  readonly harms: number;
  readonly net: number;
}

/**
 * Every floor worth asking about over a set of rows: the self-reports actually observed — the only
 * points at which the counts can change — plus the shipped floor, so the readout can be argued
 * against the real baseline even when no row sits exactly on it. A grid of round numbers would
 * instead quantize the answer to whatever step someone picked.
 *
 * Separate from the sweep so one candidate set can be shared across populations. It must be: a
 * segment sweep over only ITS OWN observed values would print rows the aggregate's sweep does not
 * have, and a reader comparing the two eras at a threshold would have to interpolate to do it.
 */
export function thresholdCandidates(rows: readonly ScoredRow[], currentFloor: number): number[] {
  return [...new Set([...rows.map((r) => r.selfReport), currentFloor])].sort((a, b) => a - b);
}

/**
 * Count what each candidate floor would have let through.
 *
 * A row below the threshold is not overridden, so it contributes to neither side: the harness's
 * gate drops a low-confidence label and the server's own heuristic applies unchanged. That is
 * `confidence >= floor` in `runtime.ts`, mirrored here as the comparison and not as the number.
 */
export function sweepThresholds(
  rows: readonly ScoredRow[],
  thresholds: readonly number[],
): ThresholdPoint[] {
  return [...thresholds].map((threshold) => {
    const admitted = rows.filter((r) => r.selfReport >= threshold);
    const c = countOutcomes(admitted);
    return {
      threshold,
      overridden: c.rows,
      corrections: c.corrections,
      harms: c.harms,
      net: c.net,
    };
  });
}

/**
 * Where a sweep says a floor is — two different questions, because they have different answers.
 *
 * `net` is NOT monotonic in the threshold: raising a floor drops corrections and harms alike, so
 * the net can cross positive, fall back and cross again. The ticket asks for "the threshold above
 * which corrections exceed breakages", and only `floor` answers that literally.
 */
export interface FloorVerdict {
  /**
   * The lowest candidate from which the net stays positive at EVERY stricter threshold — the floor
   * the ticket asks for. Null when no threshold has that property, which is a real answer: it says
   * the sweep has no stable crossing and the readout must be read as a curve.
   */
  readonly floor: number | null;
  /**
   * The lowest candidate that nets positive at all. Equal to `floor` when the crossing holds; below
   * it when the net dips back, which is exactly when quoting this number alone would mislead.
   */
  readonly lowestNetPositive: number | null;
}

/** Read both floors off a sweep. Total: an empty or all-negative sweep yields two nulls. */
export function deriveFloor(sweep: readonly ThresholdPoint[]): FloorVerdict {
  const stable = sweep.find((_, i) => sweep.slice(i).every((q) => q.net > 0));
  const crossing = sweep.find((p) => p.net > 0);
  return {
    floor: stable === undefined ? null : stable.threshold,
    lowestNetPositive: crossing === undefined ? null : crossing.threshold,
  };
}

/**
 * Support below which a share is withheld rather than printed. This corpus is a few hundred prompts
 * of one developer's traffic, so its long tail has single-digit support for several task types and
 * a percentage over four rows is the most likely way this readout misleads.
 */
export const MIN_REPORTABLE_SUPPORT = 10;

/** How the override fared on the rows the service gave one label. */
export interface ServiceLabelBreakdown {
  /** The SERVICE's label — the bucket a routing rule could actually condition on. */
  readonly taskType: TaskType;
  readonly support: number;
  readonly corrections: number;
  readonly harms: number;
  readonly net: number;
  /** null when support is single-digit: the share is WITHHELD, not zero. */
  readonly correctionShare: Rate | null;
  /** null when support is single-digit, for the same reason. */
  readonly harmShare: Rate | null;
}

/**
 * Break the outcome down by the SERVICE's label rather than the reference label.
 *
 * That is the actionable grouping: at routing time the reference label is unknown and the service's
 * is in hand, so "override only when the service says X" is a rule that can be written, while
 * "override only when the task really is X" is not. It is also where the motivating observation
 * lives — the catch-all bucket is the service's output, not this classifier's.
 *
 * Rows are in `TASK_TYPES` order, filtered to the labels actually observed: a fixed vocabulary
 * order keeps the table stable across runs, and re-deriving an order by support would move rows
 * between runs for no reason.
 */
export function breakdownByServiceLabel(rows: readonly ScoredRow[]): ServiceLabelBreakdown[] {
  return TASK_TYPES.filter((t) => rows.some((r) => r.serviceLabel === t)).map((taskType) => {
    const c = countOutcomes(rows.filter((r) => r.serviceLabel === taskType));
    const reportable = c.rows >= MIN_REPORTABLE_SUPPORT;
    return {
      taskType,
      support: c.rows,
      corrections: c.corrections,
      harms: c.harms,
      net: c.net,
      correctionShare: reportable ? rate(c.corrections, c.rows) : null,
      harmShare: reportable ? rate(c.harms, c.rows) : null,
    };
  });
}

/** Everything adjudicated over one population — the whole corpus, or one side of the boundary. */
export interface Adjudication extends FloorVerdict {
  readonly outcomes: OutcomeTally;
  readonly sweep: readonly ThresholdPoint[];
  readonly byServiceLabel: readonly ServiceLabelBreakdown[];
}

function adjudicate(rows: readonly ScoredRow[], thresholds: readonly number[]): Adjudication {
  const sweep = sweepThresholds(rows, thresholds);
  return {
    outcomes: tabulateOutcomes(rows),
    sweep,
    ...deriveFloor(sweep),
    byServiceLabel: breakdownByServiceLabel(rows),
  };
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

/** How many candidates one exclusion reason accounted for. */
export interface ExclusionCount {
  readonly reason: ExclusionReason;
  readonly count: number;
}

/**
 * One outcome count reported over all three populations at once.
 *
 * Every count whose meaning depends on the SERVICE's label has to come segmented, because the label
 * author changed partway through and an aggregate over both is a figure describing no state the
 * system was ever in. Bundling the three makes that structural: there is no way to compute the
 * whole-corpus number here without computing the two eras beside it.
 */
export interface SegmentedTally {
  readonly aggregate: OutcomeTally;
  readonly before: OutcomeTally;
  readonly after: OutcomeTally;
}

function segmentedTally(rows: readonly ScoredRow[]): SegmentedTally {
  return {
    aggregate: tabulateOutcomes(rows),
    before: tabulateOutcomes(rows.filter((r) => r.regime === "before")),
    after: tabulateOutcomes(rows.filter((r) => r.regime === "after")),
  };
}

/**
 * Every number the adjudication reports. Each rate is a {@link Rate}, so no figure here can be
 * quoted without its denominator — and the aggregate never appears without both segments beside it,
 * because a figure blending two label authors describes no state the system was ever in.
 */
export interface AdjudicationReport {
  readonly scope: string;
  readonly corpusRev: string;
  readonly currentFloor: number;
  /** Corpus entries offered for adjudication, before anything was set aside. */
  readonly candidates: number;
  readonly scored: number;
  /** Every reason, in the order they are checked, including the ones that accounted for nothing. */
  readonly excluded: readonly ExclusionCount[];
  readonly excludedTotal: number;
  readonly aggregate: Adjudication;
  readonly before: Adjudication;
  readonly after: Adjudication;
  /** Scored rows the display label backs up, over the rows where it could be checked at all. */
  readonly corroborated: Rate;
  /** Scored rows the label contradicts. A prompt rewritten before dispatch fails this without
   * being mis-paired, so these are reported, never discarded. */
  readonly uncorroborated: number;
  /** Scored rows with nothing to compare — neither side of the rate above. */
  readonly corroborationUnassessable: number;
  /** The outcome over corroborated rows only: how much of the result rests on the weaker pairings. */
  readonly corroboratedOnly: SegmentedTally;
  /** Scored rows whose reference label every cached vote agreed on, over all scored rows. */
  readonly panelUnanimous: Rate;
  /** The outcome over those rows only: how much of the result rests on a split panel. */
  readonly unanimousPanelOnly: SegmentedTally;
  /**
   * Scored rows whose reference label rests on ONE cached vote. Vacuously unanimous — a single
   * model's opinion, not a panel that agreed — so the unanimity figures above are only as strong as
   * this number is small. Counted rather than folded into the definition, which would silently
   * redefine what the injected consensus rule already decided.
   */
  readonly singleVoteRows: number;
  /** Rows scored on the initial route because the entry's rungs disagreed on the service label. */
  readonly serviceLabelVariedRows: number;
}

/**
 * Assemble the whole adjudication readout.
 *
 * Pure: reads nothing, spends nothing, and calls no panel — reference labels arrive as cached vote
 * rows that a paid run already produced.
 */
export function buildAdjudicationReport(
  candidates: readonly OverrideCandidate[],
  votes: readonly ReferenceVote[],
  consensus: ConsensusFn,
  cfg: AdjudicationConfig,
): AdjudicationReport {
  const { rows, excluded } = scoreCandidates(candidates, votes, consensus, cfg);
  const assessable = rows.filter((r) => r.corroboration !== "unassessable");
  const unanimous = rows.filter((r) => r.panelDistinctLabels === 1);
  // One candidate set for all three populations, taken from every scored row, so the segment sweeps
  // print the same thresholds as the aggregate's and can be read across.
  const thresholds = thresholdCandidates(rows, cfg.currentFloor);
  return {
    scope: cfg.scope,
    corpusRev: cfg.corpusRev,
    currentFloor: cfg.currentFloor,
    candidates: candidates.length,
    scored: rows.length,
    excluded: EXCLUSION_REASONS.map((reason) => ({
      reason,
      count: excluded.filter((e) => e.reason === reason).length,
    })),
    excludedTotal: excluded.length,
    aggregate: adjudicate(rows, thresholds),
    before: adjudicate(
      rows.filter((r) => r.regime === "before"),
      thresholds,
    ),
    after: adjudicate(
      rows.filter((r) => r.regime === "after"),
      thresholds,
    ),
    corroborated: rate(
      rows.filter((r) => r.corroboration === "corroborated").length,
      assessable.length,
    ),
    uncorroborated: rows.filter((r) => r.corroboration === "uncorroborated").length,
    corroborationUnassessable: rows.length - assessable.length,
    corroboratedOnly: segmentedTally(rows.filter((r) => r.corroboration === "corroborated")),
    panelUnanimous: rate(unanimous.length, rows.length),
    unanimousPanelOnly: segmentedTally(unanimous),
    singleVoteRows: rows.filter((r) => r.panelVotes === 1).length,
    serviceLabelVariedRows: rows.filter((r) => r.serviceLabelVaried).length,
  };
}

/** A signed count, so a net of zero is visibly zero and a negative one cannot be misread. */
function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

/** Human wording for an exclusion reason. Keyed by the enum, so a new reason cannot go unworded. */
const EXCLUSION_WORDING: Record<ExclusionReason, string> = {
  "no-service-label": "no service label on the initial route",
  "spans-regime-boundary": "decisions span the regime boundary",
  "no-replayed-label": "replay gave no usable label",
  "no-cached-label": "no cached label at this corpus rev",
  "panel-split": "panel labelled it and disagreed",
  "panel-incomplete": "panel incomplete — a panelist produced no label",
};

/**
 * Render the report as plain text — counts and denominators ONLY. No prompt text, no prompt hash,
 * no display label: the corpus is one developer's own traffic, so this readout is safe to paste
 * anywhere.
 *
 * Lives in the pure core alongside the counting so the shell cannot reformat a number on its way
 * out, and so the caveats travel with every figure rather than being remembered by whoever quotes
 * one. The aggregate column is never printed without both segments beside it.
 */
export function renderAdjudicationReport(r: AdjudicationReport): string {
  const col = (s: string): string => s.padEnd(21);
  const head = `  ${"".padEnd(30)}${col("aggregate")}${col("before the boundary")}after the boundary`;
  // The three populations, named once. Every segmented block below walks this same list, so the
  // aggregate is structurally incapable of being printed without both eras beside it.
  const populations: readonly [string, Adjudication][] = [
    ["aggregate", r.aggregate],
    ["before the boundary", r.before],
    ["after the boundary", r.after],
  ];
  /** One row of a three-column block. The tuple is what forbids printing fewer than three. */
  const across = <T>(label: string, of: (p: T) => string, ps: readonly [T, T, T]): string =>
    `  ${label.padEnd(30)}${col(of(ps[0]))}${col(of(ps[1]))}${of(ps[2])}`;
  const cells: readonly [string, (a: Adjudication) => string][] = [
    ["override CORRECTS (the point)", (a) => formatRate(a.outcomes.correctionShare)],
    ["override HARMS", (a) => formatRate(a.outcomes.harmShare)],
    ["override is a no-op", (a) => formatRate(a.outcomes.noOpShare)],
    ["both wrong", (a) => formatRate(a.outcomes.bothWrongShare)],
    ["net (corrections − harms)", (a) => signed(a.outcomes.net)],
  ];

  const lines: string[] = [
    "Classifier eval — override adjudication (would overriding the service's label have helped?)",
    `scope: ${r.scope} · corpus rev ${r.corpusRev} · shipped floor ${r.currentFloor}`,
    "",
    "Population",
    `  corpus entries offered       ${r.candidates}`,
    `  scored                       ${r.scored}`,
    `  set aside                    ${r.excludedTotal}`,
  ];
  for (const e of r.excluded) {
    lines.push(`    ${EXCLUSION_WORDING[e.reason].padEnd(38)} ${e.count}`);
  }
  const adjudications: readonly [Adjudication, Adjudication, Adjudication] = [
    r.aggregate,
    r.before,
    r.after,
  ];
  lines.push("", "Four-way outcome", head);
  for (const [label, cell] of cells) {
    lines.push(across(label, cell, adjudications));
  }

  for (const [name, a] of populations) {
    lines.push(
      "",
      `Self-report sweep — ${name} (a row is overridden at or above the threshold)`,
      `  ${"threshold".padEnd(12)}${"overridden".padEnd(12)}${"corrects".padEnd(12)}${"harms".padEnd(12)}net`,
    );
    for (const p of a.sweep) {
      const mark = p.threshold === r.currentFloor ? "  ← shipped floor" : "";
      lines.push(
        (
          `  ${p.threshold.toFixed(2).padEnd(12)}${String(p.overridden).padEnd(12)}` +
          `${String(p.corrections).padEnd(12)}${String(p.harms).padEnd(12)}` +
          `${signed(p.net).padEnd(6)}${mark}`
        ).trimEnd(),
      );
    }
    const noFloor =
      a.lowestNetPositive === null
        ? "no threshold nets positive at all"
        : `the net first crosses positive at ${a.lowestNetPositive.toFixed(2)} and then falls back, so read the sweep rather than quoting a floor`;
    lines.push(
      a.floor === null
        ? `  derived floor: NONE — no threshold keeps corrections above harms at every stricter one; ${noFloor}`
        : `  derived floor: ${a.floor.toFixed(2)} — corrections exceed harms there and at every stricter threshold`,
    );
  }

  for (const [name, a] of populations) {
    lines.push("", `By the SERVICE's label — ${name} (the bucket a routing rule can condition on)`);
    if (a.byServiceLabel.length === 0) lines.push("  no rows");
    for (const b of a.byServiceLabel) {
      const share =
        b.correctionShare === null
          ? `unreportable (support ${b.support} is single-digit)`
          : `corrects ${formatRate(b.correctionShare)} · harms ${formatRate(b.harmShare as Rate)}`;
      lines.push(
        `  ${b.taskType.padEnd(16)}${`n=${b.support}`.padEnd(8)}` +
          `${`+${b.corrections}/-${b.harms}`.padEnd(10)}${signed(b.net).padEnd(6)}${share}`,
      );
    }
  }

  // Sensitivity: drop the rows whose provenance is weaker and see whether the answer moves. These
  // are outcome counts, so they come segmented too — a corroborated-only net over both eras would
  // be the same blended figure the four-way table is forbidden to print alone.
  // `unanimousPanelOnly` is deliberately NOT a row here. Under the rule MUB-216 ships, unanimity is
  // the admission criterion, so that subset is every scored row and the line would restate the one
  // above it. It stays computed: a looser injected rule makes the two diverge, and the arithmetic —
  // not a remembered caveat — is what would notice.
  const subsets: readonly [string, SegmentedTally][] = [
    [
      "all scored rows",
      { aggregate: r.aggregate.outcomes, before: r.before.outcomes, after: r.after.outcomes },
    ],
    ["corroborated rows only", r.corroboratedOnly],
  ];
  lines.push("", "What the result rests on (rows · net)", head);
  for (const [label, t] of subsets) {
    lines.push(
      across(label, (o: OutcomeTally) => `${o.rows} · ${signed(o.net)}`, [
        t.aggregate,
        t.before,
        t.after,
      ]),
    );
  }
  lines.push(
    `  corroborated pairings        ${formatRate(r.corroborated)}` +
      ` · uncorroborated ${r.uncorroborated} · nothing to compare ${r.corroborationUnassessable}`,
    `  rows resting on ONE cached vote (vacuously unanimous): ${r.singleVoteRows}`,
    `  scored on the initial route because the ladder's rungs disagreed: ${r.serviceLabelVariedRows}`,
  );

  // The adjudication's limits travel with the report, not alongside it — a figure quoted out of
  // this readout should carry the reasons it is not a general claim.
  lines.push(
    "",
    "What these figures are, which travels with every one of them:",
    "  · Every row here rests on the prompt↔decision correlation, which is a HEURISTIC with a",
    "    measured error rate, not a key. This adjudication inherits that error rate in full: the",
    "    corroborated-only line above is how much of the result depends on the weaker pairings.",
    "  · Reference labels were read from the consensus-label CACHE, not produced here. No panel was",
    "    invoked and nothing in this readout spent anything. Votes at another corpus revision were",
    "    treated as absent, so a redefined corpus is a miss rather than a mis-attribution.",
    "  · The consensus rule is injected, not owned here. A different quorum rule over the same",
    "    cached votes scores a different set of rows — which is why the cache stores votes. Under",
    "    the rule that ships, unanimity is the admission criterion: every scored row's panel agreed,",
    "    so a 'unanimous only' sensitivity would be every row and is not printed.",
    "  · A panel that DISAGREED and a panel that never finished are set aside under different",
    "    reasons above. One is a fact about the prompt, the other about the panel's coverage, and a",
    "    single count for both would put a missing panelist into how hard this corpus looks.",
    "  · The service label is an INPUT being scored. This readout makes no recommendation about",
    "    which service-side classifier should produce it.",
    "  · The aggregate spans two label authors. It is printed only beside both segments, and a",
    "    figure quoted from it alone describes no state the system was ever in.",
    "  · One prompt's recovery-ladder rungs are ONE observation. A row is scored on the initial",
    "    route — the label an override would have replaced — and rungs that disagreed are counted",
    "    above rather than averaged away.",
    "  · The floor is derived, not recommended. `net` is not monotonic in the threshold, so the",
    "    sweep is the artifact and a different risk posture can pick a different row of it.",
    "  · One developer's traffic, a few hundred prompts. Task types below the reportable support",
    "    are marked unreportable and show counts only.",
  );
  return lines.join("\n");
}
