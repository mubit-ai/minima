/**
 * Self-consistency sampling (MUB-217) — is the classifier's self-reported number honest?
 *
 * The ticket's question, in one line: **a measurement of whether the classifier's self-reported
 * certainty reflects its own actual uncertainty, using no reference labels at all.** Sample the
 * classifier repeatedly on the same prompt, take the empirical frequency of its modal label as its
 * true predictive distribution, and compare the number it reports about itself against that
 * frequency. No panel, no gold labels, no MUB-216 votes reach this lane — which is what makes it
 * runnable against traffic nobody has paid to label.
 *
 * **What this does NOT measure, stated here and printed in every readout:** self-consistency is not
 * correctness. A model that is consistently wrong looks perfectly calibrated by this metric alone.
 * The metric answers "does it repeat itself", and repeating a wrong answer ten times out of ten is
 * a 1.0. Correctness against a reference is MUB-218's `--score`, and the two are complementary
 * rather than substitutes.
 *
 * Four things here exist because each of them, done the obvious way, produces a number that looks
 * like a finding and is not:
 *
 *   · **The classifier memoizes per instance.** `TaskClassifier` caches on `Bun.hash(task)`, so ten
 *     draws from one instance are one call and nine memo hits: perfect self-consistency, zero
 *     evidence. {@link makeReplayCaller} constructs a FRESH classifier per call for exactly this
 *     reason and is imported UNCHANGED rather than re-implemented. `tests/classifier-self-
 *     consistency.test.ts` counts constructions — ten draws must construct ten classifiers.
 *   · **A degenerate sampler is indistinguishable from a perfect one.** If the calls do not actually
 *     vary, "1.0 self-consistency" and "we did not really sample" produce the same output. So the
 *     lane has a PILOT — {@link pilotEntries}, the first ten corpus entries in first-appearance
 *     order — and {@link checkSamplerNonDegenerate} returns a verdict on it. Fewer than
 *     {@link PILOT_MIN_VARYING} of those prompts showing at least two distinct draws means the full
 *     run is NOT authorized, and the renderer prints an abort banner instead of a headline figure.
 *   · **A shared key silently overwrites.** Both existing caches key on `(prompt_hash, model_id)`
 *     and upsert, so a resample replaces its predecessor with no error. This lane's key carries the
 *     draw index (ADR 0009), and the ledger method is its own.
 *   · **No temperature is set.** Deliberately, and it is not an oversight to be fixed: Anthropic and
 *     OpenAI both default to 1.0 when temperature is unset and production sets none either, so
 *     drawing at the unset default measures the ACTUAL production distribution rather than a
 *     synthetic one. Nothing in the provider layer is touched. What is recorded is the string
 *     {@link SAMPLING_TEMPERATURE}, and the pilot is what verifies empirically that the calls vary.
 *
 * This is NOT consensus and the panel's machinery cannot be pointed at it (trap 4 of the brief,
 * ADR 0009). `deriveConsensus` de-duplicates votes by `modelId` — last wins — and `consensusRuleFor`
 * binds `panelSize` to the panel's length, so ten draws from one model would reduce to one vote
 * against a panel size of three and come back `incomplete`, forever. Consensus asks "did independent
 * models agree"; this asks "does one model repeat itself". Different question, different machinery,
 * and ADR 0001's "one function derives consensus" survives untouched precisely because this is not
 * consensus.
 *
 * Everything here is pure except {@link runSampling}, which takes its caller, its ledger and its
 * guard as arguments — so the whole billable path is exercised by a fake that spends fake money.
 */

import type { SelfConsistencySampleRow } from "../db/minima_db.ts";
import {
  type CallSpec,
  type CostEstimate,
  type CostLine,
  type DistinctPrompt,
  LABEL_INSTRUCTION_TOKENS,
  type Rate,
  estimateRunCost,
  formatRate,
  rate,
} from "./classifier_eval.ts";
import {
  REPLAY_MODELS,
  type ReplayCallOutcome,
  type ReplayCaller,
  type ReplayFailureCause,
  type ReplayModel,
  type ReplayRunResult,
  type ReplaySpendGuard,
  isReadableReplayLabel,
} from "./classifier_replay.ts";

