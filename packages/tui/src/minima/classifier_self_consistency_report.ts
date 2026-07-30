/**
 * What the self-consistency draws amount to (MUB-217) — the pure core and its readout.
 *
 * `classifier_self_consistency.ts` buys the draws; this file turns them into the ticket's answer:
 * per prompt, the empirical frequency of the classifier's own modal label, against the number it
 * reported about itself, with the SIGN of the difference kept because the sign is the finding.
 *
 * PURE. No ledger, no network, no clock. It takes a narrow input — {@link SelfConsistencyInput} is
 * `{corpus, samples}` and nothing else — declared HERE rather than added to `classifier_eval_
 * wiring.ts`'s `EvalReads`. That decoupling is deliberate: this lane needs neither the panel's
 * votes nor the replay's labels nor the routing decisions, and joining it to the shared read shape
 * would make a reader wonder which of them it consults (AC 4: it runs with NO reference labels).
 * It is under `src/`, so `tsc` type-checks it regardless.
 *
 * ## The limitation, which is printed and not merely documented
 *
 * **This measures self-consistency, not correctness. A model that is consistently wrong looks
 * perfectly calibrated by this metric alone.** Ten identical wrong answers score 1.0. The number
 * here is about repeatability; whether the repeated answer is right is MUB-218's `--score`, which
 * needs the reference labels this lane deliberately does not read. {@link SELF_CONSISTENCY_LIMITS}
 * carries the wording into every rendered report.
 *
 * ## Two comparands, and which one is primary
 *
 * `CLASSIFY_SYSTEM` says "confidence is how sure you are of BOTH labels", so the self-report is a
 * claim about the (task_type, difficulty) PAIR. The modal frequency of that pair is therefore the
 * primary comparand. Task-type-alone is reported beside it as a SECONDARY figure and is always
 * greater than or equal to it — collapsing a difficulty disagreement into agreement can only raise
 * the frequency — so quoting task-type-alone as the headline would systematically understate
 * overconfidence. Both are printed, and the primary one is labelled.
 *
 * ## Why a single mean is not enough, three times over
 *
 * A mean gap lets a sign flip between subpopulations cancel to zero and read as calibration. So:
 *
 *   · `meanGap`, `meanAbsGap` and the three-way direction mix are ONE block ({@link BiasBlock}) and
 *     are unreachable separately, so the mean can never be printed alone. The three direction rates
 *     share ONE denominator and sum to it, which is what makes "45% over, 45% under" impossible to
 *     mistake for "mean ~0, calibrated".
 *   · every block is also produced per REGIME, through the existing `Segmented<T>` from
 *     `classifier_eval_score.ts`, so a whole-corpus figure is unreachable without its segments.
 *   · and per CONFIDENCE BIN over `DEFAULT_CONFIDENCE_BOUNDARIES`, so `CLASSIFY_CONFIDENCE_FLOOR`
 *     is a bin edge. With the bulk of this corpus reporting one confidence value, the confidence
 *     axis is where a flip would hide.
 *
 * ## The resolution band
 *
 * With n draws, an empirical frequency can only land on multiples of 1/n, so the finest difference
 * the measurement can resolve is half of that. Gaps inside +/-1/(2n) are `indistinguishable` —
 * NOT "calibrated", which would claim something the resolution cannot support. At n = 10 that band
 * is +/-0.05, which means a 0.95 self-report against a 1.0 observed frequency is honestly
 * indistinguishable, and {@link BiasDirection} says so in its own name.
 */

import type { UserPromptRow } from "../db/minima_db.ts";
import {
  DEFAULT_SAMPLES,
  REGIME_BOUNDARY_TS,
  type Rate,
  cutPoints,
  formatRate,
  rate,
} from "./classifier_eval.ts";
import {
  DEFAULT_CONFIDENCE_BOUNDARIES,
  MIN_REPORTABLE_SUPPORT,
  type RegimeSegment,
  type Segmented,
  type SegmentedPrompt,
  type Supported,
  formatSupported,
  formatSupportedCompact,
  segmentCorpus,
  supported,
} from "./classifier_eval_score.ts";
import {
  SAMPLED_MODEL,
  SAMPLING_TEMPERATURE,
  type SamplerVerdict,
  type StoredSelfConsistencySample,
  checkSamplerNonDegenerate,
  isReadableSample,
  pilotEntries,
} from "./classifier_self_consistency.ts";
import { CLASSIFY_CONFIDENCE_FLOOR } from "./classify.ts";

