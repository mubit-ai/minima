/**
 * The classifier replay (MUB-218) — the thing that produces what the scorer scores.
 *
 * MUB-215 built the corpus, MUB-216 paid for the reference labels, and `classifier_eval_score.ts`
 * built the scoring instrument, the reliability curve and the floor derivation. All of it ran
 * against `replays: readonly ModelReplay[] = []`. This module is the missing input: it re-runs the
 * SHIPPED classifier over the corpus and caches what it said.
 *
 * **The classifier is not re-implemented here.** `TaskClassifier` from `classify.ts` makes every
 * call, so the 8000-character truncation, the instruction, the parser, the timeout default and the
 * fail-open behaviour are production's rather than a second copy that agrees with it today. The
 * whole point is measuring what production actually does; a replay whose call differs from the
 * shipped call measures something else and looks identical while doing it.
 *
 * Three fidelity constraints, each of which silently produces a wrong number if it slips:
 *
 *   · **No session-context size hint is sent.** `classify(task, contextTokens)` appends a
 *     `[session context: ~N tokens already in play …]` line when a caller supplies one, and
 *     production always does. The ledger does not record it — `UserPromptRow` is
 *     `{id, run_id, ts, agent_id, text}`, a `user` event's payload is `{role, text}`, and no column
 *     in any ledger table is a token count — so no replay can reproduce it. Nor could the corpus
 *     carry one if it did: the corpus's unit is DISTINCT TEXT, and one entry's several askings each
 *     had a different context behind them. ADR 0005 settled the same question for the panel and
 *     said MUB-218's replay would have none either, which is what keeps the two comparable. The
 *     omission and its direction are reported by {@link renderReplayCoverage}, never left implicit.
 *   · **Truncation is production's.** `classify()` truncates at 8000 characters, and it does so
 *     BEFORE appending the hint. Routing every call through it means this file states no cap of its
 *     own to drift. {@link countTruncated} reports how many corpus entries it reaches.
 *   · **A null answer has three causes and they cache differently.** See {@link ReplayFailureCause}.
 *
 * Storage is ADR 0008: a ledger table of individual labels keyed by the sha256 of the exact prompt
 * text, stamped with the corpus revision, with the text never stored — ADR 0001's shape applied to
 * a different population, in a table of its own so that the subject under test can never be read as
 * the reference.
 *
 * Everything here is pure except {@link runReplay} and {@link makeReplayCaller}, and those take
 * their network, ledger and clock as arguments, so the whole billable path is exercised in tests by
 * a fake that spends fake money.
 */

import type { Model, StopReason } from "../ai/types.ts";
import type { ReplayLabelRow } from "../db/minima_db.ts";
import {
  type CallSpec,
  type CostEstimate,
  type CostLine,
  type DistinctPrompt,
  LABEL_INSTRUCTION_TOKENS,
  LABEL_OUTPUT_TOKENS,
  type Rate,
  estimateRunCost,
  formatRate,
  rate,
} from "./classifier_eval.ts";
import type { ModelReplay, ReplayLabel } from "./classifier_eval_score.ts";
import {
  type ClassifyOutcome,
  type TaskClassification,
  TaskClassifier,
  classificationFromParts,
} from "./classify.ts";

// ---------------------------------------------------------------------------
// The models replayed. Two, because the ticket's question is partly "what does the switch cost".
// ---------------------------------------------------------------------------

/**
 * One classifier model the replay runs, and the output budget its calls are projected at.
 *
 * The `Model` is carried here rather than looked up in the registry for the reason
 * {@link Panelist} carries one: the projection and the call that gets billed must not be able to
 * disagree about which model, or which prices, they mean. That freedom is exactly how prices drift,
 * so `tests/classifier-replay.test.ts` pins every field against `SEED_MODELS`.
 */
export interface ReplayModel {
  readonly model: Model;
  /** Why this model is in the replay at all — printed, so the choice is auditable. */
  readonly role: string;
  /** Projected output tokens per call. See {@link REPLAY_OUTPUT_TOKENS} — a measurement. */
  readonly outputTokensPerCall: number;
}