// ---------------------------------------------------------------------------
// What is sampled, how often, and under what.
// ---------------------------------------------------------------------------

/**
 * The temperature this lane records — a STRING, and the literal absence of a setting.
 *
 * No call here passes a temperature and no adapter gained a knob for one. Both providers in the
 * registry default to 1.0 when it is unset, and the shipped `classify()` sets none, so the draws
 * taken at the unset default ARE production's distribution. A lane that set `temperature: 1.0`
 * explicitly would measure something production never sends while looking identical, and a lane
 * that set anything else would measure a distribution that does not exist outside this script.
 *
 * Recorded on every row rather than assumed, so a future run at an explicit temperature is a
 * different value in the same column instead of an indistinguishable one.
 */
export const SAMPLING_TEMPERATURE = "provider default, unset";

/**
 * The model sampled: the SHIPPED DEFAULT classifier, taken from MUB-218's replay set rather than
 * re-declared.
 *
 * `REPLAY_MODELS[0]` is the model `cli/main.ts` builds the production `TaskClassifier` from, and
 * every price and output allowance travels with it. Copying those fields here would be a second
 * declaration of a price, stale the first time the registry moved — and this lane's projection is
 * what a `--max-usd` gets chosen against. Pinned to `REPLAY_MODELS[0]` by test.
 *
 * ONE model, not both. The ticket asks whether THE classifier's self-report is honest, and the
 * self-report of a model production does not run is a different question (MUB-218's `--score` is
 * where the model comparison lives). It is also 2x the money for an answer about a model nobody
 * ships.
 */
export const SAMPLED_MODEL: ReplayModel = REPLAY_MODELS[0]!;

/**
 * Corpus entries the pilot draws on: the FIRST TEN, in first-appearance order.
 *
 * Deterministic on purpose, and the determinism is worth money. A random pilot would be a cache
 * miss on every re-run and its spend would buy nothing the full run could use; this one re-runs as
 * a cache hit, and its ~100 draws PREPAY the same ~100 draws of the full lane. The order is
 * `distinctPrompts`'s own first-appearance order, so "the first ten" is a property of the corpus
 * rather than of when the pilot happened to run.
 */
export const PILOT_ENTRIES = 10;

/**
 * The pilot's ABORT CRITERION: at least this many pilot prompts must show two or more distinct
 * draws, or the full run is not authorized.
 *
 * Two, not one: a single varying prompt is one draw away from being noise, and two is the smallest
 * number that cannot be. Not a majority either — the criterion is falsifying "the sampler is
 * degenerate", not establishing "the classifier is uncertain everywhere". A classifier that really
 * is certain on eight of ten short prompts is a finding; a classifier that returns byte-identical
 * draws on all ten is a broken measurement, and only the second is what this rejects.
 */
export const PILOT_MIN_VARYING = 2;

// ---------------------------------------------------------------------------
// Keys. The draw index is IN the key — see ADR 0009.
// ---------------------------------------------------------------------------

/**
 * The identity of one DRAW: a prompt, the model that drew it, and which draw it was.
 *
 * Composed from `voteKey` applied twice rather than declaring a second separator: MUB-216's key
 * shape is the tree's one composite-key shape, and the delimiter it uses (a NUL, which appears in
 * no hex digest, no model id and no decimal integer) is stated exactly once, there. `sampleKey`
 * yields `hash\0modelId\0index`.
 *
 * Injected into {@link planSampling} rather than called by it, for the reason `planReplayRun` takes
 * its key producer injected: two implementations that ever disagreed would produce a total cache
 * miss and report it as "the classifier has never been sampled on this corpus".
 */
export function sampleKey(
  voteKeyOf: (hash: string, modelId: string) => string,
  hash: string,
  modelId: string,
  sampleIndex: number,
): string {
  return voteKeyOf(voteKeyOf(hash, modelId), String(sampleIndex));
}