// ---------------------------------------------------------------------------
// The input. Narrow on purpose — see the module docstring.
// ---------------------------------------------------------------------------

/**
 * Everything this readout reads: the raw ledger prompt rows, and the draws.
 *
 * No votes, no replay labels, no routing decisions. AC 4 is "runs with no reference labels", and
 * the honest way to hold that is a type with nowhere to put one.
 */
export interface SelfConsistencyInput {
  readonly corpus: readonly UserPromptRow[];
  readonly samples: readonly StoredSelfConsistencySample[];
}

/** What the report is told about the run that produced the draws. */
export interface SelfConsistencyConfig {
  readonly scope: string;
  /** The EFFECTIVE n, after `--samples`' fallback and floor. Printed beside every figure. */
  readonly samples: number;
  readonly corpusRev: string;
  readonly modelId?: string;
  readonly hashOf: (text: string) => string;
  readonly regimeBoundaryTs?: number;
  readonly confidenceBoundaries?: readonly number[];
}

// ---------------------------------------------------------------------------
// Direction of bias. The sign IS the answer (AC 3).
// ---------------------------------------------------------------------------

/**
 * Which way the self-report misses.
 *
 * `indistinguishable` is deliberately not called `calibrated`. A gap inside the resolution band has
 * not been shown to be zero; it has been shown to be smaller than n draws can resolve, and those
 * are different claims. Naming this arm `calibrated` would let a readout at n = 2 — band +/-0.25 —
 * describe almost everything as calibrated and be quoted as having measured it.
 */
export type BiasDirection = "overconfident" | "underconfident" | "indistinguishable";

/**
 * The half-width of the band a gap must exceed to have a direction: 1/(2n).
 *
 * An empirical frequency over n draws lands only on multiples of 1/n, so 1/(2n) is the finest
 * distinction the instrument supports. It widens as n falls, which is the point: a shallower run
 * does not get more certain about direction, it gets less.
 */
export function resolutionBand(samples: number): number {
  return samples > 0 ? 1 / (2 * samples) : 1;
}

/**
 * Round to the micro, before any comparison against the band.
 *
 * Not cosmetic. `0.95 - 1.0` is `-0.050000000000000044` in IEEE 754, which is strictly outside a
 * band of 0.05 — so the exact case the brief calls out as honestly indistinguishable would be
 * reported as `underconfident` by a bare comparison, on the most common self-report in this corpus.
 * The same rounding the cost estimator uses, for the same reason: float noise must not reach a
 * reported number.
 */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Bucket a signed gap against the band. Boundary INCLUSIVE: |gap| == band is indistinguishable. */
export function directionOf(gap: number, band: number): BiasDirection {
  const g = round6(gap);
  if (g > band) return "overconfident";
  if (g < -band) return "underconfident";
  return "indistinguishable";
}

// ---------------------------------------------------------------------------
// Per prompt (AC 2).
// ---------------------------------------------------------------------------

/**
 * One corpus entry's draws, reduced.
 *
 * Identified by a HASH PREFIX and never by its text: the corpus is the owner's own development
 * traffic and nothing in this lane may put it in a readout, a file or a payload.
 *
 * The denominator of every frequency here is the DRAWS THAT LANDED — labelled and abstained
 * together. An abstention is a real outcome of the predictive distribution ("it declined") and
 * dropping it from the denominator would let a model that answers three times in ten report a
 * perfect 3/3 self-consistency. It cannot be the modal LABEL, though: declining is not a label, so
 * a prompt whose draws all abstained has no modal label and contributes to no gap.
 */
