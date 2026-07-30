/**
 * Classifier replay scoring and routing-floor derivation (MUB-218).
 *
 * The replay itself is impure — it calls two classifier models over the corpus. Everything it
 * PRODUCES is scored here: accuracy against the reference panel, the catch-all's emission and
 * agreement, the reliability curve, and the floor derived from that curve. Same boundary as
 * `classifier_eval.ts` and `classifier_eval_correlate.ts`: no filesystem, no ledger, no network,
 * no clock, and no billable call.
 *
 * Two seams are INJECTED rather than implemented here, both on purpose:
 *
 *   · **The read-time consensus rule.** ADR 0001 makes it one function every consumer goes
 *     through, so a quorum rule cannot drift between the tickets that read the same votes. It
 *     arrives as `(votes) => PanelVerdict` and MUB-216 owns it. There is deliberately no fallback
 *     here: a missing consensus rule must be a compile error, not a second rule. The verdict type
 *     is a supertype of the producer's, so the rule needs no adapter — see {@link PanelVerdict}.
 *   · **The prompt hash.** The cache is keyed on the sha256 of the exact prompt text and the text
 *     is never stored, so the hash is the only way back from a corpus entry to its votes. Two
 *     implementations that ever disagreed would produce a total cache miss and report it as "the
 *     panel has not labelled this corpus" — a defect wearing a finding's clothes.
 *
 * What this module refuses to do, because the ticket's whole argument rests on it:
 *
 *   · **No stored label can become the reference.** The only channel for a reference label is a
 *     verdict the injected rule derived from votes. There is no input here a historical
 *     `task_type` could be passed through, so the constraint is structural rather than remembered.
 *   · **No rate stands alone at the corpus level.** Every figure is a {@link Segmented} four-up:
 *     the two regimes, the entries that straddle them, and only then the whole.
 *   · **No percentage over single-digit support — for EVERY reported rate.** {@link Supported}
 *     carries the verdict on its own denominator and the renderer suppresses the percentage,
 *     rather than a reader remembering to. Exclusions and coverage are held to the same bar as
 *     accuracy, and deliberately: "it abstained on a fifth of the corpus" generalises exactly as
 *     far as "it was right on four fifths" does, and a readout where some percentages are
 *     suppressed and others are not teaches a reader that a printed percentage means nothing in
 *     particular.
 */
import type { UserPromptRow } from "../db/minima_db.ts";
import {
  type DistinctPrompt,
  type Rate,
  cutPoints,
  distinctPrompts,
  formatRate,
  partitionLeadPrompts,
  partitionSteerText,
  rate,
} from "./classifier_eval.ts";
import { CLASSIFY_CONFIDENCE_FLOOR, type TaskClassification } from "./classify.ts";
import { TASK_TYPES, type TaskType } from "./schemas.ts";

// ---------------------------------------------------------------------------
// The reference panel: vote rows in, one verdict per corpus entry out.
// ---------------------------------------------------------------------------

/**
 * The only two columns of a cached vote this module reads. MUB-216's row is richer — the model
 * that voted, the label it gave — and passes through untouched to the consensus rule, which is the
 * only thing entitled to interpret it. Structural typing means its row satisfies this without
 * either side importing the other.
 *
 * `corpusRev` is a STRING: the eval core's `CORPUS_REV` is one (`r2-observer-steer`) and so is the
 * ledger column. It was typed `number` here while no wiring existed to disagree with, which is the
 * shape of every defect a lane cannot see from inside itself.
 */
export interface CachedVote {
  readonly promptHash: string;
  readonly corpusRev: string;
}

/**
 * What the injected rule says about one prompt's votes — MUB-216's `ConsensusVerdict`, narrowed to
 * the fields this module reads.
 *
 * Declared as a SUPERTYPE of the producer's union rather than adapted to it, so `deriveConsensus`
 * is directly assignable and the seam carries no mapping code. That is the point: a mapping is the
 * only place an arm can be dropped, and dropping `incomplete` into `split` is how a coverage gap
 * gets reported as a disagreement rate. The arm names are 216's vocabulary because assignability
 * requires the same discriminants — the quorum rule is its, not this module's (ADR 0001).
 *
 * Three arms, three claims, and they are never added together:
 *
 *   · `unanimous` — a reference label. The only arm that produces one.
 *   · `split` — the panel labelled the prompt and disagreed. A fact about the PROMPT.
 *   · `incomplete` — fewer usable labels than panelists. A fact about the PANEL's coverage. Two
 *     agreeing panelists out of three have not agreed unanimously, and calling that a split would
 *     charge the prompt for a panelist that never voted.
 */
export type PanelVerdict =
  | { readonly kind: "unanimous"; readonly label: TaskType; readonly votes: number }
  | { readonly kind: "split"; readonly votes: number }
  | { readonly kind: "incomplete"; readonly votes: number; readonly panelSize: number };

/**
 * The panel's answer for one prompt, once a verdict has produced a label.
 *
 * `votesFor`/`votesTotal` are here because ADR 0001's reason for storing individual votes was that
 * a unanimous panel and a 2-1 split must stay distinguishable. Under the quorum rule MUB-216
 * ships they are always EQUAL — unanimity is the admission criterion, so nothing weaker reaches
 * here — and `correctUnanimousOnly` below is therefore identical to `correct`. Both are kept
 * rather than removed: a future quorum rule that admitted a majority would make them diverge, and
 * the arithmetic is what would notice. Neither is rendered, because a printed row naming a
 * population identical to the row above it teaches a reader that the distinction is live.
 */
export interface ReferenceVerdict {
  readonly taskType: TaskType;
  readonly votesFor: number;
  readonly votesTotal: number;
}

/** Was the panel of one mind? Trivially true for a single voter, which is why support is reported. */
export function isUnanimous(v: ReferenceVerdict): boolean {
  return v.votesTotal > 0 && v.votesFor === v.votesTotal;
}

/** How to resolve a corpus entry's votes into a verdict, and how to find them in the first place. */
export interface ReferenceLookup<V extends CachedVote> {
  /**
   * Votes at any other revision are absent, not stale-but-usable (ADR 0001).
   *
   * Supplied by the caller because ADR 0001 sources it from the eval core's `CORPUS_REV`. A caller
   * that passes the wrong one gets a total cache miss, but not a silent one: it lands in
   * `votesAtOtherRev` with `entriesUnvoted` equal to the corpus, and the readout prints both side
   * by side.
   */
  readonly corpusRev: string;
  /** MUB-216's key producer. Injected so there is exactly one hash in play, never two. */
  readonly hashOf: (text: string) => string;
  /** MUB-216's read-time consensus rule. Never re-implemented here, not even as a fallback. */
  readonly consensus: (votes: readonly V[]) => PanelVerdict;
}

/**
 * What the join found. The three entry counts partition the corpus, and the two vote counts are
 * reported separately from them because they answer a different question — one is "how much of my
 * corpus is scoreable", the other is "how much of the cache is spent on prompts I no longer hold".
 */