// ---------------------------------------------------------------------------
// Planning a run: which draws are still owed, and what they would cost.
// ---------------------------------------------------------------------------

/** One draw still owed, carrying the key it will be stored under. */
export interface SampleWorkItem {
  readonly prompt: DistinctPrompt;
  readonly hash: string;
  readonly sampleIndex: number;
}

/** What a sampling run still owes, and how much of it is already in the ledger. */
export interface SamplingPlan {
  readonly model: ReplayModel;
  readonly samples: number;
  readonly todo: readonly SampleWorkItem[];
  readonly cached: number;
}

/**
 * What a sampling run still has to pay for.
 *
 * The unit of work is the DRAW, not the prompt: a prompt with seven of ten draws stored owes three,
 * and a run interrupted at draw seven resumes at eight rather than re-buying the corpus. That is
 * only true because the draw index is in the key — with the replay's key shape those seven rows
 * would be one row and the plan could not tell six missing draws from none.
 *
 * `cachedKeys` holds keys present AT THE CURRENT REVISION, so a revision bump is a cache miss
 * rather than a stale draw, exactly as it is for the panel and the replay.
 */
export function planSampling(
  prompts: readonly DistinctPrompt[],
  model: ReplayModel,
  samples: number,
  cachedKeys: ReadonlySet<string>,
  hashOf: (text: string) => string,
  keyOf: (hash: string, modelId: string, sampleIndex: number) => string,
): SamplingPlan {
  const todo: SampleWorkItem[] = [];
  let cached = 0;
  for (const prompt of prompts) {
    const hash = hashOf(prompt.text);
    for (let sampleIndex = 0; sampleIndex < samples; sampleIndex++) {
      if (cachedKeys.has(keyOf(hash, model.model.id, sampleIndex))) cached += 1;
      else todo.push({ prompt, hash, sampleIndex });
    }
  }
  return { model, samples, todo, cached };
}

/** The first {@link PILOT_ENTRIES} corpus entries, in first-appearance order. */
export function pilotEntries(prompts: readonly DistinctPrompt[]): DistinctPrompt[] {
  return prompts.slice(0, PILOT_ENTRIES);
}

/**
 * The cost leg for the sampling lane: `samples` calls per prompt, at the sampled model's own prices
 * and its own measured output allowance.
 *
 * This is the leg the dry run adds beside `panelCallSpecs` and `replayCallSpecs` (AC 5). Every call
 * pays `CLASSIFY_SYSTEM` — the same ~99 tokens, because it is literally the same instruction — and
 * a silently-defaulted zero there would understate input by nearly 7x against a ~17-token average
 * prompt. `outputTokensPerCall` comes from the model, which measured it at ~132 realized tokens per
 * call on MUB-218's first paid run; this lane multiplies that by ten, so understating it is ten
 * times as expensive here as it was there.
 */
export function selfConsistencyCallSpecs(
  samples: number,
  model: ReplayModel = SAMPLED_MODEL,
): CallSpec[] {
  return [
    {
      ...drawSpec(model, `self-consistency: ${model.model.id} x${samples}`),
      callsPerPrompt: samples,
    },
  ];
}

/** One draw's prices, stated once so the leg and the outstanding projection cannot disagree. */
function drawSpec(model: ReplayModel, label: string): CallSpec {
  return {
    label,
    callsPerPrompt: 1,
    inputUsdPerMTok: model.model.cost.input,
    outputUsdPerMTok: model.model.cost.output,
    fixedInputTokensPerCall: LABEL_INSTRUCTION_TOKENS,
    outputTokensPerCall: model.outputTokensPerCall,
  };
}