/**
 * Output allowance per replay call — MEASURED, not assumed.
 *
 * `LABEL_OUTPUT_TOKENS` is 40, reasoned from the shape of the reply the instruction asks for: one
 * line of minified JSON with three short fields. The first paid run falsified it. 135 realized
 * `claude-haiku-4-5` calls cost $0.1046, which at its $1/$5 prices and a ~115-token input works out
 * at ~132 output tokens per call — over three times the allowance, and the reason that run tripped
 * its live cap at 28% of the corpus having been quoted a projection for all of it.
 *
 * A one-line JSON label really is ~40 tokens, so the gap is what the models emit AROUND it: a
 * preamble, a fenced block, an explanation. Fourteen of those 135 replies would not parse at all,
 * which is the same behaviour showing up in the other column.
 *
 * Set generously above the measurement, on purpose: this figure feeds the ceiling a caller is asked
 * to accept, and understating it is the expensive error — as this run demonstrated.
 *
 * NOT a fix to `LABEL_OUTPUT_TOKENS` itself. That constant is the eval core's stated allowance for
 * a bare label and the panel's non-reasoning leg is projected from it; re-deriving it from one
 * model's realized output would change a figure MUB-216's cached run was costed against.
 * `outputTokensPerCall` is per-model precisely so a leg can state what it actually costs — the same
 * mechanism the panel uses for its server-side reasoners.
 */
export const REPLAY_OUTPUT_TOKENS = 150;

/**
 * The two classifier models replayed over the corpus.
 *
 * The FIRST is the shipped default and is the one every reported accuracy figure is about:
 * `cli/main.ts` builds the production `TaskClassifier` from `config.classifyModel ??
 * CHEAP_FALLBACK_MODELS[0]`, and `classifyModel` defaults to null.
 *
 * The SECOND exists because the ticket asks what the model switch would cost rather than assuming
 * it is free. `gpt-4o-mini` is cheap and its provider's API can return token probabilities, which
 * is the capability the later confidence tickets would need — so the accuracy difference measured
 * here is the price of that option, on this corpus, rather than a guess about it.
 *
 * Neither model reasons server-side, but neither is projected at the bare label allowance either —
 * see {@link REPLAY_OUTPUT_TOKENS}, which the first paid run measured. Prices are copied from the
 * harness's model registry and pinned to it by test.
 */
export const REPLAY_MODELS: readonly ReplayModel[] = [
  {
    model: {
      id: "claude-haiku-4-5",
      provider: "anthropic",
      api: "anthropic-messages",
      name: "Claude Haiku 4.5",
      cost: { input: 1.0, output: 5.0, cache_read: 0.08, cache_write: 1.25 },
      context_window: 200_000,
      max_tokens: 8192,
      reasoning: false,
    },
    role: "the shipped default classifier",
    outputTokensPerCall: REPLAY_OUTPUT_TOKENS,
  },
  {
    model: {
      id: "gpt-4o-mini",
      provider: "openai",
      api: "openai-completions",
      name: "GPT-4o mini",
      cost: { input: 0.15, output: 0.6 },
      context_window: 128_000,
      max_tokens: 16_384,
    },
    role: "cheap, and its API can return token probabilities",
    outputTokensPerCall: REPLAY_OUTPUT_TOKENS,
  },
];

/** The cost leg for one replay model: one call per prompt, at its own prices and allowance. */
export function replayCallSpecs(models: readonly ReplayModel[]): CallSpec[] {
  return models.map((m) => ({
    label: `replay: ${m.model.id}`,
    callsPerPrompt: 1,
    inputUsdPerMTok: m.model.cost.input,
    outputUsdPerMTok: m.model.cost.output,
    // Every call pays CLASSIFY_SYSTEM — the same ~99 tokens the panel's legs pay, because it is
    // literally the same instruction. Fixed overhead against a ~17-token average prompt here, so a
    // silently-defaulted zero would understate input by nearly 7x.
    fixedInputTokensPerCall: LABEL_INSTRUCTION_TOKENS,
    outputTokensPerCall: m.outputTokensPerCall,
  }));
}

// ---------------------------------------------------------------------------
// Fidelity: what the shipped call does to a prompt, counted rather than assumed.
// ---------------------------------------------------------------------------

/**
 * The prompt cap the shipped `classify()` applies (`task.slice(0, 8000)`).
 *
 * Stated here ONLY so the count below can be reported. No call in this module applies it — every
 * call goes through `classify()`, which owns it — so this constant cannot silently become a second
 * truncation policy that agrees with production until the day it does not.
 */
export const CLASSIFY_PROMPT_CHARS = 8000;