export interface ReferenceResolution {
  /** Corpus entry text → the panel's verdict. Only entries the rule actually resolved. */
  readonly verdicts: ReadonlyMap<string, ReferenceVerdict>;
  readonly entriesResolved: number;
  /** Entries with no vote at this revision — a gap in the cache, not a panel that disagreed. */
  readonly entriesUnvoted: number;
  /** Entries the panel labelled and disagreed on. A fact about the prompt: it is genuinely hard. */
  readonly entriesPanelSplit: number;
  /**
   * Entries where fewer panelists produced a usable label than the panel has members. A fact about
   * the panel's COVERAGE, never about the prompt — reported apart from `entriesPanelSplit` because
   * one number over both would let a missing panelist read as models disagreeing.
   */
  readonly entriesPanelIncomplete: number;
  /** Votes discarded because they describe a different corpus revision. */
  readonly votesAtOtherRev: number;
  /**
   * Votes at this revision whose prompt is not in the live corpus. The hash is one-way, so these
   * are unreadable by construction — countable, never recoverable as text (ADR 0001's consequence).
   */
  readonly votesWithoutCorpusEntry: number;
}

/**
 * Join corpus entries to their cached votes and resolve each panel through the injected rule.
 *
 * The join direction matters: entries drive it, so a prompt with no votes is a visible gap rather
 * than a silently smaller denominator. Votes that match no entry are counted from the other side,
 * because the cache outliving its corpus is the failure mode ADR 0001 accepted and nothing else
 * would notice it.
 */
export function resolveReferenceVerdicts<V extends CachedVote>(
  entries: readonly string[],
  votes: readonly V[],
  lookup: ReferenceLookup<V>,
): ReferenceResolution {
  const byHash = new Map<string, V[]>();
  let votesAtOtherRev = 0;
  for (const v of votes) {
    if (v.corpusRev !== lookup.corpusRev) {
      votesAtOtherRev += 1;
      continue;
    }
    const bucket = byHash.get(v.promptHash);
    if (bucket) bucket.push(v);
    else byHash.set(v.promptHash, [v]);
  }
  const verdicts = new Map<string, ReferenceVerdict>();
  const liveHashes = new Set<string>();
  let entriesUnvoted = 0;
  let entriesPanelSplit = 0;
  let entriesPanelIncomplete = 0;
  for (const text of entries) {
    const hash = lookup.hashOf(text);
    liveHashes.add(hash);
    const panel = byHash.get(hash);
    if (panel === undefined || panel.length === 0) {
      entriesUnvoted += 1;
      continue;
    }
    // The rule's three arms land in three counters. No default branch and no `else`: a fourth arm
    // would be a compile error here rather than silently joining whichever bucket it fell past.
    const v = lookup.consensus(panel);
    if (v.kind === "split") entriesPanelSplit += 1;
    else if (v.kind === "incomplete") entriesPanelIncomplete += 1;
    else verdicts.set(text, { taskType: v.label, votesFor: v.votes, votesTotal: v.votes });
  }
  let votesWithoutCorpusEntry = 0;
  for (const [hash, panel] of byHash) {
    if (!liveHashes.has(hash)) votesWithoutCorpusEntry += panel.length;
  }
  return {
    verdicts,
    entriesResolved: verdicts.size,
    entriesUnvoted,
    entriesPanelSplit,
    entriesPanelIncomplete,
    votesAtOtherRev,
    votesWithoutCorpusEntry,
  };
}

// ---------------------------------------------------------------------------
// The regime boundary. The service's classifier changed partway through the recorded period, so
// a rate averaged over the whole corpus blends two label authors and describes no state the
// system was ever in.
// ---------------------------------------------------------------------------

/**
 * Which regime a corpus entry's traffic belongs to.
 *
 * `spanning` exists because distinctness is on exact text: one entry — "run the tests" — really can
 * have been asked in both eras. Assigning it to either would credit one regime with the other's
 * traffic, and dropping it would shrink the corpus invisibly. It is set aside and counted, so
 * `before + after + spanning` is the whole.
 */
export type RegimeSegment = "before" | "after" | "spanning";

/** A corpus entry with the regime its askings fall in. Extends the dry run's own corpus unit. */
export interface SegmentedPrompt extends DistinctPrompt {
  readonly firstTs: number;
  readonly lastTs: number;
  readonly segment: RegimeSegment;
}

/**
 * Bucket the corpus by which side of the regime boundary its askings fall on.
 *
 * The boundary is the instant the new regime began, so a prompt asked exactly at it is `after` —
 * lower-inclusive, the same convention `stratifyByLength` uses for its cuts.
 *
 * Exclusion is delegated to the dry run's own partitions rather than restated, so a row cannot be
 * corpus to the cost estimate and non-corpus to the scoring. Occurrences come from
 * `distinctPrompts` for the same reason: two counts of the same thing are two chances to disagree.
 */
export function segmentCorpus(
  rows: readonly UserPromptRow[],
  boundaryTs: number,
): SegmentedPrompt[] {
  const { lead } = partitionLeadPrompts(rows);
  const { corpus } = partitionSteerText(lead);
  const spans = new Map<string, { first: number; last: number }>();
  for (const row of corpus) {
    const text = row.text as string;
    const span = spans.get(text);
    if (span === undefined) spans.set(text, { first: row.ts, last: row.ts });
    else {
      if (row.ts < span.first) span.first = row.ts;
      if (row.ts > span.last) span.last = row.ts;
    }
  }
  return distinctPrompts(corpus).map((p) => {
    const span = spans.get(p.text) ?? { first: 0, last: 0 };
    const segment: RegimeSegment =
      span.last < boundaryTs ? "before" : span.first >= boundaryTs ? "after" : "spanning";
    return { ...p, firstTs: span.first, lastTs: span.last, segment };
  });
}

/**
 * The two regimes, the entries that straddle them, and the whole. Every corpus-level figure in this
 * module is one of these, so a whole-corpus number is unreachable without the segments that compose
 * it — the ticket's "a whole-corpus figure may appear only alongside both segments", held by the
 * type rather than by the renderer remembering to print all four.
 */
export interface Segmented<T> {
  readonly before: T;
  readonly after: T;
  readonly spanning: T;
  readonly whole: T;
}

/** Apply one aggregation to each segment and to the corpus entire. */
export function bySegment<T>(
  entries: readonly ScoredEntry[],
  f: (entries: readonly ScoredEntry[]) => T,
): Segmented<T> {
  const of = (s: RegimeSegment): T => f(entries.filter((e) => e.segment === s));
  return { before: of("before"), after: of("after"), spanning: of("spanning"), whole: f(entries) };
}

// ---------------------------------------------------------------------------
// Scoring one replay against the panel.
// ---------------------------------------------------------------------------

/**
 * One prompt's replayed label.
 *
 * `classification` MUST be the classifier's raw answer, before the confidence floor is applied.
 * The shipped `classify()` returns exactly that — `runtime.ts` applies `CLASSIFY_CONFIDENCE_FLOOR`
 * at the override site, not inside the classifier — and the distinction is the whole ticket: a
 * replay that pre-filtered on the floor would deliver every sub-floor prompt as `null`, leaving the
 * reliability curve with no evidence at all in the region the floor is being argued about.
 */
export interface ReplayLabel {
  readonly text: string;
  /** null = the classifier declined: unparseable reply, timeout, or a thrown provider error. */
  readonly classification: TaskClassification | null;
}

/** One classifier model's pass over the corpus. */
export interface ModelReplay {
  readonly modelId: string;
  readonly labels: readonly ReplayLabel[];
}