/** Project what the OUTSTANDING draws would cost — the figure the ceiling is checked against. */
export function projectSamplingCost(plan: SamplingPlan): CostEstimate {
  // Priced through the same `estimateRunCost` the dry run uses, so there is one arithmetic path and
  // the printed total can be re-derived by hand. One outstanding draw is one call, so the spec is
  // one-call-per-item and the multiplicity lives in the queue's length instead — which is what
  // makes a partially-cached prompt cost its MISSING draws rather than all of them.
  const spec = drawSpec(plan.model, `self-consistency: ${plan.model.model.id} (outstanding draws)`);
  const line = estimateRunCost(
    plan.todo.map((w) => w.prompt),
    [spec],
  ).lines[0] as CostLine;
  return {
    // DISTINCT prompts still owed a draw, not the number of draws — `totalCalls` is the draws.
    prompts: new Set(plan.todo.map((w) => w.hash)).size,
    lines: [line],
    totalCalls: line.calls,
    totalInputTokens: line.inputTokens,
    totalOutputTokens: line.outputTokens,
    totalUsd: line.usd,
  };
}

/** Project a WHOLE lane — every draw over these prompts, cached or not. */
export function projectSamplingLane(
  prompts: readonly DistinctPrompt[],
  samples: number,
  model: ReplayModel = SAMPLED_MODEL,
): CostEstimate {
  return estimateRunCost(prompts, selfConsistencyCallSpecs(samples, model));
}

/**
 * What a `--spend` run would pay this lane, and the two gross projections that never go stale.
 *
 * The FULL-LANE and PILOT projections are both carried, and both are printed on every invocation.
 * They answer different questions — "what would the whole thing cost from scratch" and "what does
 * the authorization step cost" — and a readout that printed only whichever one the current flags
 * selected would leave the other to drift unnoticed until someone quoted it.
 */
export interface SamplingOutstanding {
  readonly corpusRev: string;
  readonly modelId: string;
  readonly samples: number;
  readonly temperature: string;
  readonly corpusEntries: number;
  readonly pilotEntries: number;
  /** The prices every figure below was costed at, carried so the total can be re-derived by hand. */
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  /** Draws stored at this revision, over corpus x samples. A Rate, so the share carries its base. */
  readonly drawsCached: Rate;
  /** What `--spend` would pay for the whole lane right now. */
  readonly outstanding: CostEstimate;
  /** What `--spend --pilot` would pay right now. */
  readonly pilotOutstanding: CostEstimate;
  /** The whole lane from scratch, cache ignored. */
  readonly fullLane: CostEstimate;
  /** The whole pilot from scratch, cache ignored. */
  readonly pilotLane: CostEstimate;
}

export function summarizeSamplingOutstanding(
  plan: SamplingPlan,
  pilotPlan: SamplingPlan,
  prompts: readonly DistinctPrompt[],
  corpusRev: string,
): SamplingOutstanding {
  const pilot = pilotEntries(prompts);
  return {
    corpusRev,
    modelId: plan.model.model.id,
    samples: plan.samples,
    temperature: SAMPLING_TEMPERATURE,
    corpusEntries: prompts.length,
    pilotEntries: pilot.length,
    inputUsdPerMTok: plan.model.model.cost.input,
    outputUsdPerMTok: plan.model.model.cost.output,
    drawsCached: rate(plan.cached, prompts.length * plan.samples),
    outstanding: projectSamplingCost(plan),
    pilotOutstanding: projectSamplingCost(pilotPlan),
    fullLane: projectSamplingLane(prompts, plan.samples, plan.model),
    pilotLane: projectSamplingLane(pilot, plan.samples, plan.model),
  };
}