export interface PromptSelfConsistency {
  readonly hashPrefix: string;
  readonly segment: RegimeSegment;
  /** Draws stored and still readable. At the default n this is exactly MIN_REPORTABLE_SUPPORT. */
  readonly draws: number;
  readonly abstentions: number;
  /** `task_type/difficulty`, or null when no draw produced a label. */
  readonly modalPair: string | null;
  /** PRIMARY comparand: modal (task_type, difficulty) frequency over all draws. */
  readonly pairFrequency: Supported;
  readonly modalTaskType: string | null;
  /** SECONDARY: modal task type alone. Always >= {@link pairFrequency}. */
  readonly taskTypeFrequency: Supported;
  /** Two or more pairs tied for modal. The frequency is unaffected; which label is named is not. */
  readonly tied: boolean;
  /** Mean RAW self-report over the labelled draws — the number it reports about itself. */
  readonly selfReport: number | null;
  /** SIGNED: selfReport - pairFrequency. Positive = claims more certainty than it shows. */
  readonly gap: number | null;
  /** The same gap against the secondary comparand, so the understatement can be seen. */
  readonly taskTypeGap: number | null;
  readonly direction: BiasDirection | null;
}

/** The modal value of a multiset, with ties broken lexicographically so a rerun names the same one. */
function modal(values: readonly string[]): { value: string | null; count: number; tied: boolean } {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let count = 0;
  let tied = false;
  for (const [value, n] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (n > count) {
      best = value;
      count = n;
      tied = false;
    } else if (n === count && best !== null) {
      tied = true;
    }
  }
  return { value: best, count, tied };
}

const PAIR_SEP = "/";

/** Reduce one entry's draws. Total: no draws yields nulls rather than a divide by zero. */
function reduceDraws(
  entry: SegmentedPrompt,
  draws: readonly StoredSelfConsistencySample[],
  hash: string,
  band: number,
): PromptSelfConsistency {
  const labelled = draws.filter((d) => d.task_type !== null);
  const pairs = labelled.map((d) => `${d.task_type}${PAIR_SEP}${d.difficulty ?? "-"}`);
  const types = labelled.map((d) => d.task_type as string);
  const pair = modal(pairs);
  const type = modal(types);
  const d = draws.length;
  const confidences = labelled
    .map((x) => x.confidence)
    .filter((c): c is number => c !== null && Number.isFinite(c));
  const selfReport =
    confidences.length > 0
      ? round6(confidences.reduce((n, c) => n + c, 0) / confidences.length)
      : null;
  const pairFreq = d > 0 && pair.value !== null ? pair.count / d : null;
  const typeFreq = d > 0 && type.value !== null ? type.count / d : null;
  const gap = selfReport !== null && pairFreq !== null ? round6(selfReport - pairFreq) : null;
  return {
    hashPrefix: hash.slice(0, 12),
    segment: entry.segment,
    draws: d,
    abstentions: d - labelled.length,
    modalPair: pair.value,
    pairFrequency: supported(rate(pair.value === null ? 0 : pair.count, d)),
    modalTaskType: type.value,
    taskTypeFrequency: supported(rate(type.value === null ? 0 : type.count, d)),
    tied: pair.tied,
    selfReport,
    gap,
    taskTypeGap: selfReport !== null && typeFreq !== null ? round6(selfReport - typeFreq) : null,
    direction: gap === null ? null : directionOf(gap, band),
  };
}

// ---------------------------------------------------------------------------
// Aggregation (AC 2, AC 3).
// ---------------------------------------------------------------------------

/**
 * The gap, three ways, in ONE value — so the mean is unreachable on its own.
 *
 * The three direction rates share the SAME denominator and sum to it exactly. That is the guard: a
 * population that is half overconfident and half underconfident has a mean gap of about zero, and
 * the only thing that stops that reading as calibration is seeing the mix beside it.
 */
export interface BiasBlock {
  /** The one denominator. Prompts with both a self-report and a modal label. */
  readonly prompts: number;
  readonly meanGap: number | null;
  readonly meanAbsGap: number | null;
  readonly over: Supported;
  readonly under: Supported;
  readonly indistinguishable: Supported;
  readonly band: number;
  /** Aggregate modal-label frequency: modal draws over ALL draws. PRIMARY (the pair). */
  readonly modalFrequency: Supported;
  /** The same, over task type alone. SECONDARY, and always >= {@link modalFrequency}. */
  readonly modalTaskTypeFrequency: Supported;
  /**
   * The mean gap against the SECONDARY comparand. Printed beside {@link meanGap} so trap 5 is
   * quantified rather than asserted: it is always the smaller of the two, and the difference is
   * exactly how much overconfidence a task-type-only reading would have hidden.
   */
  readonly meanTaskTypeGap: number | null;
  /** Mean self-report over the same prompts, so the gap can be re-derived from the output. */
  readonly meanSelfReport: number | null;
}