/**
 * What one corpus entry contributes to the score. Four of the five outcomes are outside accuracy's
 * denominator, and they are kept apart because each is a different claim:
 *
 *   · `abstained` — the classifier declined. Fail-open is its designed behaviour, so scoring it as
 *     a wrong answer would charge it for not answering.
 *   · `unassessable` — no reference verdict to compare against. The same distinction MUB-225 draws
 *     for corroboration: nothing to compare is not a failed comparison.
 *   · `unreplayed` — the corpus entry never reached the classifier at all. A gap in the run, not a
 *     fact about the classifier; folding it into `abstained` would let a truncated replay report
 *     itself as a fail-open rate.
 */
export type ScoreOutcome = "correct" | "incorrect" | "abstained" | "unassessable" | "unreplayed";

/** One scored corpus entry. Carries prompt text as its identity, and never renders it. */
export interface ScoredEntry {
  readonly text: string;
  readonly segment: RegimeSegment;
  readonly outcome: ScoreOutcome;
  /** What the classifier said, or null when it declined or was never asked. */
  readonly emitted: TaskType | null;
  /** The classifier's self-reported confidence — the reliability curve's x axis. */
  readonly confidence: number | null;
  /** The panel's type, or null when no verdict was resolved for this entry. */
  readonly reference: TaskType | null;
  /** Whether the panel was of one mind. Null when there is no verdict. */
  readonly referenceUnanimous: boolean | null;
}

/**
 * Score one model's replay against the resolved panel verdicts.
 *
 * Driven by the CORPUS, not by the replay's labels: every corpus entry appears in the output
 * exactly once, so a prompt the replay skipped is a visible `unreplayed` row rather than a quietly
 * smaller denominator. A label for text that is not a corpus entry is dropped for the same reason —
 * it would add a row the corpus never contained.
 *
 * Outcome precedence is `unreplayed` before `unassessable` before `abstained`: a fact about this
 * run's coverage is settled before a fact about the panel, which is settled before a fact about the
 * classifier. Only an entry that survives all three is an observation of accuracy.
 */
export function scoreReplay(
  replay: ModelReplay,
  corpus: readonly SegmentedPrompt[],
  verdicts: ReadonlyMap<string, ReferenceVerdict>,
): ScoredEntry[] {
  const labels = new Map<string, TaskClassification | null>();
  for (const l of replay.labels) labels.set(l.text, l.classification);
  return corpus.map((entry) => {
    const verdict = verdicts.get(entry.text) ?? null;
    const reference = verdict?.taskType ?? null;
    const referenceUnanimous = verdict === null ? null : isUnanimous(verdict);
    const replayed = labels.has(entry.text);
    const cls = labels.get(entry.text) ?? null;
    const outcome: ScoreOutcome = !replayed
      ? "unreplayed"
      : verdict === null
        ? "unassessable"
        : cls === null
          ? "abstained"
          : cls.taskType === verdict.taskType
            ? "correct"
            : "incorrect";
    return {
      text: entry.text,
      segment: entry.segment,
      outcome,
      emitted: cls?.taskType ?? null,
      confidence: cls?.confidence ?? null,
      reference,
      referenceUnanimous,
    };
  });
}

// ---------------------------------------------------------------------------
// Support. A percentage over single-digit support is the most likely way this evaluation misleads.
// ---------------------------------------------------------------------------

/**
 * The denominator below which a percentage is not shown. Ten is the first two-digit denominator —
 * the ticket's own line is "task types with single-digit counts", so the rule is read off that
 * rather than chosen from a power calculation this corpus could not support anyway.
 *
 * A caller may state a lower bar via {@link FloorTarget.minSupport}, and it then governs the
 * READOUT as well as the floor selection — one bar, not two. That is deliberate: a caller willing
 * to derive a production floor off nine observations is by definition willing to read nine, and a
 * run that selected on evidence it then refused to print would be unauditable.
 */
export const MIN_REPORTABLE_SUPPORT = 10;

/**
 * A rate together with the verdict on its own support. `Rate` already makes the denominator
 * inseparable from the percentage; this makes "is that denominator big enough to quote" inseparable
 * too, so suppression is a property of the value rather than of whoever prints it.
 */
export interface Supported {
  readonly rate: Rate;
  readonly minSupport: number;
  readonly reportable: boolean;
}

/** Wrap a rate with its support verdict. */
export function supported(r: Rate, minSupport: number = MIN_REPORTABLE_SUPPORT): Supported {
  return { rate: r, minSupport, reportable: r.d >= minSupport };
}

/** Render a supported rate, suppressing the percentage when its denominator cannot carry one. */
export function formatSupported(s: Supported): string {
  if (s.reportable) return formatRate(s.rate);
  return `${s.rate.n}/${s.rate.d} (n<${s.minSupport}, not reportable)`;
}

// ---------------------------------------------------------------------------
// Aggregations. Each is a total function over scored entries, so each composes with `bySegment`.
// ---------------------------------------------------------------------------

/** Is this entry an observation of accuracy — the classifier answered and the panel had a verdict? */
export function isScoredEntry(e: ScoredEntry): boolean {
  return e.outcome === "correct" || e.outcome === "incorrect";
}

/** The observations of accuracy in a population. */
function scoredOnly(entries: readonly ScoredEntry[]): ScoredEntry[] {
  return entries.filter(isScoredEntry);
}

/**
 * One model's accuracy over a population, with everything excluded from it reported beside it.
 *
 * EVERY rate here is {@link Supported}, not a bare `Rate`. The exclusions are as much a claim about
 * the classifier as the accuracy is — "it abstained on a fifth of the corpus" generalises exactly
 * as far as "it was right on four fifths" does — so they sit under the same support bar. A readout
 * where some percentages are suppressed and others are not teaches a reader that a printed
 * percentage means nothing in particular.
 */
export interface ReplayAccuracy {
  /** Corpus entries in this population, however they scored. */
  readonly entries: number;
  /** Entries that were observations of accuracy — the denominator of `correct`. */
  readonly scored: number;
  readonly correct: Supported;
  /**
   * Correctness restricted to entries whose panel was unanimous. Disagreeing with a 2-1 split is
   * weaker evidence of a mistake than disagreeing with a panel of one mind, and one figure over
   * both cannot say which it was — the reason ADR 0001 stores votes rather than verdicts.
   */
  readonly correctUnanimousOnly: Supported;
  /** The classifier declined, over all entries. Its fail-open rate, not an error rate. */
  readonly abstained: Supported;
  /** No panel verdict to compare against, over all entries. */
  readonly unassessable: Supported;
  /** Never reached the classifier, over all entries. A coverage gap in the run. */
  readonly unreplayed: Supported;
}

/** Accuracy and its exclusions over one population of scored entries. */
export function accuracyOf(entries: readonly ScoredEntry[]): ReplayAccuracy {
  const scored = scoredOnly(entries);
  const unanimous = scored.filter((e) => e.referenceUnanimous === true);
  const share = (o: ScoreOutcome): Supported =>
    supported(rate(entries.filter((e) => e.outcome === o).length, entries.length));
  return {
    entries: entries.length,
    scored: scored.length,
    correct: supported(rate(scored.filter((e) => e.outcome === "correct").length, scored.length)),
    correctUnanimousOnly: supported(
      rate(unanimous.filter((e) => e.outcome === "correct").length, unanimous.length),
    ),
    abstained: share("abstained"),
    unassessable: share("unassessable"),
    unreplayed: share("unreplayed"),
  };
}