/** Render the sampling lane's outstanding work. Every price it was costed at travels with its leg. */
export function renderSamplingOutstanding(w: SamplingOutstanding): string {
  const lines = [
    "Classifier self-consistency sampling (MUB-217) — what --spend would pay this lane",
    `  corpus revision              ${w.corpusRev}`,
    `  model sampled                ${w.modelId}  (the shipped default classifier)`,
    `  samples per prompt (n)       ${w.samples}`,
    `  temperature                  ${w.temperature}`,
    `  draws cached at this rev     ${formatRate(w.drawsCached)}`,
    `  outstanding (full lane)      ${w.outstanding.totalCalls} calls · $${w.outstanding.totalUsd.toFixed(4)}`,
    `  outstanding (pilot only)     ${w.pilotOutstanding.totalCalls} calls · $${w.pilotOutstanding.totalUsd.toFixed(4)}`,
    "",
    "  Both gross projections, printed always so neither can go stale:",
  ];
  // Every price a leg was costed at travels WITH the leg, as the panel's and the replay's do: a
  // printed estimate a reviewer cannot re-derive by hand is as misleading as a bare percentage.
  const prices = `$${w.inputUsdPerMTok}/$${w.outputUsdPerMTok} per Mtok`;
  const gross = (label: string, e: CostEstimate, entries: number): string =>
    `  ${label.padEnd(28)} ${entries} entries x ${w.samples} draws = ${e.totalCalls} calls` +
    ` · ${e.totalInputTokens} in · ${e.totalOutputTokens} out · ${prices} · $${e.totalUsd.toFixed(4)}`;
  lines.push(
    gross("FULL LANE from scratch", w.fullLane, w.corpusEntries),
    gross("PILOT from scratch", w.pilotLane, w.pilotEntries),
    "",
    "  The pilot is the first 10 corpus entries in first-appearance order, so it is deterministic:",
    "  re-running it is a cache hit, and its draws PREPAY the same draws of the full lane. The",
    "  pilot exists to answer whether the calls vary at all — see the abort criterion. --spend",
    "  --max-usd=<c> --pilot runs only the pilot; --pilot on its own spends nothing.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The pilot's verdict. Nothing downstream is authorized without it.
// ---------------------------------------------------------------------------

/**
 * What one stored draw looks like to a reader. Structural, so ledger rows go straight in — and a
 * SUPERSET of `StoredReplayLabel`, so {@link isReadableReplayLabel} re-admits these rows through
 * the shipped parser path rather than through a second copy of its rules (ADR 0008's third point,
 * inherited deliberately: a taxonomy change must drop a row from the READER and re-open it to the
 * PLANNER in the same breath, or the cache deadlocks with `--self-consistency` reporting the entry
 * unsampled and `--spend` answering "nothing to pay for". That deadlock was a real defect found in
 * MUB-218's review).
 */
export type StoredSelfConsistencySample = Pick<
  SelfConsistencySampleRow,
  | "prompt_hash"
  | "model_id"
  | "sample_index"
  | "corpus_rev"
  | "temperature"
  | "task_type"
  | "difficulty"
  | "confidence"
>;

/**
 * The identity of one DRAW's answer, for the purpose of asking whether two draws differ.
 *
 * All three fields, not just the label: `CLASSIFY_SYSTEM` asks for a task type, a difficulty AND a
 * confidence, so a run that returned the same pair with a different confidence every time is a
 * sampler that is demonstrably varying — which is the only thing the pilot is trying to establish.
 * A stricter tuple here would fail a working sampler; a looser one (task type alone) would pass a
 * broken one whose every draw was byte-identical.
 */
function drawTuple(row: StoredSelfConsistencySample): string {
  return `${row.task_type ?? "-"}|${row.difficulty ?? "-"}|${row.confidence ?? "-"}`;
}

/**
 * Does this sampler vary at all?
 *
 * The verdict the full run is gated on. If default-temperature calls come back identical, a modal
 * frequency of 1.0 means "we did not really sample" and is indistinguishable in the output from "the
 * classifier is perfectly self-consistent" — the second is a finding, the first is a broken
 * instrument, and no aggregate figure can tell them apart afterwards.
 *
 * Counted over the PILOT prompts only, and over draws actually stored: a prompt whose draws all
 * failed contributes nothing rather than counting as "did not vary", which would let a provider
 * outage read as a degenerate sampler.
 */
export type SamplerVerdict =
  | { readonly kind: "ok"; readonly varying: Rate; readonly draws: number }
  | { readonly kind: "no-samples" }
  | {
      readonly kind: "degenerate";
      readonly varying: Rate;
      readonly threshold: number;
      readonly draws: number;
    };

export function checkSamplerNonDegenerate(
  pilot: readonly DistinctPrompt[],
  rows: readonly StoredSelfConsistencySample[],
  opts: {
    readonly modelId: string;
    readonly hashOf: (text: string) => string;
    readonly minVarying?: number;
  },
): SamplerVerdict {
  const byHash = new Map<string, StoredSelfConsistencySample[]>();
  for (const row of rows) {
    if (row.model_id !== opts.modelId) continue;
    const cell = byHash.get(row.prompt_hash) ?? [];
    cell.push(row);
    byHash.set(row.prompt_hash, cell);
  }
  let varying = 0;
  let sampled = 0;
  let draws = 0;
  for (const prompt of pilot) {
    const cell = byHash.get(opts.hashOf(prompt.text)) ?? [];
    if (cell.length === 0) continue;
    sampled += 1;
    draws += cell.length;
    if (new Set(cell.map(drawTuple)).size >= 2) varying += 1;
  }
  if (draws === 0) return { kind: "no-samples" };
  const threshold = opts.minVarying ?? PILOT_MIN_VARYING;
  const r = rate(varying, sampled);
  if (varying < threshold) return { kind: "degenerate", varying: r, threshold, draws };
  return { kind: "ok", varying: r, draws };
}

// ---------------------------------------------------------------------------
// Running the sampling. The only part that spends.
// ---------------------------------------------------------------------------

/** One draw, ready to be written. Carries a hash and an index; it never carries prompt text. */
export interface SelfConsistencySampleWrite {
  readonly promptHash: string;
  readonly modelId: string;
  readonly sampleIndex: number;
  readonly corpusRev: string;
  readonly temperature: string;
  readonly taskType: string | null;
  readonly difficulty: string | null;
  /** The RAW self-report of this draw. */
  readonly confidence: number | null;
}

/** Concurrency: matches the panel's and the replay's, for the same reasons. */
const DEFAULT_CONCURRENCY = 6;

export interface RunSamplingOptions {
  readonly plan: SamplingPlan;
  readonly corpusRev: string;
  readonly call: ReplayCaller;
  readonly record: (sample: SelfConsistencySampleWrite) => void;
  readonly guard: ReplaySpendGuard;
  readonly concurrency?: number;
  readonly onProgress?: (done: number, total: number, spentUsd: number) => void;
}

/** A price that may be added to a running total: anything else is 0. MUB-216's rule. */
function positiveUsd(usd: number): number {
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

/**
 * Run the outstanding draws, recording each as it lands.
 *
 * Every guarantee is `runReplay`'s, kept identical because they were each bought by a real defect:
 * rows are written ONE AT A TIME so an interrupted run keeps what it paid for and a rerun owes only
 * the rest; the cap is checked immediately before each dispatch; `labelled` and `unusable` are
 * counted AFTER the write returns, so a rejected write cannot report stored rows that are not there;
 * and a `record` that throws STOPS the run rather than buying draws nothing can store.
 *
 * Deliberately not shared with `runReplay`, for the reason that one is not shared with `runPanel`:
 * the queue's unit is different — `(prompt, draw)` rather than `(model, prompt)` — and the one thing
 * they would share is a scheduler loop. Fusing them would put the subject under test and its
 * repeatability measurement through a single code path, and `classifier_replay.ts` is imported here
 * UNCHANGED precisely so trap 1's fresh-classifier-per-call guarantee cannot be edited from this
 * lane.
 */
export async function runSampling(opts: RunSamplingOptions): Promise<ReplayRunResult> {
  const queue = opts.plan.todo;
  const model = opts.plan.model;
  let next = 0;
  let attempted = 0;
  let labelled = 0;
  let unusable = 0;
  let unstored = 0;
  let skipped = 0;
  let skippedForLedger = 0;
  let ledgerFailed = false;
  let spent = 0;
  let done = 0;
  const failedByCause: Record<ReplayFailureCause, number> = {
    "provider-error": 0,
    "transport-error": 0,
    truncated: 0,
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const job = queue[i];
      if (job === undefined) return;
      if (ledgerFailed) {
        skippedForLedger++;
        continue;
      }
      if (!opts.guard.mayDispatch()) {
        skipped++;
        continue;
      }
      attempted++;
      let outcome: ReplayCallOutcome;
      try {
        outcome = await opts.call(model, job.prompt.text);
      } catch {
        outcome = { kind: "failed", cause: "transport-error", usd: 0 };
      }
      opts.guard.book(outcome.usd);
      spent += positiveUsd(outcome.usd);
      if (outcome.kind === "failed") {
        failedByCause[outcome.cause] += 1;
      } else {
        try {
          const cls = outcome.kind === "labelled" ? outcome.classification : null;
          opts.record({
            promptHash: job.hash,
            modelId: model.model.id,
            sampleIndex: job.sampleIndex,
            corpusRev: opts.corpusRev,
            temperature: SAMPLING_TEMPERATURE,
            taskType: cls?.taskType ?? null,
            difficulty: cls?.difficulty ?? null,
            // The RAW self-report of THIS draw. It is the left-hand side of the comparison the
            // whole ticket is, so a floor applied here would compare the wrong number.
            confidence: cls?.confidence ?? null,
          });
          if (outcome.kind === "labelled") labelled++;
          else unusable++;
        } catch {
          unstored++;
          ledgerFailed = true;
        }
      }
      done++;
      try {
        opts.onProgress?.(done, queue.length, spent);
      } catch {
        // progress reporting must never break a paid run
      }
    }
  };

  const width = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, queue.length || 1));
  await Promise.all(Array.from({ length: width }, worker));
  const failed = Object.values(failedByCause).reduce((n, v) => n + v, 0);
  return {
    attempted,
    labelled,
    unusable,
    unstored,
    failed,
    failedByCause,
    skippedForCeiling: skipped,
    ceilingHit: skipped > 0,
    skippedForLedger,
    ledgerFailed,
    spentUsd: spent,
  };
}