/** Aggregate a population of prompts. Total over an empty population. */
export function biasBlock(
  entries: readonly PromptSelfConsistency[],
  band: number,
  minSupport: number = MIN_REPORTABLE_SUPPORT,
): BiasBlock {
  const withGap = entries.filter((e) => e.gap !== null);
  const d = withGap.length;
  const mean = (xs: readonly number[]): number | null =>
    xs.length === 0 ? null : round6(xs.reduce((n, x) => n + x, 0) / xs.length);
  const count = (dir: BiasDirection): Supported =>
    supported(rate(withGap.filter((e) => e.direction === dir).length, d), minSupport);
  const totalDraws = entries.reduce((n, e) => n + e.draws, 0);
  return {
    prompts: d,
    meanGap: mean(withGap.map((e) => e.gap as number)),
    meanAbsGap: mean(withGap.map((e) => Math.abs(e.gap as number))),
    over: count("overconfident"),
    under: count("underconfident"),
    indistinguishable: count("indistinguishable"),
    band,
    modalFrequency: supported(
      rate(
        entries.reduce((n, e) => n + e.pairFrequency.rate.n, 0),
        totalDraws,
      ),
      minSupport,
    ),
    modalTaskTypeFrequency: supported(
      rate(
        entries.reduce((n, e) => n + e.taskTypeFrequency.rate.n, 0),
        totalDraws,
      ),
      minSupport,
    ),
    meanTaskTypeGap: mean(
      withGap.filter((e) => e.taskTypeGap !== null).map((e) => e.taskTypeGap as number),
    ),
    meanSelfReport: mean(withGap.map((e) => e.selfReport as number)),
  };
}

/**
 * Apply one aggregation per regime and to the corpus entire.
 *
 * `classifier_eval_score.ts`'s `bySegment` is over `ScoredEntry`, which this lane has none of — it
 * scores nothing against anything. The `Segmented<T>` SHAPE is what matters and is imported rather
 * than redeclared, so a whole-corpus figure remains unreachable without its segments here too.
 */
export function bySelfSegment<T>(
  entries: readonly PromptSelfConsistency[],
  f: (entries: readonly PromptSelfConsistency[]) => T,
): Segmented<T> {
  const of = (s: RegimeSegment): T => f(entries.filter((e) => e.segment === s));
  return { before: of("before"), after: of("after"), spanning: of("spanning"), whole: f(entries) };
}

/** One confidence bin of the bias readout. Lower-inclusive, upper-exclusive, top bin open. */
export interface ConfidenceBiasBin {
  readonly label: string;
  readonly minConfidence: number;
  readonly maxConfidenceExclusive: number | null;
  readonly bias: BiasBlock;
}

/**
 * Bin the prompts by the confidence the classifier reported, over the shipped boundaries.
 *
 * `CLASSIFY_CONFIDENCE_FLOOR` is one of those boundaries, so the floor in force is a bin edge and
 * the bin straddling it cannot mix self-reports production accepts with ones it drops. This is the
 * axis a cancelling sign flip is most likely to hide on: the corpus's self-reports are clustered
 * hard at the top, so one confident subpopulation biased one way and a thin low-confidence one
 * biased the other averages to nothing on the whole-corpus line.
 */
export function confidenceBiasBins(
  entries: readonly PromptSelfConsistency[],
  band: number,
  boundaries: readonly number[] = DEFAULT_CONFIDENCE_BOUNDARIES,
): ConfidenceBiasBin[] {
  const edges = [0, ...cutPoints(boundaries, 1)];
  return edges.map((minConfidence, i) => {
    const next = edges[i + 1] ?? null;
    const inBin = entries.filter(
      (e) =>
        e.selfReport !== null &&
        e.selfReport >= minConfidence &&
        (next === null || e.selfReport < next),
    );
    const label =
      next === null
        ? `>=${minConfidence.toFixed(2)}`
        : minConfidence === 0
          ? `<${next.toFixed(2)}`
          : `${minConfidence.toFixed(2)}-<${next.toFixed(2)}`;
    return { label, minConfidence, maxConfidenceExclusive: next, bias: biasBlock(inBin, band) };
  });
}

// ---------------------------------------------------------------------------
// The whole report.
// ---------------------------------------------------------------------------