/** The task type the classifier reaches for when nothing else fits. */
export const CATCH_ALL_TASK_TYPE: TaskType = "other";

/**
 * The catch-all's emission, and whether the panel thought it was the right answer.
 *
 * All three denominators are the scored population, so the classifier's rate and the panel's own
 * are directly comparable. That comparison is the point: an emission rate quoted alone says nothing
 * about whether the classifier is over-reaching, because part of any corpus genuinely is
 * uncategorisable. The panel's rate is what says how much.
 */
export interface CatchAllReport {
  readonly emission: Supported;
  /** Of the entries the classifier called catch-all, how often the panel agreed. */
  readonly panelAgrees: Supported;
  /** The panel's own catch-all rate — the share of this corpus that genuinely has no type. */
  readonly panelEmission: Supported;
}

/** The catch-all figures over one population. */
export function catchAllOf(entries: readonly ScoredEntry[]): CatchAllReport {
  const scored = scoredOnly(entries);
  const emitted = scored.filter((e) => e.emitted === CATCH_ALL_TASK_TYPE);
  return {
    emission: supported(rate(emitted.length, scored.length)),
    panelAgrees: supported(
      rate(emitted.filter((e) => e.reference === CATCH_ALL_TASK_TYPE).length, emitted.length),
    ),
    panelEmission: supported(
      rate(scored.filter((e) => e.reference === CATCH_ALL_TASK_TYPE).length, scored.length),
    ),
  };
}

/**
 * One task type's two views. They answer different questions and have different denominators, so
 * each carries its own support verdict: a type can have plenty of emissions and almost no reference
 * entries, and one `reportable` flag over both would suppress the figure that was fine.
 */
export interface TaskTypeAccuracy {
  readonly taskType: TaskType;
  /** Of entries the panel calls this type, how often the classifier agreed. */
  readonly recall: Supported;
  /** Of entries the classifier calls this type, how often the panel agreed. */
  readonly precision: Supported;
}

/**
 * Per-type recall and precision, in the wire schema's own order.
 *
 * Types nobody used are omitted rather than shown as `0/0` — an untouched type is not a finding
 * about the classifier, and eleven rows of zeroes would bury the three that carry the corpus.
 */