/**
 * How many corpus entries the shipped truncation actually reaches.
 *
 * Reported rather than assumed to be zero: an entry longer than the cap is replayed on a PREFIX of
 * itself while the reference panel labelled the same prefix (its cap is the same 8000), so the
 * comparison stays honest — but the classifier is then being scored on less than the corpus entry
 * a reader of the readout has in mind, and how many entries that is belongs in the output.
 */
export function countTruncated(prompts: readonly DistinctPrompt[]): number {
  return prompts.filter((p) => isTruncated(p.text)).length;
}

/**
 * Does the shipped truncation reach this text? THE predicate, stated once.
 *
 * Both the pre-run projection (over `DistinctPrompt`) and the post-run coverage readout (over
 * corpus strings) report this count, and two copies of the comparison would be two chances to
 * print different numbers under headings that claim to mean the same thing.
 */
function isTruncated(text: string): boolean {
  return text.length > CLASSIFY_PROMPT_CHARS;
}

// ---------------------------------------------------------------------------
// Planning a run: what is still outstanding, and what that would cost.
// ---------------------------------------------------------------------------

/** One prompt a model still owes a label on, carrying the key that label will be stored under. */
export interface ReplayWorkItem {
  readonly prompt: DistinctPrompt;
  readonly hash: string;
}

/** One model's share of a run: what it still owes, and how much it already has cached. */
export interface ReplayPlan {
  readonly model: ReplayModel;
  readonly todo: readonly ReplayWorkItem[];
  readonly cached: number;
}

/**
 * What a run still has to pay for, per model.
 *
 * Caching is per `(prompt, model)`, exactly as the panel's is: adding a second classifier model, or
 * one model failing a call, costs only the labels actually missing. `cachedKeys` holds keys already
 * present AT THE CURRENT REVISION — a label produced under another revision is not in the set,
 * which is how a revision bump becomes a cache miss rather than a stale answer.
 *
 * `hashOf` is injected: MUB-216's `promptHash` is the one key producer in the tree, and two
 * implementations that ever disagreed would produce a total cache miss and report it as "the
 * classifier has not labelled this corpus".
 */
export function planReplayRun(
  prompts: readonly DistinctPrompt[],
  models: readonly ReplayModel[],
  cachedKeys: ReadonlySet<string>,
  hashOf: (text: string) => string,
  keyOf: (hash: string, modelId: string) => string,
): ReplayPlan[] {
  const hashed = prompts.map((prompt) => ({ prompt, hash: hashOf(prompt.text) }));
  return models.map((model) => {
    const todo = hashed.filter((w) => !cachedKeys.has(keyOf(w.hash, model.model.id)));
    return { model, todo, cached: hashed.length - todo.length };
  });
}

/**
 * Project what the OUTSTANDING work would cost — the figure the ceiling is checked against.
 *
 * Deliberately not the whole corpus (ADR 0006): a rerun over cached labels spends nothing, and a
 * ceiling chosen against the full-corpus figure would be answering a question the run is not
 * asking. Priced by the same `estimateRunCost` the dry run uses, so there is one arithmetic path
 * and the printed total can be re-derived by hand.
 */
export function projectReplayCost(plans: readonly ReplayPlan[]): CostEstimate {
  const specs = replayCallSpecs(plans.map((p) => p.model));
  const lines: CostLine[] = plans.map(
    (plan, i) =>
      estimateRunCost(
        plan.todo.map((w) => w.prompt),
        [specs[i] as CallSpec],
      ).lines[0] as CostLine,
  );
  return {
    prompts: new Set(plans.flatMap((p) => p.todo.map((w) => w.hash))).size,
    lines,
    totalCalls: lines.reduce((n, l) => n + l.calls, 0),
    totalInputTokens: lines.reduce((n, l) => n + l.inputTokens, 0),
    totalOutputTokens: lines.reduce((n, l) => n + l.outputTokens, 0),
    totalUsd: Math.round(lines.reduce((n, l) => n + l.usd, 0) * 1e6) / 1e6,
  };
}

/** What a `--spend` run would pay the replay for: how much is cached, and what the rest projects to. */
export interface ReplayOutstanding {
  readonly corpusRev: string;
  /** Cached labels over corpus × models — a Rate, so the share cannot be quoted without it. */
  readonly labelsCached: Rate;
  readonly cost: CostEstimate;
  /** Corpus entries the shipped 8000-char truncation reaches. Zero is a measurement, not a default. */
  readonly truncatedEntries: number;
}