/** Draws the join set aside, each for a different reason and none of them silently. */
export interface SampleCoverage {
  /** Corpus entries with at least one readable draw, over the corpus. */
  readonly entriesSampled: Rate;
  /** Draws stored and readable, over corpus x n — the completeness of the lane. */
  readonly drawsPresent: Rate;
  /** Rows describing another corpus revision. Absent, not stale-but-usable (ADR 0001). */
  readonly rowsAtOtherRev: number;
  /** Rows from a model this readout is not about. */
  readonly rowsOutsideModel: number;
  /** Rows at this revision whose prompt is not in the live corpus. Unreadable by construction. */
  readonly rowsWithoutCorpusEntry: number;
  /** Rows the shipped parser would no longer re-admit — a taxonomy that moved under the cache. */
  readonly rowsUnreadable: number;
  /** Entries with draws but no labelled draw at all: it answered every time, and declined. */
  readonly entriesAllAbstained: number;
  /** Distinct `temperature` values actually recorded. AC 1's "recorded", read back, not asserted. */
  readonly temperaturesRecorded: readonly string[];
}

export interface SelfConsistencyReport {
  readonly scope: string;
  readonly corpusRev: string;
  readonly modelId: string;
  /** The EFFECTIVE n. Printed on every figure so a fallback or a clamp is visible. */
  readonly samples: number;
  readonly band: number;
  readonly temperature: string;
  /** The pilot's verdict. Not `ok` means the renderer prints an abort banner, not a headline. */
  readonly sampler: SamplerVerdict;
  readonly coverage: SampleCoverage;
  readonly perPrompt: readonly PromptSelfConsistency[];
  readonly bias: Segmented<BiasBlock>;
  readonly byConfidence: readonly ConfidenceBiasBin[];
}

/**
 * Build the report from ledger rows and the live corpus.
 *
 * The draws come back keyed by HASH — the text is never stored (ADR 0009) — so the only direction
 * the join can run is re-hashing the live corpus text with the same `promptHash` the panel, the
 * replay and the sampler all use. It is injected for that reason: a second implementation would be
 * a total cache miss reported as "the classifier has never been sampled".
 */