/**
 * Render what a finished sampling run did, against what it was projected to do.
 *
 * The three failure causes print separately even when two are zero, for `renderReplayRunResult`'s
 * reason: a rate-limited run and a truncated-reply run are fixed by different things and only one
 * of them is fixed by re-running.
 */
export function renderSamplingRunResult(r: ReplayRunResult, projectedUsd: number): string {
  const share = projectedUsd > 0 ? `${((r.spentUsd / projectedUsd) * 100).toFixed(1)}%` : "n/a";
  const lines = [
    `self-consistency run: ${r.attempted} draws · ${r.labelled} labelled · ${r.unusable} unusable` +
      ` · ${r.failed} failed`,
    `  realized $${r.spentUsd.toFixed(4)} against a $${projectedUsd.toFixed(4)} projection` +
      ` (${share} of it)`,
    `  failures by cause: ${r.failedByCause["provider-error"]} provider error ·` +
      ` ${r.failedByCause["transport-error"]} transport/timeout ·` +
      ` ${r.failedByCause.truncated} truncated reply`,
  ];
  if (r.unstored > 0) {
    lines.push(
      `  ${r.unstored} draws were PAID FOR AND NOT STORED — the ledger rejected the row. Those`,
      "  draws are still outstanding and a rerun buys them again.",
    );
  }
  if (r.failed > 0) {
    lines.push("  Failed draws wrote no row, so re-running pays only for those.");
  }
  if (r.unusable > 0) {
    lines.push(
      "  An unusable reply is a deterministic non-answer and IS stored — it is a real outcome of",
      "  the predictive distribution, so it stays in the per-prompt denominator.",
    );
  }
  return lines.join("\n");
}

/** Re-admit a stored draw through the shipped parser's own rules. See {@link isReadableReplayLabel}. */
export function isReadableSample(row: StoredSelfConsistencySample): boolean {
  return isReadableReplayLabel(row);
}