export function summarizeReplayOutstanding(
  plans: readonly ReplayPlan[],
  prompts: readonly DistinctPrompt[],
  corpusRev: string,
): ReplayOutstanding {
  const cached = plans.reduce((n, p) => n + p.cached, 0);
  return {
    corpusRev,
    labelsCached: rate(cached, prompts.length * plans.length),
    cost: projectReplayCost(plans),
    truncatedEntries: countTruncated(prompts),
  };
}

/** Render the replay's outstanding-work section. Every price it was costed at travels with its leg. */
export function renderReplayOutstanding(w: ReplayOutstanding): string {
  const lines = [
    "Classifier replay (MUB-218) — what --spend would actually pay for",
    `  corpus revision              ${w.corpusRev}`,
    `  labels cached at this rev    ${formatRate(w.labelsCached)}`,
    `  outstanding                  ${w.cost.totalCalls} calls · $${w.cost.totalUsd.toFixed(4)}`,
  ];
  for (const l of w.cost.lines) {
    lines.push(
      `  ${l.label.padEnd(28)} ${l.calls} calls · ${l.inputTokens} in · ${l.outputTokens} out` +
        ` · $${l.inputUsdPerMTok}/$${l.outputUsdPerMTok} per Mtok · $${l.usd.toFixed(4)}`,
    );
  }
  lines.push(
    `  entries over ${CLASSIFY_PROMPT_CHARS} chars      ${w.truncatedEntries}  (the shipped classify() truncates these; the panel truncated at the same cap)`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Running the replay. The only part that spends.
// ---------------------------------------------------------------------------

/**
 * Why a replayed call produced no storable answer. THREE causes, never collapsed — the distinction
 * is the difference between a cache that is honest and one that is quietly, permanently wrong.
 *
 *   · `provider-error` — the provider reported an error (`stop_reason === "error"`). Retryable, and
 *     the shipped classifier already declines to memoize it for exactly this reason.
 *   · `transport-error` — the call threw: a transport failure, or the timeout elapsing. Also
 *     retryable, and also not memoized by the shipped classifier.
 *   · `truncated` — a complete-looking reply that stopped on `length`. The shipped classifier
 *     treats this as a reply and parses it, which is safe for an in-memory per-session memo that
 *     costs nothing to rebuild. It is NOT safe for a durable, money-backed row: MUB-216 shipped
 *     precisely this bug, caching a `length` truncation as a permanent null vote, which would have
 *     silently and permanently excluded prompts that had already been paid for. Here it is a
 *     failure, so nothing is written and a rerun asks again.
 *
 * A fourth outcome — a COMPLETE reply that will not parse — is not a failure at all. It is a
 * deterministic answer about this (prompt, model) and is cached as a null label, so a rerun does
 * not pay for it twice. That is the shipped classifier's own distinction, kept identical.
 */
export type ReplayFailureCause = "provider-error" | "transport-error" | "truncated";

/** What one replayed call produced. */
export type ReplayCallOutcome =
  | { readonly kind: "labelled"; readonly classification: TaskClassification; readonly usd: number }
  | { readonly kind: "unusable"; readonly usd: number }
  | { readonly kind: "failed"; readonly cause: ReplayFailureCause; readonly usd: number };

export type ReplayCaller = (model: ReplayModel, promptText: string) => Promise<ReplayCallOutcome>;

/** Stop reasons a durable cache must not store an answer for. See {@link ReplayFailureCause}. */
const TRUNCATING_STOP_REASONS: ReadonlySet<StopReason> = new Set<StopReason>(["length", "aborted"]);

/**
 * Output cap per replay call. The one place the replay's REQUEST diverges from production's.
 *
 * `classify()` sets no `max_tokens`, so every provider falls back to `model.max_tokens` — 8192 for
 * `claude-haiku-4-5`, 16384 for `gpt-4o-mini`. On one interactive turn that ceiling is a rounding
 * error. Over a few hundred billable calls it is the difference between a projection and a bill:
 * the guard bounds DISPATCH, not completion, so at `DEFAULT_CONCURRENCY` six in-flight replies each
 * free to run to 8192 tokens can overshoot an accepted ceiling by ~$0.25 — on a run whose whole
 * projection is cents. The panel caps for exactly this reason (`PANEL_MAX_TOKENS`), and ADR 0005
 * records that divergence as operational rather than instructional. This is the same one.
 *
 * Chosen so it CANNOT change a measurement: 1024 is nearly 8x the ~132 output tokens these models
 * actually emit, and across 476 realized calls not one stopped on `length`. If it ever did bite,
 * the reply is discarded as `truncated` and no row is written — so a capped call can cost a retry,
 * never a wrong label.
 */
const REPLAY_MAX_TOKENS = 1024;

/**
 * The real caller: the SHIPPED `TaskClassifier`, asked the shipped way.
 *
 * A FRESH classifier per call, deliberately. `TaskClassifier` memoizes on `Bun.hash(task)`, and a
 * memo hit makes no call, fires no outcome and books no cost — so a reused instance could hand back
 * a label the run never paid for, silently, on a 64-bit hash collision. One instance per call makes
 * the memo permanently cold, so every outcome recorded here corresponds to a call that really
 * happened. The corpus's own cache is the durable ledger table, not this Map.
 *
 * No `contextTokens` argument is passed. That is the module docstring's first fidelity constraint
 * and ADR 0005's decision, and it is visible HERE, at the call, rather than only in prose.
 *
 * `classifierFor` is the test seam: `tests/classifier-replay.test.ts` drives every branch through
 * it, so the billable path is covered without a network.
 */
export function makeReplayCaller(
  classifierFor: (
    m: ReplayModel,
    opts: ConstructorParameters<typeof TaskClassifier>[1],
  ) => {
    classify: (task: string) => Promise<TaskClassification | null>;
  } = (m, opts) => new TaskClassifier(m.model, { ...opts, maxTokens: REPLAY_MAX_TOKENS }),
): ReplayCaller {
  return async (model, promptText) => {
    let usd = 0;
    let outcome: ClassifyOutcome | null = null;
    const classifier = classifierFor(model, {
      onCostUsd: (n) => {
        usd += n;
      },
      onOutcome: (o) => {
        outcome = o;
      },
    });
    await classifier.classify(promptText);
    // `outcome` is assigned from inside a callback the classifier invokes; TS's control-flow
    // analysis cannot see that, hence the widening read.
    const reported = outcome as ClassifyOutcome | null;
    if (reported === null) {
      // The shipped classifier reports on every path it takes, so this is unreachable through it.
      // A caller substituting its own is not entitled to a stored answer it never described.
      return { kind: "failed", cause: "transport-error", usd };
    }
    if (reported.kind === "provider-error") return { kind: "failed", cause: "provider-error", usd };
    if (reported.kind === "transport-error") {
      return { kind: "failed", cause: "transport-error", usd };
    }
    if (TRUNCATING_STOP_REASONS.has(reported.stopReason)) {
      return { kind: "failed", cause: "truncated", usd };
    }
    if (reported.kind === "unusable") return { kind: "unusable", usd };
    return { kind: "labelled", classification: reported.classification, usd };
  };
}

/** A label, ready to be written to the ledger. Carries a hash; it never carries prompt text. */
export interface ReplayLabelWrite {
  readonly promptHash: string;
  readonly modelId: string;
  readonly corpusRev: string;
  readonly taskType: string | null;
  readonly difficulty: string | null;
  /** The RAW self-report, pre-floor. */
  readonly confidence: number | null;
}

/** Bounds realized spend, checked before every dispatch. MUB-216's guard, taken as an argument. */
export interface ReplaySpendGuard {
  mayDispatch(): boolean;
  book(usd: number): void;
}

export interface ReplayRunResult {
  readonly attempted: number;
  /** Rows the ledger ACCEPTED. Counted after the write returns, never before it. */
  readonly labelled: number;
  readonly unusable: number;
  /** Calls paid for whose row the ledger rejected: real answers, bought and not kept. */
  readonly unstored: number;
  readonly failed: number;
  /** Failures by cause. Three counts, never one — see {@link ReplayFailureCause}. */
  readonly failedByCause: Readonly<Record<ReplayFailureCause, number>>;
  readonly skippedForCeiling: number;
  readonly ceilingHit: boolean;
  readonly skippedForLedger: number;
  readonly ledgerFailed: boolean;
  readonly spentUsd: number;
}

/** Concurrency: matches the panel's, for the same reasons. */
const DEFAULT_CONCURRENCY = 6;

export interface RunReplayOptions {
  readonly plans: readonly ReplayPlan[];
  readonly corpusRev: string;
  readonly call: ReplayCaller;
  readonly record: (label: ReplayLabelWrite) => void;
  readonly guard: ReplaySpendGuard;
  readonly concurrency?: number;
  readonly onProgress?: (done: number, total: number, spentUsd: number) => void;
}

/** A price that may be added to a running total: anything else is 0. MUB-216's rule, restated
 * because importing it would pull the panel into the replay for four tokens of arithmetic. */
function positiveUsd(usd: number): number {
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

/**
 * Run the outstanding work, recording each label as it lands.
 *
 * Labels are written ONE AT A TIME as they arrive, never batched at the end: a run that dies part
 * way must keep what it paid for, and a rerun must owe only the rest. The cap is checked
 * immediately before each dispatch, so a run that trips it stops paying rather than finishing the
 * queue. A `record` that throws STOPS the run — persistence is the product here, and a run whose
 * writes are failing would keep buying labels that nothing stores.
 *
 * Same shape as `runPanel`, and deliberately not shared with it: that one queues `(panelist,
 * prompt)` and writes votes, this one queues `(model, prompt)` and writes labels, and the one thing
 * they would share is a scheduler loop. Fusing them would put the reference and the subject under
 * test through a single code path, which is the coupling ADR 0008 exists to avoid.
 */
export async function runReplay(opts: RunReplayOptions): Promise<ReplayRunResult> {
  const queue = opts.plans.flatMap((plan) =>
    plan.todo.map((item) => ({ model: plan.model, item })),
  );
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
        outcome = await opts.call(job.model, job.item.prompt.text);
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
            promptHash: job.item.hash,
            modelId: job.model.model.id,
            corpusRev: opts.corpusRev,
            taskType: cls?.taskType ?? null,
            difficulty: cls?.difficulty ?? null,
            // The RAW self-report. Applying the floor here would leave the reliability curve with
            // no evidence in the region the floor is being argued about.
            confidence: cls?.confidence ?? null,
          });
          // Counted AFTER the write returns, never before it. `labelled` and `unusable` are read
          // as "rows that are in the ledger" — `renderReplayRunResult` prints them that way and
          // the ceiling note says the labels "already paid for are in the ledger". Incrementing
          // first makes both statements false on exactly the run where they matter: a rejected
          // write would report six stored rows and zero failures with nothing on disk, and the
          // rerun would silently pay for those prompts twice.
          if (outcome.kind === "labelled") labelled++;
          else unusable++;
        } catch {
          // Paid for, and not stored. Its own count: it is not a `failed` call (the money bought a
          // real answer) and it is not a stored row, and folding it into either would misstate
          // what a rerun still owes.
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
 * Render what a finished replay actually did, against what it was projected to do.
 *
 * The three failure causes are printed separately even when two of them are zero. A single "failed"
 * count would let a run that hit its provider's rate limit read the same as one whose replies were
 * being truncated, and only one of those is fixed by re-running.
 */
export function renderReplayRunResult(r: ReplayRunResult, projectedUsd: number): string {
  const share = projectedUsd > 0 ? `${((r.spentUsd / projectedUsd) * 100).toFixed(1)}%` : "n/a";
  const lines = [
    `replay run: ${r.attempted} calls · ${r.labelled} labelled · ${r.unusable} unusable` +
      ` · ${r.failed} failed`,
    `  realized $${r.spentUsd.toFixed(4)} against a $${projectedUsd.toFixed(4)} projection` +
      ` (${share} of it)`,
    `  failures by cause: ${r.failedByCause["provider-error"]} provider error ·` +
      ` ${r.failedByCause["transport-error"]} transport/timeout ·` +
      ` ${r.failedByCause.truncated} truncated reply`,
  ];
  if (r.unstored > 0) {
    lines.push(
      `  ${r.unstored} calls were PAID FOR AND NOT STORED — the ledger rejected the row. Those`,
      "  prompts are still outstanding and a rerun buys them again.",
    );
  }
  if (r.failed > 0) {
    lines.push("  Failed calls wrote no row, so re-running pays only for those.");
  }
  if (r.unusable > 0) {
    lines.push(
      "  An unusable reply is a deterministic non-answer and IS cached — it scores as an",
      "  abstention, which is the classifier failing open by design, not a wrong answer.",
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Reading the cache back: ledger rows in, the scorer's input out.
// ---------------------------------------------------------------------------

/** The stored-label shape this reader needs. Structural, so it takes ledger rows directly. */
export type StoredReplayLabel = Pick<
  ReplayLabelRow,
  "prompt_hash" | "model_id" | "corpus_rev" | "task_type" | "difficulty" | "confidence"
>;

/**
 * Is this stored row still usable as a cache hit?
 *
 * THE predicate that decides it, consulted by the PLANNER as well as the reader. Without that,
 * the two disagree and the cache deadlocks: `toModelReplays` drops a row whose taxonomy has moved
 * on as `unreadable`, while a planner counting rows would still see the key as cached — so
 * `--score` reports the entry `unreplayed` and tells the caller to run `--spend`, and `--spend`
 * answers "nothing to pay for". Neither command is wrong on its own and together they are a trap
 * with no way out but hand-deleting rows or bumping `CORPUS_REV`, which re-opens the paid panel.
 *
 * A NULL `task_type` is usable: it is a deterministic non-answer that was paid for, and re-buying
 * it would spend money to learn the same thing again.
 */
export function isReadableReplayLabel(row: StoredReplayLabel): boolean {
  if (row.task_type === null) return true;
  return classificationFromParts(row.task_type, row.difficulty, row.confidence) !== null;
}

/** One model's cache coverage, so a partial replay cannot read as a complete one. */
export interface ReplayModelCoverage {
  readonly modelId: string;
  /** Corpus entries this model has a stored answer for, over the corpus. */
  readonly labelled: Rate;
  /** Of those, the ones that were a deterministic non-answer (stored as a null label). */
  readonly abstentions: number;
  /**
   * Stored answers that would NOT re-admit through the shipped parser's own rules — a row written
   * under a task-type or difficulty taxonomy that has since changed. Dropped rather than
   * reconstituted: `corpus_rev` versions the CORPUS, not the taxonomy, so nothing else would catch
   * this, and a stale label reconstituted here would be scored against the panel as merely wrong.
   */
  readonly unreadable: number;
}

/** What the join between the live corpus and the cached labels found. */
export interface ReplayResolution {
  /** The scorer's input. Models with no stored label at all are ABSENT — see {@link toModelReplays}. */
  readonly replays: readonly ModelReplay[];
  readonly perModel: readonly ReplayModelCoverage[];
  /** Rows describing a different corpus revision — absent, not stale-but-usable (ADR 0001). */
  readonly rowsAtOtherRev: number;
  /** Rows at this revision whose prompt is not in the live corpus. Unreadable by construction. */
  readonly rowsWithoutCorpusEntry: number;
  /** Rows from a model that is not in the replay set. */
  readonly rowsOutsideModelSet: number;
  /** Corpus entries the shipped truncation reaches — carried so the readout can state it. */
  readonly truncatedEntries: number;
}

/**
 * Project cached rows into the scorer's `ModelReplay[]`, and count everything the join set aside.
 *
 * `ReplayLabel.text` is the corpus text and exists IN MEMORY ONLY: the stored row is a hash, and
 * the text comes back from the live corpus, never from the cache. The hash is one-way, which is
 * what makes that the only possible direction.
 *
 * Two distinctions the scorer depends on and this function is the only place that can get wrong:
 *
 *   · A stored row with a NULL `task_type` becomes `{text, classification: null}` — PRESENT with a
 *     null, which `scoreReplay` scores as `abstained`: the classifier answered and declined.
 *   · A MISSING row becomes no entry at all, which `scoreReplay` scores as `unreplayed`: a gap in
 *     this run's coverage. Folding the second into the first would let a truncated replay report
 *     itself as a fail-open rate.
 *
 * A model with no stored label whatsoever is omitted from `replays` entirely rather than returned
 * as a pass that skipped the corpus. "This model was never run" is a different claim from "this
 * model was run and answered nothing", and the readout's `unreplayed` row is denominated in a
 * replay that happened.
 */
export function toModelReplays(
  corpus: readonly string[],
  rows: readonly StoredReplayLabel[],
  models: readonly ReplayModel[],
  opts: { readonly corpusRev: string; readonly hashOf: (text: string) => string },
): ReplayResolution {
  const modelIds = new Set(models.map((m) => m.model.id));
  const byModel = new Map<string, Map<string, StoredReplayLabel>>();
  let rowsAtOtherRev = 0;
  let rowsOutsideModelSet = 0;
  for (const row of rows) {
    if (row.corpus_rev !== opts.corpusRev) {
      rowsAtOtherRev += 1;
      continue;
    }
    if (!modelIds.has(row.model_id)) {
      rowsOutsideModelSet += 1;
      continue;
    }
    const cell = byModel.get(row.model_id) ?? new Map<string, StoredReplayLabel>();
    cell.set(row.prompt_hash, row);
    byModel.set(row.model_id, cell);
  }

  const liveHashes = new Map<string, string>();
  for (const text of corpus) liveHashes.set(opts.hashOf(text), text);

  const replays: ModelReplay[] = [];
  const perModel: ReplayModelCoverage[] = [];
  let rowsWithoutCorpusEntry = 0;
  for (const model of models) {
    const cell = byModel.get(model.model.id) ?? new Map<string, StoredReplayLabel>();
    const labels: ReplayLabel[] = [];
    let abstentions = 0;
    let unreadable = 0;
    for (const text of corpus) {
      const row = cell.get(opts.hashOf(text));
      if (row === undefined) continue;
      if (row.task_type === null) {
        // A deterministic non-answer, paid for and stored. Present, with a null.
        labels.push({ text, classification: null });
        abstentions += 1;
        continue;
      }
      const cls = classificationFromParts(row.task_type, row.difficulty, row.confidence);
      if (cls === null) {
        unreadable += 1;
        continue;
      }
      labels.push({ text, classification: cls });
    }
    for (const hash of cell.keys()) if (!liveHashes.has(hash)) rowsWithoutCorpusEntry += 1;
    perModel.push({
      modelId: model.model.id,
      labelled: rate(labels.length, corpus.length),
      abstentions,
      unreadable,
    });
    if (labels.length > 0) replays.push({ modelId: model.model.id, labels });
  }

  return {
    replays,
    perModel,
    rowsAtOtherRev,
    rowsWithoutCorpusEntry,
    rowsOutsideModelSet,
    truncatedEntries: corpus.filter(isTruncated).length,
  };
}

/**
 * Render what the replay covered, and the one thing it could not reproduce.
 *
 * Printed BESIDE the score report rather than inside it: the scoring contract is reviewed and
 * merged and this is a fact about the producer's coverage, not a figure the scorer computes. The
 * context-hint caveat lives here because here is where a reader meets the numbers it qualifies.
 */
export function renderReplayCoverage(r: ReplayResolution): string {
  const lines: string[] = ["Classifier replay coverage (MUB-218 — what the replay actually holds)"];
  for (const m of r.perModel) {
    lines.push(
      `  ${m.modelId.padEnd(24)} ${formatRate(m.labelled)} of corpus` +
        ` · ${m.abstentions} deterministic non-answers · ${m.unreadable} unreadable`,
    );
  }
  lines.push(
    `  rows at another corpus rev   ${r.rowsAtOtherRev}  (a different corpus, so absent)`,
    `  rows whose prompt is gone    ${r.rowsWithoutCorpusEntry}  (hash is one-way — unreadable)`,
    `  rows outside the replay set  ${r.rowsOutsideModelSet}`,
    `  entries over ${CLASSIFY_PROMPT_CHARS} chars      ${r.truncatedEntries}  (truncated by the shipped classify(), as in production)`,
    "",
    "What this replay is NOT, which travels with every figure it produced:",
    "  · Production sends a session-context size hint — `[session context: ~N tokens already in",
    "    play …]`, appended to the prompt after truncation — and this replay sends NONE. The",
    "    ledger does not record N: a user event's payload is {role, text}, and no ledger column",
    "    anywhere is a token count. Nor could a corpus entry carry one, since its unit is distinct",
    "    TEXT and one entry's several askings each had a different context behind them.",
    "  · Which way that omission biases the result. The hint carries no task-type information — it",
    "    speaks only to difficulty — so it is unlikely to move the labels much. It should move the",
    "    SELF-REPORT: `CLASSIFY_SYSTEM` defines confidence as sureness of BOTH labels, and a hint",
    "    that introduces scope the prompt text does not show adds difficulty uncertainty. Omitting",
    "    it should therefore read HIGHER confidence here than production sees at the same prompt,",
    "    which would make a floor derived from this curve slightly PERMISSIVE when transplanted.",
    "    That is a directional argument from the instruction's wording, not a measurement; it is",
    "    unfalsifiable on this ledger, and separating it takes a run at a synthetic N.",
    "  · The reference panel omits the same hint (ADR 0005), so the classifier and the labels it is",
    "    scored against were asked the same question. The bias above is against PRODUCTION, not",
    "    between the two sides of this comparison.",
  );
  return lines.join("\n");
}