export function buildSelfConsistencyReport(
  input: SelfConsistencyInput,
  cfg: SelfConsistencyConfig,
): SelfConsistencyReport {
  const modelId = cfg.modelId ?? SAMPLED_MODEL.model.id;
  const band = resolutionBand(cfg.samples);
  const corpus = segmentCorpus(input.corpus, cfg.regimeBoundaryTs ?? REGIME_BOUNDARY_TS);

  const byHash = new Map<string, StoredSelfConsistencySample[]>();
  // The rows that survived every filter. The sampler check runs over THESE, never over the raw
  // input: a draw at another corpus revision that happened to differ would otherwise vouch for a
  // sampler this revision has no evidence about at all.
  const usable: StoredSelfConsistencySample[] = [];
  let rowsAtOtherRev = 0;
  let rowsOutsideModel = 0;
  let rowsUnreadable = 0;
  const temperatures = new Set<string>();
  for (const row of input.samples) {
    if (row.corpus_rev !== cfg.corpusRev) {
      rowsAtOtherRev += 1;
      continue;
    }
    if (row.model_id !== modelId) {
      rowsOutsideModel += 1;
      continue;
    }
    if (!isReadableSample(row)) {
      rowsUnreadable += 1;
      continue;
    }
    temperatures.add(row.temperature);
    usable.push(row);
    const cell = byHash.get(row.prompt_hash) ?? [];
    cell.push(row);
    byHash.set(row.prompt_hash, cell);
  }

  const liveHashes = new Set<string>();
  const perPrompt: PromptSelfConsistency[] = [];
  let entriesSampled = 0;
  let drawsPresent = 0;
  let entriesAllAbstained = 0;
  for (const entry of corpus) {
    const hash = cfg.hashOf(entry.text);
    liveHashes.add(hash);
    const draws = byHash.get(hash) ?? [];
    if (draws.length === 0) continue;
    entriesSampled += 1;
    drawsPresent += draws.length;
    const reduced = reduceDraws(entry, draws, hash, band);
    if (reduced.modalPair === null) entriesAllAbstained += 1;
    perPrompt.push(reduced);
  }
  let rowsWithoutCorpusEntry = 0;
  for (const hash of byHash.keys()) if (!liveHashes.has(hash)) rowsWithoutCorpusEntry += 1;

  return {
    scope: cfg.scope,
    corpusRev: cfg.corpusRev,
    modelId,
    samples: cfg.samples,
    band,
    temperature: SAMPLING_TEMPERATURE,
    sampler: checkSamplerNonDegenerate(pilotEntries(corpus), usable, {
      modelId,
      hashOf: cfg.hashOf,
    }),
    coverage: {
      entriesSampled: rate(entriesSampled, corpus.length),
      drawsPresent: rate(drawsPresent, corpus.length * cfg.samples),
      rowsAtOtherRev,
      rowsOutsideModel,
      rowsWithoutCorpusEntry,
      rowsUnreadable,
      entriesAllAbstained,
      temperaturesRecorded: [...temperatures].sort(),
    },
    perPrompt,
    bias: bySelfSegment(perPrompt, (e) => biasBlock(e, band)),
    byConfidence: confidenceBiasBins(perPrompt, band, cfg.confidenceBoundaries),
  };
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

/**
 * The limitation, in the words the ticket states it in (AC 6).
 *
 * A constant rather than inline prose so a test can assert the exact claim reaches the output, and
 * so it cannot be edited into something weaker in one renderer and not another.
 */
export const SELF_CONSISTENCY_LIMITS: readonly string[] = [
  "What this measures, and what it does NOT:",
  "  · This measures SELF-CONSISTENCY, not CORRECTNESS. A model that is consistently wrong looks",
  "    perfectly calibrated by this metric alone — ten identical wrong answers score 1.0. Nothing",
  "    here reads a reference label, by design, which is what lets it run on unlabelled traffic",
  "    and is also exactly why it cannot speak to accuracy. Correctness against the reference",
  "    panel is --score's answer, and the two are complementary rather than substitutes.",
  "  · The self-report is a claim about BOTH labels (CLASSIFY_SYSTEM: 'confidence is how sure you",
  "    are of BOTH labels'), so the modal (task_type, difficulty) PAIR frequency is the primary",
  "    comparand. Task-type-alone is printed beside it and is always >= it; quoting that one as",
  "    the headline would systematically understate overconfidence.",
  "  · A gap inside the resolution band is 'indistinguishable', NOT 'calibrated'. It has not been",
  "    shown to be zero, only smaller than n draws can resolve. At n=10 the band is +/-0.05, so a",
  "    0.95 self-report against a 1.0 observed frequency is honestly indistinguishable.",
  "  · Draws are taken at the PROVIDER DEFAULT temperature, unset — the same request production",
  "    sends. No temperature was set anywhere, so this is the actual production distribution and",
  "    not a synthetic one. The pilot is what verifies the calls vary at all.",
];

/** A signed figure, with the sign always shown — the sign is the finding. */
function signed(n: number | null): string {
  return n === null ? "—" : (n >= 0 ? "+" : "") + n.toFixed(4);
}

/** One bias block, printed whole. The mean is never reachable without the mix beside it. */
function biasLines(b: BiasBlock, indent = "  "): string[] {
  return [
    `${indent}prompts compared           ${b.prompts}`,
    `${indent}mean self-report           ${b.meanSelfReport === null ? "—" : b.meanSelfReport.toFixed(4)}`,
    `${indent}modal freq (PAIR, primary) ${formatSupported(b.modalFrequency)}`,
    `${indent}modal freq (task type)     ${formatSupported(b.modalTaskTypeFrequency)}   secondary, >= primary`,
    `${indent}mean gap (signed, PRIMARY) ${signed(b.meanGap)}`,
    `${indent}mean gap vs task type      ${signed(b.meanTaskTypeGap)}   secondary, <= primary — the`,
    `${indent}                           difference is what a task-type-only reading would hide`,
    `${indent}mean ABSOLUTE gap          ${signed(b.meanAbsGap)}`,
    `${indent}direction mix (band +/-${b.band.toFixed(3)}, one denominator, sums to the whole)`,
    `${indent}  overconfident            ${formatSupported(b.over)}`,
    `${indent}  underconfident           ${formatSupported(b.under)}`,
    `${indent}  indistinguishable        ${formatSupported(b.indistinguishable)}`,
  ];
}

/** Four segment columns on one line, so a whole-corpus figure never prints on its own. */
function segLine(label: string, s: Segmented<string>): string {
  const cell = (t: string): string => t.padEnd(24);
  return (
    `  ${label.padEnd(26)}${cell(`before ${s.before}`)}${cell(`after ${s.after}`)}` +
    `${cell(`spanning ${s.spanning}`)}whole ${s.whole}`
  );
}

function mapSeg<T>(s: Segmented<T>, f: (t: T) => string): Segmented<string> {
  return { before: f(s.before), after: f(s.after), spanning: f(s.spanning), whole: f(s.whole) };
}

/**
 * Render the report.
 *
 * When the sampler's verdict is not `ok`, an ABORT BANNER replaces the headline figure. Printing a
 * modal frequency under a degenerate sampler would be printing 1.0 and calling it calibration; the
 * banner says which of the two happened. Everything below the headline still prints, because the
 * coverage counts are what a reader needs to diagnose it.
 */
export function renderSelfConsistencyReport(r: SelfConsistencyReport): string {
  const w = r.bias.whole;
  const lines: string[] = [
    "Classifier self-consistency (MUB-217) — is the self-reported number honest?",
    `scope: ${r.scope}`,
    "",
    "Run",
    `  corpus revision              ${r.corpusRev}`,
    `  model sampled                ${r.modelId}`,
    `  samples per prompt (n)       ${r.samples}   (effective, after --samples' fallback and floor)`,
    `  temperature                  ${r.temperature}`,
    `  temperature recorded on rows ${r.coverage.temperaturesRecorded.join(" · ") || "—"}`,
    `  resolution band              +/-${r.band.toFixed(4)}  = 1/(2n)`,
    `  corpus entries sampled       ${formatRate(r.coverage.entriesSampled)}`,
    `  draws present                ${formatRate(r.coverage.drawsPresent)}`,
    "",
  ];

  if (r.sampler.kind === "ok") {
    lines.push(
      "Sampler check (pilot: the first 10 corpus entries, first-appearance order)",
      `  pilot prompts that VARIED    ${formatRate(r.sampler.varying)} over ${r.sampler.draws} draws`,
      "  Verdict: OK — the draws vary, so a modal frequency below 1.0 is a measurement.",
      "",
      "HEADLINE",
      `  modal-label frequency (PAIR) ${formatSupported(w.modalFrequency)}   <- its true predictive distribution`,
      `  mean self-report             ${w.meanSelfReport === null ? "—" : w.meanSelfReport.toFixed(4)}   <- the number it reports about itself`,
      `  mean gap (self - empirical)  ${signed(w.meanGap)}   ${w.meanGap === null ? "" : `(${directionOf(w.meanGap, r.band)} on average)`}`,
      "  A mean alone would let a sign flip cancel to zero and read as calibration. The full",
      "  block, the regime segments and the confidence bins below are all required reading.",
    );
  } else if (r.sampler.kind === "no-samples") {
    lines.push(
      "⚠ ABORT — NO DRAWS AT THIS CORPUS REVISION.",
      "  Nothing has been sampled, so there is no headline figure and none is printed. An empty",
      "  cache is not a finding about the classifier: a modal frequency computed over zero draws",
      "  would be a division by nothing dressed as perfect self-consistency.",
      `  Authorize the pilot with:  --spend --max-usd=<ceiling> --pilot --samples=${r.samples}`,
    );
  } else {
    lines.push(
      "⚠ ABORT — THE SAMPLER LOOKS DEGENERATE. THE FULL RUN IS NOT AUTHORIZED.",
      `  pilot prompts that VARIED    ${formatRate(r.sampler.varying)} over ${r.sampler.draws} draws`,
      `  required                     at least ${r.sampler.threshold}`,
      "  Fewer than the required number of pilot prompts produced two distinct draws, so",
      "  'perfect self-consistency' here is INDISTINGUISHABLE from 'we did not really sample'.",
      "  No headline figure is printed, because the only one available would be 1.0 by",
      "  construction. Diagnose the sampler before buying the rest of the corpus.",
    );
  }

  lines.push(
    "",
    "Gap, whole corpus — mean, mean-absolute and the direction mix, in one block",
    ...biasLines(w),
    "",
    "By regime (the boundary is the shipped REGIME_BOUNDARY_TS)",
    segLine(
      "mean gap",
      mapSeg(r.bias, (b) => signed(b.meanGap)),
    ),
    segLine(
      "mean ABS gap",
      mapSeg(r.bias, (b) => signed(b.meanAbsGap)),
    ),
    segLine(
      "overconfident",
      mapSeg(r.bias, (b) => formatSupportedCompact(b.over)),
    ),
    segLine(
      "underconfident",
      mapSeg(r.bias, (b) => formatSupportedCompact(b.under)),
    ),
    segLine(
      "indistinguishable",
      mapSeg(r.bias, (b) => formatSupportedCompact(b.indistinguishable)),
    ),
    segLine(
      "modal freq (PAIR)",
      mapSeg(r.bias, (b) => formatSupportedCompact(b.modalFrequency)),
    ),
    "",
    `By self-reported confidence (edges include CLASSIFY_CONFIDENCE_FLOOR = ${CLASSIFY_CONFIDENCE_FLOOR})`,
    `  ${"bin".padEnd(14)}${"prompts".padEnd(9)}${"mean gap".padEnd(12)}${"mean |gap|".padEnd(12)}` +
      `${"over".padEnd(12)}${"under".padEnd(12)}${"indist.".padEnd(12)}modal freq`,
  );
  for (const bin of r.byConfidence) {
    const b = bin.bias;
    lines.push(
      `  ${bin.label.padEnd(14)}${String(b.prompts).padEnd(9)}${signed(b.meanGap).padEnd(12)}` +
        `${signed(b.meanAbsGap).padEnd(12)}${formatSupportedCompact(b.over).padEnd(12)}` +
        `${formatSupportedCompact(b.under).padEnd(12)}` +
        `${formatSupportedCompact(b.indistinguishable).padEnd(12)}` +
        `${formatSupportedCompact(b.modalFrequency)}`,
    );
  }

  lines.push(
    "",
    "Per prompt (identified by hash prefix — the prompt text appears nowhere in this readout)",
    `  ${"prompt".padEnd(14)}${"seg".padEnd(10)}${"modal pair freq".padEnd(18)}` +
      `${"task-type freq".padEnd(18)}${"self-report".padEnd(13)}${"gap".padEnd(11)}direction`,
  );
  const ordered = [...r.perPrompt].sort(
    (a, b) => (b.gap ?? Number.NEGATIVE_INFINITY) - (a.gap ?? Number.NEGATIVE_INFINITY),
  );
  for (const p of ordered) {
    lines.push(
      `  ${p.hashPrefix.padEnd(14)}${p.segment.padEnd(10)}` +
        `${formatSupportedCompact(p.pairFrequency).padEnd(18)}` +
        `${formatSupportedCompact(p.taskTypeFrequency).padEnd(18)}` +
        `${(p.selfReport === null ? "—" : p.selfReport.toFixed(3)).padEnd(13)}` +
        `${signed(p.gap).padEnd(11)}${p.direction ?? "—"}${p.tied ? "  (modal tie)" : ""}`,
    );
  }
  if (r.perPrompt.length === 0) lines.push("  (no corpus entry has a draw at this revision)");

  lines.push(
    "",
    "Coverage — what the join set aside, and why",
    `  rows at another corpus rev   ${r.coverage.rowsAtOtherRev}  (a different corpus, so absent)`,
    `  rows from another model      ${r.coverage.rowsOutsideModel}`,
    `  rows whose prompt is gone    ${r.coverage.rowsWithoutCorpusEntry}  (hash is one-way — unreadable)`,
    `  rows the parser refused      ${r.coverage.rowsUnreadable}  (taxonomy moved; re-opened to the planner)`,
    `  entries that only abstained  ${r.coverage.entriesAllAbstained}  (answered every draw, declined every draw)`,
    "",
    ...SELF_CONSISTENCY_LIMITS,
    "",
    `A per-prompt figure marked † has a denominator under ${MIN_REPORTABLE_SUPPORT}, so its percentage is`,
    `suppressed. At the default n=${10} the per-prompt denominator is exactly that bar, which is why`,
    "--samples below 10 makes every per-prompt figure unreportable. No readout softens that by",
    "passing a lower support bar.",
  );
  return lines.join("\n");
}