export function taskTypeBreakdown(entries: readonly ScoredEntry[]): TaskTypeAccuracy[] {
  const scored = scoredOnly(entries);
  const rows: TaskTypeAccuracy[] = [];
  for (const taskType of TASK_TYPES) {
    const referenced = scored.filter((e) => e.reference === taskType);
    const emitted = scored.filter((e) => e.emitted === taskType);
    if (referenced.length === 0 && emitted.length === 0) continue;
    rows.push({
      taskType,
      recall: supported(
        rate(referenced.filter((e) => e.emitted === taskType).length, referenced.length),
      ),
      precision: supported(
        rate(emitted.filter((e) => e.reference === taskType).length, emitted.length),
      ),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The reliability curve: does the classifier's self-reported number mean anything?
// ---------------------------------------------------------------------------

/**
 * Confidence bin edges, lower-inclusive.
 *
 * `CLASSIFY_CONFIDENCE_FLOOR` is one of them deliberately: the floor in force has to be a bin edge,
 * or the bin straddling it mixes overrides production accepts with overrides it drops, and the one
 * comparison this whole evaluation exists to make is unreadable. The rest are placed where a
 * one-completion classifier actually reports — clustered high — rather than spread evenly.
 */
export const DEFAULT_CONFIDENCE_BOUNDARIES: readonly number[] = [
  0.6,
  0.7,
  CLASSIFY_CONFIDENCE_FLOOR,
  0.8,
  0.9,
];

/** One bin of the reliability curve: the classifier's claim on the left, what happened on the right. */
export interface ReliabilityBin {
  readonly label: string;
  /** Lower bound, INCLUSIVE. */
  readonly minConfidence: number;
  /** Upper bound, EXCLUSIVE. `null` marks the open-ended top bin. */
  readonly maxConfidenceExclusive: number | null;
  readonly correct: Supported;
}

/**
 * Bin the scored entries by the confidence the classifier reported for them.
 *
 * Only scored entries appear: an abstention has no confidence to bin, and an unassessable entry has
 * nothing to be right or wrong about. The bins therefore partition the accuracy denominator exactly,
 * which is the invariant that makes the curve and the headline figure the same measurement.
 */
export function reliabilityCurve(
  entries: readonly ScoredEntry[],
  boundaries: readonly number[] = DEFAULT_CONFIDENCE_BOUNDARIES,
): ReliabilityBin[] {
  const scored = scoredOnly(entries);
  const edges = [0, ...cutPoints(boundaries, 1)];
  return edges.map((minConfidence, i) => {
    const next = edges[i + 1] ?? null;
    const inBin = scored.filter(
      (e) =>
        e.confidence !== null &&
        e.confidence >= minConfidence &&
        (next === null || e.confidence < next),
    );
    const label =
      next === null
        ? `>=${minConfidence.toFixed(2)}`
        : minConfidence === 0
          ? `<${next.toFixed(2)}`
          : `${minConfidence.toFixed(2)}-<${next.toFixed(2)}`;
    return {
      label,
      minConfidence,
      maxConfidenceExclusive: next,
      correct: supported(rate(inBin.filter((e) => e.outcome === "correct").length, inBin.length)),
    };
  });
}

// ---------------------------------------------------------------------------
// The floor. Derived from the curve's TAIL, because that is what a floor selects on.
// ---------------------------------------------------------------------------

/**
 * What one candidate floor would do: the correctness of everything it admits, and how much of the
 * corpus that is.
 *
 * Coverage is not decoration. A threshold with excellent correctness over a tenth of the corpus has
 * turned the client classifier off for the other nine tenths, and a floor quoted without it reads
 * as a free improvement.
 */
export interface FloorCandidate {
  readonly threshold: number;
  /** Correctness of the entries at or above the threshold — what this floor would let through. */
  readonly correct: Supported;
  /** Admitted entries over all scored entries. Supported like every other rate reported here. */
  readonly coverage: Supported;
}

/** Entries whose self-reported confidence is at or above a threshold. */
function admittedBy(entries: readonly ScoredEntry[], threshold: number): ScoredEntry[] {
  return entries.filter((e) => e.confidence !== null && e.confidence >= threshold);
}

/** Build a candidate from an already-scored population. */
function candidateAt(
  scored: readonly ScoredEntry[],
  threshold: number,
  minSupport: number,
): FloorCandidate {
  const admitted = admittedBy(scored, threshold);
  return {
    threshold,
    correct: supported(
      rate(admitted.filter((e) => e.outcome === "correct").length, admitted.length),
      minSupport,
    ),
    coverage: supported(rate(admitted.length, scored.length), minSupport),
  };
}

/**
 * The whole trade-off table: what every candidate threshold would admit and at what correctness.
 *
 * This reads the TAIL at each threshold, not the bin. A per-bin rate answers "how good are the
 * labels that report about 0.8"; a floor asks "how good is everything I would let through at 0.8",
 * and on a non-monotone curve — which a few hundred prompts will always produce — those are
 * different numbers. Deriving a floor from bins would pick a threshold on the strength of a bin
 * whose neighbours above it are worse.
 */
export function floorCandidates(
  entries: readonly ScoredEntry[],
  thresholds: readonly number[] = DEFAULT_CONFIDENCE_BOUNDARIES,
  minSupport: number = MIN_REPORTABLE_SUPPORT,
): FloorCandidate[] {
  const scored = scoredOnly(entries);
  return cutPoints(thresholds, 1).map((t) => candidateAt(scored, t, minSupport));
}

/**
 * How a derived floor differs from the one in force, in both currencies.
 *
 * The two pairs are the two sides of the band between the floors, and exactly one pair is non-zero
 * for any given direction. Both are reported because a floor is always a trade: lowering it admits
 * overrides the baseline dropped — some right, some wrong — and raising it discards overrides the
 * baseline admitted, again some of each. A recommendation that quotes only the favourable half of
 * that is an argument, not a measurement.
 */
export interface FloorArgument {
  readonly direction: "lower" | "higher" | "unchanged";
  /** Right answers the derived floor admits that the baseline drops. */
  readonly admittedCorrect: number;
  /** Wrong answers it admits along with them. */
  readonly admittedIncorrect: number;
  /** Right answers the derived floor drops that the baseline admits — the cost of raising it. */
  readonly droppedCorrect: number;
  /** Wrong answers it drops with them — the benefit. */
  readonly droppedIncorrect: number;
}

/**
 * Why no floor could be derived. Three different states of the world, and reporting one number for
 * them would make a corpus too small to answer look like a corpus that answered "no":
 *
 *   · `no-observations` — nothing was scored at all. Says nothing about any floor.
 *   · `insufficient-support` — entries were scored, but no candidate tail has a denominator big
 *     enough to quote. The corpus cannot answer the question yet.
 *   · `target-unreachable` — a supported tail exists and none of them reaches the target. That IS
 *     an answer: at this target, no floor in the range makes the override safe. Returning the
 *     highest threshold instead would manufacture a floor out of a refusal.
 */
export type FloorRefusal = "no-observations" | "insufficient-support" | "target-unreachable";

/** What the derivation was asked for. The target is stated by the caller and printed with the result. */
export interface FloorTarget {
  /**
   * The correctness an admitted override must reach, as a fraction.
   *
   * Stated, never inferred: the non-arbitrary target is the server heuristic's own accuracy on the
   * same corpus — an override is worth taking exactly when it beats what it replaces — and that is
   * MUB-226's adjudication, not this ticket's. What is derived here is the threshold; the bar it
   * clears is an input, and printing it beside the answer is what keeps that honest.
   */
  readonly targetCorrectness: number;
  readonly thresholds: readonly number[];
  /** The floor in force — the thing a derived floor is an argument against. */
  readonly baseline: number;
  readonly minSupport?: number;
}

/** The derivation's result. Both arms carry the full table and the baseline's own tail. */
export type FloorDerivation = {
  readonly target: number;
  readonly candidates: readonly FloorCandidate[];
  /** The baseline's own tail, present whether or not a floor was derived. */
  readonly baseline: FloorCandidate;
} & (
  | { readonly kind: "derived"; readonly chosen: FloorCandidate; readonly argument: FloorArgument }
  | { readonly kind: "underdetermined"; readonly reason: FloorRefusal }
);

/**
 * Derive a routing floor from the reliability curve's tail.
 *
 * The rule: the LOWEST threshold whose admitted tail reaches the target on a denominator big enough
 * to quote. Lowest, because every step up discards overrides that would have been right — coverage
 * is a cost paid in correct answers, so the cheapest threshold that clears the bar is the one to
 * take. Support is required first: a tail of six that happens to be perfect is not evidence, and
 * choosing on it would be how a floor of 0.95 gets derived from nine prompts.
 *
 * Selection compares the EXACT ratio against the target, never the rounded percentage `Rate` prints.
 * 7/9 renders as 77.8% and would clear a target of 0.778 read off that figure, while the true value
 * does not — a floor must not be derivable from a rounding artifact.
 */
export function deriveFloor(entries: readonly ScoredEntry[], target: FloorTarget): FloorDerivation {
  const minSupport = target.minSupport ?? MIN_REPORTABLE_SUPPORT;
  const scored = scoredOnly(entries);
  const candidates = floorCandidates(scored, target.thresholds, minSupport);
  const baseline = candidateAt(scored, target.baseline, minSupport);
  const common = { target: target.targetCorrectness, candidates, baseline };
  if (scored.length === 0) {
    return { ...common, kind: "underdetermined", reason: "no-observations" };
  }
  const supportedCandidates = candidates.filter((c) => c.correct.reportable);
  if (supportedCandidates.length === 0) {
    return { ...common, kind: "underdetermined", reason: "insufficient-support" };
  }
  const chosen = supportedCandidates.find(
    (c) => c.correct.rate.n / c.correct.rate.d >= target.targetCorrectness,
  );
  if (chosen === undefined) {
    return { ...common, kind: "underdetermined", reason: "target-unreachable" };
  }
  return {
    ...common,
    kind: "derived",
    chosen,
    argument: argue(scored, chosen.threshold, target.baseline),
  };
}

/** The band between two floors, counted in right and wrong answers. */
function argue(scored: readonly ScoredEntry[], chosen: number, baseline: number): FloorArgument {
  const band = (lo: number, hi: number): ScoredEntry[] =>
    scored.filter((e) => e.confidence !== null && e.confidence >= lo && e.confidence < hi);
  const count = (rows: readonly ScoredEntry[], o: ScoreOutcome): number =>
    rows.filter((e) => e.outcome === o).length;
  if (chosen < baseline) {
    const admitted = band(chosen, baseline);
    return {
      direction: "lower",
      admittedCorrect: count(admitted, "correct"),
      admittedIncorrect: count(admitted, "incorrect"),
      droppedCorrect: 0,
      droppedIncorrect: 0,
    };
  }
  if (chosen > baseline) {
    const dropped = band(baseline, chosen);
    return {
      direction: "higher",
      admittedCorrect: 0,
      admittedIncorrect: 0,
      droppedCorrect: count(dropped, "correct"),
      droppedIncorrect: count(dropped, "incorrect"),
    };
  }
  return {
    direction: "unchanged",
    admittedCorrect: 0,
    admittedIncorrect: 0,
    droppedCorrect: 0,
    droppedIncorrect: 0,
  };
}

// ---------------------------------------------------------------------------
// Two models on one corpus: what the model switch would cost.
// ---------------------------------------------------------------------------

/** One model's replay, already scored against the panel. */
export interface ScoredReplay {
  readonly modelId: string;
  readonly entries: readonly ScoredEntry[];
}

/**
 * Two classifier models compared on the entries they BOTH scored.
 *
 * The 2x2 is the content, not the delta. Two models can post the same rate and disagree on a third
 * of the corpus, and a difference of zero points would report them as interchangeable — which is
 * the wrong answer to "what does the model switch cost", because the switch changes which prompts
 * are wrong, not just how many.
 */
export interface ModelComparison {
  readonly modelA: string;
  readonly modelB: string;
  /** Entries both models scored — the only denominator on which a difference means anything. */
  readonly paired: number;
  readonly correctA: Supported;
  readonly correctB: Supported;
  /** A minus B in percentage points over the paired set. `null` when nothing paired. */
  readonly deltaPoints: number | null;
  readonly bothCorrect: number;
  readonly onlyACorrect: number;
  readonly onlyBCorrect: number;
  readonly bothIncorrect: number;
  /** Scored by A alone — B abstained, was never replayed, or had no verdict on it. */
  readonly unpairedOnlyA: number;
  /** Scored by B alone. */
  readonly unpairedOnlyB: number;
  /** Scored by neither. */
  readonly unpairedNeither: number;
}

/**
 * Compare two scored replays over the same corpus.
 *
 * Pairing is on the corpus entry, and only entries both models scored count. Two rates over two
 * different denominators would fold a difference in COVERAGE — one model abstaining more often —
 * into what reads as a difference in ACCURACY. The entries the pairing set aside are counted from
 * each side, so the size of that exclusion stays visible.
 */
export function compareModels(a: ScoredReplay, b: ScoredReplay): ModelComparison {
  const isScored = (e: ScoredEntry): boolean =>
    e.outcome === "correct" || e.outcome === "incorrect";
  const byText = new Map<string, ScoredEntry>();
  for (const e of b.entries) byText.set(e.text, e);
  let bothCorrect = 0;
  let onlyACorrect = 0;
  let onlyBCorrect = 0;
  let bothIncorrect = 0;
  let unpairedOnlyA = 0;
  let unpairedOnlyB = 0;
  let unpairedNeither = 0;
  for (const ea of a.entries) {
    const eb = byText.get(ea.text);
    const aScored = isScored(ea);
    const bScored = eb !== undefined && isScored(eb);
    if (!aScored || !bScored) {
      if (aScored) unpairedOnlyA += 1;
      else if (bScored) unpairedOnlyB += 1;
      else unpairedNeither += 1;
      continue;
    }
    const ac = ea.outcome === "correct";
    const bc = eb.outcome === "correct";
    if (ac && bc) bothCorrect += 1;
    else if (ac) onlyACorrect += 1;
    else if (bc) onlyBCorrect += 1;
    else bothIncorrect += 1;
  }
  // Entries B scored that A's corpus never carried. Both replays are corpus-driven so this is
  // normally zero, and counting it is what would make it visible if it ever were not.
  const aTexts = new Set(a.entries.map((e) => e.text));
  for (const eb of b.entries) if (!aTexts.has(eb.text) && isScored(eb)) unpairedOnlyB += 1;
  const paired = bothCorrect + onlyACorrect + onlyBCorrect + bothIncorrect;
  return {
    modelA: a.modelId,
    modelB: b.modelId,
    paired,
    correctA: supported(rate(bothCorrect + onlyACorrect, paired)),
    correctB: supported(rate(bothCorrect + onlyBCorrect, paired)),
    deltaPoints:
      paired === 0 ? null : Math.round(((onlyACorrect - onlyBCorrect) / paired) * 1000) / 10,
    bothCorrect,
    onlyACorrect,
    onlyBCorrect,
    bothIncorrect,
    unpairedOnlyA,
    unpairedOnlyB,
    unpairedNeither,
  };
}

// ---------------------------------------------------------------------------
// The report. Every corpus-level figure is a four-up, so the whole never appears on its own.
// ---------------------------------------------------------------------------

/** What the scoring run is told to measure. `scope` is descriptive only — it labels the readout. */
export interface ReplayScoreConfig {
  readonly scope: string;
  /**
   * The instant the service's classifier changed. Supplied, not discovered: it is a fact about the
   * deployment rather than about the ledger, and inferring it from the data would be the same
   * mistake as averaging across it.
   */
  readonly regimeBoundaryTs: number;
  readonly confidenceBoundaries: readonly number[];
  /**
   * The floor derivation's inputs, embedded rather than restated. Spelling them out here under
   * renamed keys would put the target, the thresholds and the baseline in two places that have to
   * agree, and the renaming is what makes a drift between them hard to see.
   */
  readonly floor: FloorTarget;
}

/** One classifier model's whole readout, every figure segmented at the regime boundary. */
export interface ModelScoreReport {
  readonly modelId: string;
  readonly accuracy: Segmented<ReplayAccuracy>;
  readonly catchAll: Segmented<CatchAllReport>;
  readonly taskTypes: Segmented<readonly TaskTypeAccuracy[]>;
  readonly reliability: Segmented<readonly ReliabilityBin[]>;
  readonly floor: Segmented<FloorDerivation>;
}

/** Every number the replay scoring reports. */
export interface ReplayScoreReport {
  readonly scope: string;
  readonly regimeBoundaryTs: number;
  readonly baselineFloor: number;
  readonly targetCorrectness: number;
  readonly corpusEntries: Segmented<number>;
  readonly reference: ReferenceResolution;
  readonly models: readonly ModelScoreReport[];
  /** Every unordered pair of models, compared on the entries both scored. */
  readonly comparisons: readonly Segmented<ModelComparison>[];
}

/**
 * Assemble the whole readout. Pure: reads nothing, spends nothing.
 *
 * Takes replays already scored rather than raw labels, so the corpus, the panel verdicts and the
 * scoring rule are applied once by the caller and every model in the report is measured against
 * exactly the same reference — a second application here would be a second chance to diverge.
 */
export function buildReplayScoreReport(
  replays: readonly ScoredReplay[],
  reference: ReferenceResolution,
  cfg: ReplayScoreConfig,
): ReplayScoreReport {
  // Any replay's entries enumerate the corpus: `scoreReplay` is corpus-driven, so all of them carry
  // every entry exactly once whatever each model did with it.
  const corpusEntries = replays[0]?.entries ?? [];
  const comparisons: Segmented<ModelComparison>[] = [];
  for (let i = 0; i < replays.length; i += 1) {
    for (let j = i + 1; j < replays.length; j += 1) {
      const a = replays[i] as ScoredReplay;
      const b = replays[j] as ScoredReplay;
      const bByText = new Map(b.entries.map((e) => [e.text, e]));
      // Segmented through the same `bySegment` as every other figure: B's entries are narrowed to
      // whatever slice A's are, so a segment's comparison never reaches outside that segment.
      comparisons.push(
        bySegment(a.entries, (ea) =>
          compareModels(
            { modelId: a.modelId, entries: ea },
            {
              modelId: b.modelId,
              entries: ea.map((e) => bByText.get(e.text)).filter((e): e is ScoredEntry => !!e),
            },
          ),
        ),
      );
    }
  }
  return {
    scope: cfg.scope,
    regimeBoundaryTs: cfg.regimeBoundaryTs,
    baselineFloor: cfg.floor.baseline,
    targetCorrectness: cfg.floor.targetCorrectness,
    corpusEntries: bySegment(corpusEntries, (e) => e.length),
    reference,
    models: replays.map((r) => ({
      modelId: r.modelId,
      accuracy: bySegment(r.entries, accuracyOf),
      catchAll: bySegment(r.entries, catchAllOf),
      taskTypes: bySegment(r.entries, taskTypeBreakdown),
      reliability: bySegment(r.entries, (e) => reliabilityCurve(e, cfg.confidenceBoundaries)),
      floor: bySegment(r.entries, (e) => deriveFloor(e, cfg.floor)),
    })),
    comparisons,
  };
}

/**
 * Render a supported rate for a table cell, marking a suppressed percentage rather than printing it.
 *
 * An empty denominator renders as an em dash, not as `0/0`: nothing was observed on that axis, and
 * a leading zero over a zero reads as a measured absence — "the classifier got none of them right"
 * rather than "there were none to get".
 */
export function formatSupportedCompact(s: Supported): string {
  if (s.rate.d === 0) return "—";
  return s.reportable ? formatRate(s.rate) : `${s.rate.n}/${s.rate.d}†`;
}

/** Widest row label the segment table lays out for. Longer ones are cut, never allowed to collide. */
const SEG_LABEL_WIDTH = 26;

/**
 * Width of one segment column, heading included.
 *
 * Wide enough for the longest cell this corpus can produce — `before 159/159 (100.0%)` is 23
 * characters, and a 238-entry corpus reaches it the first time every entry lands in one outcome.
 * A column that a figure overflows closes up into the next heading and prints
 * `(100.0%)after 77/77`, which is a misread number rather than an ugly line. Sized so the FIGURE
 * never gives way; the row LABEL is what gets cut (see `SEG_LABEL_WIDTH`).
 */
const SEG_CELL_WIDTH = 25;

/**
 * One line of four segment columns, so a whole-corpus figure is never printed on its own.
 *
 * The label is truncated to its column rather than pushed through it: a model id long enough to
 * overflow would otherwise run straight into the first cell and produce `…correctbefore 3/5`, which
 * is a misread number, not just an ugly one.
 */
function segRow(label: string, s: Segmented<string>): string {
  const head =
    label.length > SEG_LABEL_WIDTH - 1 ? `${label.slice(0, SEG_LABEL_WIDTH - 2)}…` : label;
  // Every cell is padded to its own width AND separated by a space, so a cell that outgrows the
  // column pushes the next one right instead of fusing with it.
  const cell = (text: string): string => `${text.padEnd(SEG_CELL_WIDTH - 1)} `;
  return (
    `  ${head.padEnd(SEG_LABEL_WIDTH)}` +
    `${cell(`before ${s.before}`)}${cell(`after ${s.after}`)}` +
    `${cell(`spanning ${s.spanning}`)}whole ${s.whole}`
  );
}

/** Map a segmented value through a formatter, preserving the four-up shape. */
function mapSegmented<T>(s: Segmented<T>, f: (t: T) => string): Segmented<string> {
  return { before: f(s.before), after: f(s.after), spanning: f(s.spanning), whole: f(s.whole) };
}

/** One segment's floor, in a line. */
function floorLine(d: FloorDerivation): string {
  if (d.kind !== "derived") return `underdetermined — ${d.reason}`;
  return (
    `${d.chosen.threshold} · admits ${formatSupported(d.chosen.correct)}` +
    ` at ${formatSupported(d.chosen.coverage)} coverage`
  );
}

/**
 * One segment's derived floor against the floor in force, compressed to a table cell.
 *
 * `+` is what the derived floor admits that the baseline drops, `−` what it drops that the baseline
 * admits; `R`/`W` are right and wrong. The argument has to be segmented like every other figure:
 * a floor that is an improvement over the whole corpus and a regression within one regime is the
 * exact reading a whole-corpus-only argument would hide.
 */
function argumentCell(d: FloorDerivation): string {
  if (d.kind !== "derived") return "—";
  const a = d.argument;
  if (a.direction === "unchanged") return "same";
  if (a.direction === "lower") return `lower +${a.admittedCorrect}R/+${a.admittedIncorrect}W`;
  return `higher −${a.droppedCorrect}R/−${a.droppedIncorrect}W`;
}

/**
 * The derived floor's argument against the floor in force, in a line.
 *
 * A refusal still quotes the baseline's own tail. "No floor was derived" is a statement about the
 * search, not about the baseline — the baseline WAS measured, and reporting only the refusal would
 * throw away the one figure that bears directly on the floor actually in production.
 */
function argumentLine(baselineFloor: number, d: FloorDerivation): string {
  if (d.kind !== "derived") {
    return (
      `no floor was derived (${d.reason}); the ${baselineFloor} in force admits` +
      ` ${formatSupported(d.baseline.correct)} at ${formatSupported(d.baseline.coverage)} coverage`
    );
  }
  const a = d.argument;
  if (a.direction === "unchanged") {
    return `the derivation lands ON the ${baselineFloor} in force — it is supported, not merely inherited`;
  }
  if (a.direction === "lower") {
    return (
      `LOWER than the ${baselineFloor} in force: admits ${a.admittedCorrect} right and` +
      ` ${a.admittedIncorrect} wrong overrides that the floor in force drops`
    );
  }
  return (
    `HIGHER than the ${baselineFloor} in force: drops ${a.droppedCorrect} right overrides to` +
    ` also drop ${a.droppedIncorrect} wrong ones`
  );
}

/**
 * Render the report as plain text — counts, rates and denominators ONLY. No prompt text and no
 * reference label: the corpus is one developer's own traffic, so this readout is safe to paste
 * anywhere. Lives in the pure core alongside the counting so the shell cannot reformat a number on
 * its way out, and so the caveats travel with the figures rather than with whoever quotes them.
 */
export function renderReplayScoreReport(r: ReplayScoreReport): string {
  const lines: string[] = [
    "Classifier replay — accuracy against the reference panel, and the routing floor it implies",
    `scope: ${r.scope}`,
    `regime boundary: ts >= ${r.regimeBoundaryTs} is the later regime`,
    "",
    "Reference labels (consensus over cached votes — no stored label can enter here)",
    `  corpus entries resolved      ${r.reference.entriesResolved}`,
    `  no vote at this corpus rev   ${r.reference.entriesUnvoted}`,
    `  panel labelled and DISAGREED ${r.reference.entriesPanelSplit}  (a hard prompt)`,
    `  panel INCOMPLETE             ${r.reference.entriesPanelIncomplete}  (a panelist produced no label — coverage, not disagreement)`,
    `  votes at another corpus rev  ${r.reference.votesAtOtherRev}  (a different corpus, so absent)`,
    `  votes whose prompt is gone   ${r.reference.votesWithoutCorpusEntry}  (hash is one-way — unreadable)`,
    "",
    "Corpus (distinct prompts)",
    segRow(
      "entries",
      mapSegmented(r.corpusEntries, (n) => String(n)),
    ),
  ];
  for (const m of r.models) {
    lines.push(
      "",
      `── model: ${m.modelId} ${"─".repeat(Math.max(0, 60 - m.modelId.length))}`,
      "Accuracy (correct / scored)",
      segRow(
        "correct",
        mapSegmented(m.accuracy, (a) => formatSupportedCompact(a.correct)),
      ),
      // `correctUnanimousOnly` is deliberately NOT printed. Unanimity is the shipped rule's
      // admission criterion, so under it that figure equals `correct` exactly — and a row naming a
      // population identical to the row above it teaches a reader the distinction is live. The
      // field stays computed: a quorum rule that admitted a majority would make the two diverge,
      // and the arithmetic is what would notice.
      segRow(
        "abstained",
        mapSegmented(m.accuracy, (a) => formatSupportedCompact(a.abstained)),
      ),
      segRow(
        "no reference label",
        mapSegmented(m.accuracy, (a) => formatSupportedCompact(a.unassessable)),
      ),
      segRow(
        "never replayed",
        mapSegmented(m.accuracy, (a) => formatSupportedCompact(a.unreplayed)),
      ),
      "",
      `Catch-all \`${CATCH_ALL_TASK_TYPE}\` (of scored entries)`,
      segRow(
        "classifier emitted",
        mapSegmented(m.catchAll, (c) => formatSupportedCompact(c.emission)),
      ),
      segRow(
        "panel agreed",
        mapSegmented(m.catchAll, (c) => formatSupportedCompact(c.panelAgrees)),
      ),
      segRow(
        "panel's own rate",
        mapSegmented(m.catchAll, (c) => formatSupportedCompact(c.panelEmission)),
      ),
      "",
      "Per task type (recall = the panel's type found · precision = the classifier's type upheld)",
    );
    const present = TASK_TYPES.filter((t) =>
      [m.taskTypes.before, m.taskTypes.after, m.taskTypes.spanning, m.taskTypes.whole].some(
        (rows) => rows.some((row) => row.taskType === t),
      ),
    );
    if (present.length === 0) lines.push("  no scored entry carried a task type");
    for (const t of present) {
      const cell = (
        rows: readonly TaskTypeAccuracy[],
        pick: (a: TaskTypeAccuracy) => Supported,
      ) => {
        const row = rows.find((x) => x.taskType === t);
        return row ? formatSupportedCompact(pick(row)) : "—";
      };
      lines.push(
        segRow(
          `${t} recall`,
          mapSegmented(m.taskTypes, (rows) => cell(rows, (a) => a.recall)),
        ),
        segRow(
          `${t} precision`,
          mapSegmented(m.taskTypes, (rows) => cell(rows, (a) => a.precision)),
        ),
      );
    }
    lines.push("", "Reliability (self-reported confidence → observed correctness)");
    for (let i = 0; i < m.reliability.whole.length; i += 1) {
      const label = m.reliability.whole[i]?.label ?? "";
      lines.push(
        segRow(
          label,
          mapSegmented(m.reliability, (bins) => {
            const bin = bins[i];
            return bin ? formatSupportedCompact(bin.correct) : "—";
          }),
        ),
      );
    }
    lines.push(
      "",
      `Routing floor (target correctness ${(r.targetCorrectness * 100).toFixed(1)}%,` +
        ` floor in force ${r.baselineFloor})`,
      "  what each candidate floor would admit — correctness, then the share of the corpus kept:",
    );
    // Segmented like everything else. A candidate's correctness is a rate, so a whole-corpus one
    // printed on its own would be the very averaging across the regime change this readout refuses
    // — even though the derivation immediately below it is segmented.
    for (let i = 0; i < m.floor.whole.candidates.length; i += 1) {
      const t = m.floor.whole.candidates[i]?.threshold ?? 0;
      const mark = t === r.baselineFloor ? "  ← in force" : "";
      const candidateCell = (pick: (c: FloorCandidate) => string) => (d: FloorDerivation) => {
        const c = d.candidates[i];
        return c ? pick(c) : "—";
      };
      lines.push(
        `${segRow(
          `>=${t.toFixed(2)} correct`,
          mapSegmented(
            m.floor,
            candidateCell((c) => formatSupportedCompact(c.correct)),
          ),
        )}${mark}`,
        segRow(
          `>=${t.toFixed(2)} coverage`,
          mapSegmented(
            m.floor,
            candidateCell((c) => formatSupportedCompact(c.coverage)),
          ),
        ),
      );
    }
    lines.push(
      `  derived, before   ${floorLine(m.floor.before)}`,
      `  derived, after    ${floorLine(m.floor.after)}`,
      `  derived, spanning ${floorLine(m.floor.spanning)}`,
      `  derived, whole    ${floorLine(m.floor.whole)}`,
      segRow("vs the floor in force", mapSegmented(m.floor, argumentCell)),
      `  ${argumentLine(r.baselineFloor, m.floor.whole)}`,
    );
  }
  for (const c of r.comparisons) {
    lines.push(
      "",
      `── ${c.whole.modelA} vs ${c.whole.modelB} — what the model switch costs ${"─".repeat(20)}`,
      segRow(
        "paired entries",
        mapSegmented(c, (x) => String(x.paired)),
      ),
      segRow(
        `${c.whole.modelA} correct`,
        mapSegmented(c, (x) => formatSupportedCompact(x.correctA)),
      ),
      segRow(
        `${c.whole.modelB} correct`,
        mapSegmented(c, (x) => formatSupportedCompact(x.correctB)),
      ),
      segRow(
        "difference (pts)",
        mapSegmented(c, (x) => (x.deltaPoints === null ? "n/a" : x.deltaPoints.toFixed(1))),
      ),
      segRow(
        "both right",
        mapSegmented(c, (x) => `${x.bothCorrect} of ${x.paired}`),
      ),
      segRow(
        "only A / only B right",
        mapSegmented(c, (x) => `${x.onlyACorrect} / ${x.onlyBCorrect}`),
      ),
      segRow(
        "both wrong",
        mapSegmented(c, (x) => `${x.bothIncorrect} of ${x.paired}`),
      ),
      segRow(
        "unpaired A / B / neither",
        mapSegmented(c, (x) => `${x.unpairedOnlyA} / ${x.unpairedOnlyB} / ${x.unpairedNeither}`),
      ),
      "  the two 'only' counts are the switch's real cost: a difference of zero points with a",
      "  non-zero split means the models are equally accurate on DIFFERENT prompts, not alike.",
    );
  }
  lines.push(
    "",
    "What these figures are, which travels with every one of them:",
    "  · † marks a single-digit denominator, on EVERY rate here — accuracy, exclusions, coverage",
    "    alike. The count stands; the percentage is not reportable, and on a corpus of one",
    "    developer's traffic most per-segment and per-type figures will carry it. An em dash means",
    "    there was nothing to measure at all, which is not the same as measuring zero.",
    "  · `vs the floor in force` reads +nR/+nW for what a LOWER derived floor would admit that the",
    "    floor in force drops, and −nR/−nW for what a HIGHER one would drop that it admits.",
    "  · Every rate is segmented at the regime boundary because the service's classifier changed",
    "    partway through the recorded period. A whole-corpus figure blends two label authors and",
    "    describes no state the system was ever in, so it appears only beside both segments.",
    "  · `spanning` is one exact prompt text asked in BOTH regimes. It is in neither era's figure,",
    "    because attributing it to one would credit that regime with the other's traffic.",
    "  · Reference labels are a paid panel's consensus over individual votes, resolved at read time.",
    "    No historical stored task type is scored: the recorded labels are the SERVICE's, and their",
    "    author is ambiguous, which is why this is a replay and not a mining exercise.",
    "  · An entry with no vote, a panel that DISAGREED and a panel that never finished are three",
    "    separate counts above and are never added up. One is a gap in the cache, one is a fact",
    "    about the prompt, one is a fact about the panel's coverage — and two agreeing panelists",
    "    out of three have not agreed. Under the rule that ships, unanimity is the admission",
    "    criterion, so every reference label here rests on a panel of one mind.",
    "  · Accuracy's denominator is entries the classifier answered AND the panel labelled. An",
    "    abstention is the classifier failing open by design, and an unlabelled entry is nothing to",
    "    compare against — neither is a wrong answer, so neither is counted as one.",
    "  · The floor is derived from the TAIL at each threshold, not from a bin, because a floor",
    "    admits everything above it. The target correctness it must clear is an INPUT, printed",
    "    above: the non-arbitrary target is what the server heuristic scores on the same corpus,",
    "    and adjudicating the override against it is MUB-226's, not this readout's.",
  );
  return lines.join("\n");
}
