/**
 * The provider-diverse reference panel (MUB-216).
 *
 * Three strong models, ONE PER TRAINING LINEAGE, independently label each corpus prompt. Where all
 * three agree the label is treated as pseudo-gold; where they disagree the prompt leaves the scored
 * set and is counted. The unanimity rate is the headline output and is itself this evaluation's
 * reliability metric — every downstream number rests on these labels, so how often three strong
 * models can even agree bounds what any of those numbers can mean.
 *
 * Lineage, not API provider, is the diversity axis. Two models from one family agreeing is not
 * independent evidence, and a gateway like OpenRouter serves many lineages under one `provider`,
 * so keying on `provider` would both reject honest panels and accept fake ones.
 *
 * The panelists are given `CLASSIFY_SYSTEM` VERBATIM and parsed with `parseClassification` — the
 * shipped classifier's own instruction and parser. That makes the panel a strictly-stronger-models
 * replay of the exact call under test: any gap MUB-218 measures is model capability, not prompt
 * difference, and a parse failure means the same thing on both sides. It also makes the third
 * outcome legible — if three strong models given the shipped instruction rarely agree, the defect
 * is the instruction or the taxonomy, not the classifier.
 *
 * Storage is ADR 0001: a ledger table of INDIVIDUAL VOTES keyed by the sha256 of the exact prompt
 * text, with the text never stored, stamped with the corpus revision. {@link deriveConsensus} is
 * the single way anyone turns votes into a verdict — MUB-218 and MUB-226 both take it injected.
 *
 * Everything here is pure except {@link runPanel} and {@link makePanelCaller}, and those take their
 * network, ledger and clock as arguments, so the whole billable path is exercised in tests by a
 * fake that spends fake money.
 */

import { complete } from "../ai/stream.ts";
import { Message, type Model } from "../ai/types.ts";
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
import { CLASSIFY_SYSTEM, parseClassification } from "./classify.ts";
import type { Difficulty, TaskType } from "./schemas.ts";

// ---------------------------------------------------------------------------
// The panel.
// ---------------------------------------------------------------------------

/**
 * One reference panelist: the model that gets called, the training lineage it counts as, and the
 * output budget its calls are projected at.
 *
 * The `Model` is carried here rather than looked up in the registry so the projection and the call
 * that gets billed cannot disagree about which model, or which prices, they mean. That freedom is
 * exactly how prices drift, so `tests/consensus-panel.test.ts` pins every field against
 * `SEED_MODELS`.
 */
export interface Panelist {
  readonly model: Model;
  /** Training lineage — deliberately NOT `model.provider` (see the module docstring). */
  readonly lineage: string;
  /** Projected output tokens per call. Larger when the model reasons server-side. */
  readonly outputTokensPerCall: number;
  /**
   * Does this model reason server-side and bill those hidden tokens as output? The harness sends
   * no thinking parameter, so this is a property of the model, not of the request — and it is the
   * difference between a projection that is roughly right and one that is 6x low.
   */
  readonly reasonsServerSide: boolean;
}

/** Output allowance for a leg whose model reasons before answering. A label reply is ~40 tokens;
 * the rest is reasoning nobody sees and everybody pays for. Deliberately generous: this figure
 * feeds the ceiling the caller is asked to accept, and understating it is the expensive error. */
const REASONING_OUTPUT_TOKENS = 250;

/**
 * The reference panel: claude-opus-4-8 (Anthropic) · gpt-5.6-sol (OpenAI) · gemini-2.5-pro
 * (Google). Three lineages, three of the strongest models available to this harness.
 *
 * Prices are copied from the harness's model registry and pinned to it by test. Changing a
 * panelist is a NEW `model_id`, which is a cache miss for that panelist alone — no revision bump
 * is needed, and the other panelists' paid labels survive.
 */
export const REFERENCE_PANEL: readonly Panelist[] = [
  {
    model: {
      id: "claude-opus-4-8",
      provider: "anthropic",
      api: "anthropic-messages",
      name: "Claude Opus 4.8",
      cost: { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
      context_window: 200_000,
      max_tokens: 16384,
      reasoning: true,
      adaptive_thinking: true,
    },
    lineage: "anthropic",
    // Anthropic only thinks when asked to (`options.thinking`), and this path never asks.
    outputTokensPerCall: LABEL_OUTPUT_TOKENS,
    reasonsServerSide: false,
  },
  {
    model: {
      id: "gpt-5.6-sol",
      provider: "openai",
      api: "openai-completions",
      name: "GPT-5.6 Sol",
      cost: { input: 5.0, output: 30.0, cache_read: 0.5 },
      context_window: 1_050_000,
      max_tokens: 128_000,
      reasoning: true,
    },
    lineage: "openai",
    // A reasoning model with no effort control on this transport: it reasons at its default and
    // bills it as output.
    outputTokensPerCall: REASONING_OUTPUT_TOKENS,
    reasonsServerSide: true,
  },
  {
    model: {
      id: "gemini-2.5-pro",
      provider: "google",
      api: "google-generative-ai",
      name: "Gemini 2.5 Pro",
      cost: {
        input: 1.25,
        output: 10.0,
        cache_read: 0.125,
        long_context: { above_prompt_tokens: 200_000, input: 2.5, output: 15.0, cache_read: 0.25 },
      },
      context_window: 2_000_000,
      max_tokens: 8192,
      reasoning: true,
    },
    lineage: "google",
    // 2.5 Pro thinks dynamically and cannot be told not to; the harness sends no thinkingConfig.
    outputTokensPerCall: REASONING_OUTPUT_TOKENS,
    reasonsServerSide: true,
  },
];

/**
 * Whether a panel can produce independent evidence. `repeated` names every lineage appearing more
 * than once; an empty `repeated` with `ok: false` means there was no panel to check — fewer than
 * two panelists cannot disagree, so unanimity over them would measure nothing.
 *
 * The acceptance criterion "no two panelists share a training lineage" is enforced here rather
 * than documented, because a panel that quietly loses its diversity still produces numbers.
 */
export type DiversityVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly repeated: readonly string[] };

export function checkPanelDiversity(panel: readonly Panelist[]): DiversityVerdict {
  if (panel.length < 2) return { ok: false, repeated: [] };
  const seen = new Map<string, number>();
  for (const p of panel) seen.set(p.lineage, (seen.get(p.lineage) ?? 0) + 1);
  const repeated = [...seen]
    .filter(([, n]) => n > 1)
    .map(([lineage]) => lineage)
    .sort();
  return repeated.length ? { ok: false, repeated } : { ok: true };
}

// ---------------------------------------------------------------------------
// Keys. The corpus's unit of work is the exact text, so the key is too.
// ---------------------------------------------------------------------------

/**
 * The cache key for a prompt: sha256 of its EXACT text.
 *
 * No trimming, no case folding, no normalizing — the corpus collapses on exact recorded text, so a
 * normalized key here would merge two corpus entries onto one label. One-way by construction: a
 * cached label cannot be walked back to the traffic it describes, which is the point (ADR 0001).
 */
export function promptHash(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

/** The identity of one vote: a prompt and the panelist that voted on it, and nothing else. */
export function voteKey(hash: string, modelId: string): string {
  return `${hash} ${modelId}`;
}

// ---------------------------------------------------------------------------
// Consensus. Derived at read time — the single way anyone turns votes into a verdict.
// ---------------------------------------------------------------------------

/** One panelist's vote. `taskType: null` = it answered, but with nothing usable as a label. */
export interface PanelVote {
  readonly modelId: string;
  readonly taskType: TaskType | null;
}

/**
 * What a panel's votes amount to.
 *
 * `incomplete` is a first-class outcome, not an error: two agreeing panelists out of three have
 * not agreed unanimously, and calling that unanimity would manufacture pseudo-gold out of a
 * panelist that never voted.
 */
export type ConsensusVerdict =
  | { readonly kind: "unanimous"; readonly label: TaskType; readonly votes: number }
  | { readonly kind: "split"; readonly labels: readonly TaskType[]; readonly votes: number }
  | { readonly kind: "incomplete"; readonly votes: number; readonly panelSize: number };

/**
 * Derive a verdict from votes. THE one way it is done.
 *
 * Consensus is deliberately not stored (ADR 0001): MUB-226 adjudicates overrides and MUB-218
 * builds a reliability curve, and either may need to tell a unanimous panel from a 2-1 split — a
 * stored verdict discards that, and recovering it afterwards costs another paid run. The price of
 * that choice is that the quorum rule can change without a migration, which is only safe while
 * every consumer comes through here instead of writing its own.
 *
 * Total over any input: votes are de-duplicated by `modelId` (last wins), a non-positive panel
 * size is incomplete, and nothing throws.
 */
export function deriveConsensus(votes: readonly PanelVote[], panelSize: number): ConsensusVerdict {
  const byModel = new Map<string, TaskType | null>();
  for (const v of votes) byModel.set(v.modelId, v.taskType);
  const labels = [...byModel.values()].filter((t): t is TaskType => t !== null);
  if (panelSize < 1 || labels.length < panelSize) {
    return { kind: "incomplete", votes: labels.length, panelSize: Math.max(0, panelSize) };
  }
  const distinct = [...new Set(labels)].sort();
  const first = distinct[0] as TaskType;
  if (distinct.length === 1) return { kind: "unanimous", label: first, votes: labels.length };
  return { kind: "split", labels: distinct, votes: labels.length };
}

// ---------------------------------------------------------------------------
// Planning a run: what is still outstanding, and what that would cost.
// ---------------------------------------------------------------------------

/** One prompt a panelist still owes a vote on, carrying the key that vote will be stored under. */
export interface PanelWorkItem {
  readonly prompt: DistinctPrompt;
  readonly hash: string;
}

/** One panelist's share of a run: what it still owes, and how much it already has cached. */
export interface PanelPlan {
  readonly panelist: Panelist;
  readonly todo: readonly PanelWorkItem[];
  readonly cached: number;
}

/**
 * What a run still has to pay for, per panelist.
 *
 * Caching is per `(prompt, panelist)`, not per prompt: adding a panelist, or one panelist failing
 * a call, costs only the votes actually missing. `cachedKeys` holds {@link voteKey} values already
 * present AT THE CURRENT REVISION — a vote cast under another revision is not in the set, which is
 * how a revision bump becomes a cache miss rather than a stale label.
 */
export function planPanelRun(
  prompts: readonly DistinctPrompt[],
  panel: readonly Panelist[],
  cachedKeys: ReadonlySet<string>,
): PanelPlan[] {
  const hashed = prompts.map((prompt) => ({ prompt, hash: promptHash(prompt.text) }));
  return panel.map((panelist) => {
    const todo = hashed.filter((w) => !cachedKeys.has(voteKey(w.hash, panelist.model.id)));
    return { panelist, todo, cached: hashed.length - todo.length };
  });
}

/** The cost leg for one panelist: one call per prompt, at its own prices and output allowance. */
export function panelCallSpecs(panel: readonly Panelist[]): CallSpec[] {
  return panel.map((p) => ({
    label: `panel: ${p.model.id}`,
    callsPerPrompt: 1,
    inputUsdPerMTok: p.model.cost.input,
    outputUsdPerMTok: p.model.cost.output,
    // Every call pays CLASSIFY_SYSTEM, ~99 tokens against a ~17-token average prompt here.
    fixedInputTokensPerCall: LABEL_INSTRUCTION_TOKENS,
    outputTokensPerCall: p.outputTokensPerCall,
  }));
}

/**
 * Project what the OUTSTANDING work would cost — the figure the ceiling is checked against.
 *
 * Deliberately not the whole corpus: a rerun over cached labels spends nothing, and a ceiling
 * chosen against the full-corpus figure would be answering a question this run is not asking.
 * Each leg is priced by the same `estimateRunCost` the dry run uses, so there is one arithmetic
 * path and the printed total can be re-derived by hand.
 */
export function projectPanelCost(plans: readonly PanelPlan[]): CostEstimate {
  const specs = panelCallSpecs(plans.map((p) => p.panelist));
  const lines: CostLine[] = plans.map(
    (plan, i) =>
      estimateRunCost(
        plan.todo.map((w) => w.prompt),
        [specs[i] as CallSpec],
      ).lines[0] as CostLine,
  );
  const prompts = new Set(plans.flatMap((p) => p.todo.map((w) => w.hash))).size;
  return {
    prompts,
    lines,
    totalCalls: lines.reduce((n, l) => n + l.calls, 0),
    totalInputTokens: lines.reduce((n, l) => n + l.inputTokens, 0),
    totalOutputTokens: lines.reduce((n, l) => n + l.outputTokens, 0),
    totalUsd: Math.round(lines.reduce((n, l) => n + l.usd, 0) * 1e6) / 1e6,
  };
}

// ---------------------------------------------------------------------------
// The live cap: what the projection cannot promise, watched as it accrues.
// ---------------------------------------------------------------------------

/**
 * A ceiling on REALIZED spend, checked before every dispatch.
 *
 * `checkSpendCeiling` bounds the projection; this bounds the money. The projection is a chars/4
 * heuristic over declared prices and a panelist's hidden reasoning can beat it, so the run needs
 * something watching the actuals — otherwise the first surprise is the invoice.
 *
 * It bounds DISPATCH, not completion: calls already in flight when the cap trips still finish and
 * still bill, so realized spend can exceed the ceiling by at most the in-flight calls' cost. At a
 * concurrency of a handful of label calls that is cents, and the alternative — cancelling in-flight
 * work — pays for the call and throws away the vote.
 */
export interface SpendGuard {
  readonly maxUsd: number;
  spentUsd(): number;
  remainingUsd(): number;
  /** May another call be dispatched? False once realized spend has reached the ceiling. */
  mayDispatch(): boolean;
  book(usd: number): void;
}

export function makeSpendGuard(maxUsd: number): SpendGuard {
  const ceiling = Number.isFinite(maxUsd) && maxUsd > 0 ? maxUsd : 0;
  let spent = 0;
  return {
    maxUsd: ceiling,
    spentUsd: () => spent,
    remainingUsd: () => Math.max(0, ceiling - spent),
    mayDispatch: () => spent < ceiling,
    // A NaN price from a provider that reported no usage must not rewind the cap, and a negative
    // one must not buy headroom.
    book: (usd) => {
      if (Number.isFinite(usd) && usd > 0) spent += usd;
    },
  };
}

// ---------------------------------------------------------------------------
// Running the panel. The only part that spends.
// ---------------------------------------------------------------------------

/**
 * What one panelist's call produced.
 *
 * `unusable` and `failed` are distinguished because they cache differently: an unusable reply is a
 * deterministic answer (this model, this prompt, no label) and is stored so a rerun does not pay
 * for it again, while a failure is transient and stores nothing so a rerun retries. That is the
 * shipped classifier's own distinction, kept identical on purpose.
 */
export type PanelCallOutcome =
  | {
      readonly kind: "labelled";
      readonly taskType: TaskType;
      readonly difficulty?: Difficulty | null;
      readonly confidence?: number | null;
      readonly usd: number;
    }
  | { readonly kind: "unusable"; readonly usd: number }
  | { readonly kind: "failed"; readonly usd: number };

export type PanelCaller = (panelist: Panelist, promptText: string) => Promise<PanelCallOutcome>;

/** A vote, ready to be written to the ledger. Carries a hash; it never carries prompt text. */
export interface ConsensusVoteWrite {
  readonly promptHash: string;
  readonly modelId: string;
  readonly corpusRev: string;
  readonly taskType: TaskType | null;
  readonly difficulty: Difficulty | null;
  readonly confidence: number | null;
}

export interface PanelRunResult {
  readonly attempted: number;
  readonly labelled: number;
  readonly unusable: number;
  readonly failed: number;
  /** Calls never dispatched because the live cap had already been reached. */
  readonly skippedForCeiling: number;
  readonly ceilingHit: boolean;
  readonly spentUsd: number;
}

/** Concurrency: enough to finish a few hundred label calls in minutes, low enough that the live
 * cap's in-flight overshoot stays a rounding error and no provider sees a burst. */
const DEFAULT_CONCURRENCY = 6;

export interface RunPanelOptions {
  readonly plans: readonly PanelPlan[];
  readonly corpusRev: string;
  readonly call: PanelCaller;
  readonly record: (vote: ConsensusVoteWrite) => void;
  readonly guard: SpendGuard;
  readonly concurrency?: number;
  readonly onProgress?: (done: number, total: number, spentUsd: number) => void;
}

/**
 * Run the outstanding work, recording each vote as it lands.
 *
 * Votes are written ONE AT A TIME as they arrive, never batched at the end: a run that dies at
 * call 400 of 714 must keep the 400 votes it paid for, and a rerun must owe only the rest.
 *
 * The cap is checked immediately before each dispatch, so a run that trips it stops paying rather
 * than finishing the queue. Neither a caller that throws nor a `record` that throws can end the
 * run — a bookkeeping failure must not cost the votes still to come.
 */
export async function runPanel(opts: RunPanelOptions): Promise<PanelRunResult> {
  const queue = opts.plans.flatMap((plan) =>
    plan.todo.map((item) => ({ panelist: plan.panelist, item })),
  );
  let next = 0;
  let attempted = 0;
  let labelled = 0;
  let unusable = 0;
  let failed = 0;
  let skipped = 0;
  let spent = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const job = queue[i];
      if (job === undefined) return;
      if (!opts.guard.mayDispatch()) {
        skipped++;
        continue;
      }
      attempted++;
      let outcome: PanelCallOutcome;
      try {
        outcome = await opts.call(job.panelist, job.item.prompt.text);
      } catch {
        outcome = { kind: "failed", usd: 0 };
      }
      opts.guard.book(outcome.usd);
      if (Number.isFinite(outcome.usd) && outcome.usd > 0) spent += outcome.usd;
      if (outcome.kind === "failed") {
        failed++;
      } else {
        if (outcome.kind === "labelled") labelled++;
        else unusable++;
        try {
          opts.record({
            promptHash: job.item.hash,
            modelId: job.panelist.model.id,
            corpusRev: opts.corpusRev,
            taskType: outcome.kind === "labelled" ? outcome.taskType : null,
            difficulty: outcome.kind === "labelled" ? (outcome.difficulty ?? null) : null,
            confidence: outcome.kind === "labelled" ? (outcome.confidence ?? null) : null,
          });
        } catch {
          // A ledger write that fails costs this one vote, never the run.
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
  return {
    attempted,
    labelled,
    unusable,
    failed,
    skippedForCeiling: skipped,
    ceilingHit: skipped > 0,
    spentUsd: spent,
  };
}

/** Bounded output per call: high enough that a reasoning panelist can think and still answer, low
 * enough that a runaway costs cents. Set below any panelist's `max_tokens` on purpose. */
const PANEL_MAX_TOKENS = 1024;
/** A label call is small; a panelist that has not answered in this long is not going to. */
const PANEL_TIMEOUT_S = 60;

/**
 * The real caller: the shipped classify call, made by a stronger model.
 *
 * `CLASSIFY_SYSTEM` verbatim, `parseClassification` verbatim, no session-context size hint (the
 * corpus is prompts, not sessions — and MUB-218's replay will have none either, so the two stay
 * comparable). Prompt caching is off: 238 distinct prompts share only the system prompt, and a
 * cache write costs more than the read saves at this size.
 *
 * An `error` stop reason is a FAILURE (transient — no row, so a rerun retries); a reply that will
 * not parse is UNUSABLE (deterministic — cached as a null label). Cost comes from the provider's
 * reported usage, so a panelist that reasons server-side bills what it actually burned rather than
 * what the projection guessed.
 */
export function makePanelCaller(
  signal?: AbortSignal,
  completeFn: typeof complete = complete,
): PanelCaller {
  return async (panelist, promptText) => {
    const resp = await completeFn(
      panelist.model,
      {
        system_prompt: CLASSIFY_SYSTEM,
        messages: [new Message({ role: "user", content: promptText.slice(0, 8000) })],
        tools: [],
      },
      {
        options: {
          timeout: PANEL_TIMEOUT_S,
          prompt_cache: false,
          max_tokens: PANEL_MAX_TOKENS,
        },
        ...(signal ? { signal } : {}),
      },
    );
    const usdRaw = resp.usage?.cost?.total;
    const usd = Number.isFinite(usdRaw) ? (usdRaw as number) : 0;
    if (resp.stop_reason === "error") return { kind: "failed", usd };
    const cls = parseClassification(resp.textContent);
    if (!cls) return { kind: "unusable", usd };
    return {
      kind: "labelled",
      taskType: cls.taskType,
      difficulty: cls.difficulty,
      confidence: cls.confidence,
      usd,
    };
  };
}

// ---------------------------------------------------------------------------
// The report. Counts, denominators and labels — never a prompt, never a hash.
// ---------------------------------------------------------------------------

/** How often the panel was unanimous on one task type, over the panels where anyone named it. */
export interface LabelAgreement {
  readonly label: TaskType;
  readonly unanimous: Rate;
}

/** Two task types the panel put on the same prompt. The disagreement, named. */
export interface DisagreementPair {
  readonly labels: readonly [TaskType, TaskType];
  readonly count: number;
}

/** One panelist's coverage: how often it produced a usable label at all. */
export interface PanelistStat {
  readonly modelId: string;
  readonly lineage: string;
  readonly usable: Rate;
}

/** How often two panelists landed on the same label, over the prompts both labelled. */
export interface PairwiseAgreement {
  readonly a: string;
  readonly b: string;
  readonly agree: Rate;
}

export interface PanelReport {
  readonly corpusRev: string;
  readonly panel: readonly { readonly modelId: string; readonly lineage: string }[];
  readonly corpusPrompts: number;
  /** Prompts where EVERY panelist produced a usable label — the only scoreable population. */
  readonly completePanels: Rate;
  /** THE headline: unanimous panels over complete panels. Also this evaluation's reliability bound. */
  readonly unanimity: Rate;
  readonly split: number;
  readonly incomplete: number;
  /** Prompts that earned a pseudo-gold label. Equals `unanimity.n`, named for what it is. */
  readonly referenceLabels: number;
  readonly excludedSplit: number;
  readonly excludedIncomplete: number;
  readonly perLabel: readonly LabelAgreement[];
  readonly topDisagreements: readonly DisagreementPair[];
  readonly panelists: readonly PanelistStat[];
  readonly pairwise: readonly PairwiseAgreement[];
}

/** How many disagreeing pairs the readout names. Enough to see the shape, few enough to read. */
const TOP_DISAGREEMENTS = 8;

/**
 * Assemble the panel's readout from the corpus and the stored votes. Pure: reads nothing, spends
 * nothing, and holds no prompt text.
 *
 * Votes are filtered three ways before anything is counted — to the stated revision, to prompts
 * still in the corpus, and to models still in the panel. Each of those is a way for a figure to
 * quietly describe a different experiment than its heading claims.
 */
export function buildPanelReport(
  prompts: readonly DistinctPrompt[],
  panel: readonly Panelist[],
  votes: readonly {
    prompt_hash: string;
    model_id: string;
    corpus_rev: string;
    task_type: string | null;
  }[],
  corpusRev: string,
): PanelReport {
  const panelIds = panel.map((p) => p.model.id);
  const inPanel = new Set(panelIds);
  const corpusHashes = new Set(prompts.map((p) => promptHash(p.text)));

  /** hash -> modelId -> label (null = answered with nothing usable). */
  const byPrompt = new Map<string, Map<string, TaskType | null>>();
  for (const v of votes) {
    if (v.corpus_rev !== corpusRev) continue;
    if (!corpusHashes.has(v.prompt_hash)) continue;
    if (!inPanel.has(v.model_id)) continue;
    const cell = byPrompt.get(v.prompt_hash) ?? new Map<string, TaskType | null>();
    cell.set(v.model_id, (v.task_type as TaskType | null) ?? null);
    byPrompt.set(v.prompt_hash, cell);
  }

  let complete = 0;
  let unanimous = 0;
  let split = 0;
  let incomplete = 0;
  const namedIn = new Map<TaskType, number>();
  const unanimousOn = new Map<TaskType, number>();
  const pairCounts = new Map<string, number>();
  const usableByModel = new Map<string, number>();
  const pairAgree = new Map<string, { n: number; d: number }>();

  for (const hash of corpusHashes) {
    const cell = byPrompt.get(hash) ?? new Map<string, TaskType | null>();
    for (const [modelId, label] of cell) {
      if (label !== null) usableByModel.set(modelId, (usableByModel.get(modelId) ?? 0) + 1);
    }
    // Pairwise agreement is over prompts BOTH panelists labelled, so a panelist that abstained
    // cannot look like a disagreement.
    for (let i = 0; i < panelIds.length; i++) {
      for (let j = i + 1; j < panelIds.length; j++) {
        const a = cell.get(panelIds[i] as string) ?? null;
        const b = cell.get(panelIds[j] as string) ?? null;
        if (a === null || b === null) continue;
        const key = `${panelIds[i]} ${panelIds[j]}`;
        const acc = pairAgree.get(key) ?? { n: 0, d: 0 };
        acc.d++;
        if (a === b) acc.n++;
        pairAgree.set(key, acc);
      }
    }
    const verdict = deriveConsensus(
      [...cell].map(([modelId, taskType]) => ({ modelId, taskType })),
      panel.length,
    );
    if (verdict.kind === "incomplete") {
      incomplete++;
      continue;
    }
    complete++;
    const named = verdict.kind === "unanimous" ? [verdict.label] : verdict.labels;
    for (const label of named) namedIn.set(label, (namedIn.get(label) ?? 0) + 1);
    if (verdict.kind === "unanimous") {
      unanimous++;
      unanimousOn.set(verdict.label, (unanimousOn.get(verdict.label) ?? 0) + 1);
      continue;
    }
    split++;
    // Every unordered pair of labels that landed on this prompt. A three-way split contributes
    // three pairs, because all three of those confusions really did happen.
    for (let i = 0; i < verdict.labels.length; i++) {
      for (let j = i + 1; j < verdict.labels.length; j++) {
        const key = `${verdict.labels[i]} ${verdict.labels[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const perLabel = [...namedIn]
    .map(([label, d]) => ({ label, unanimous: rate(unanimousOn.get(label) ?? 0, d) }))
    .sort((x, y) => y.unanimous.d - x.unanimous.d || x.label.localeCompare(y.label));

  const topDisagreements = [...pairCounts]
    .map(([key, count]) => {
      const [a, b] = key.split(" ") as [TaskType, TaskType];
      return { labels: [a, b] as readonly [TaskType, TaskType], count };
    })
    .sort((x, y) => y.count - x.count || x.labels[0].localeCompare(y.labels[0]))
    .slice(0, TOP_DISAGREEMENTS);

  return {
    corpusRev,
    panel: panel.map((p) => ({ modelId: p.model.id, lineage: p.lineage })),
    corpusPrompts: corpusHashes.size,
    completePanels: rate(complete, corpusHashes.size),
    unanimity: rate(unanimous, complete),
    split,
    incomplete,
    referenceLabels: unanimous,
    excludedSplit: split,
    excludedIncomplete: incomplete,
    perLabel,
    topDisagreements,
    panelists: panel.map((p) => ({
      modelId: p.model.id,
      lineage: p.lineage,
      usable: rate(usableByModel.get(p.model.id) ?? 0, corpusHashes.size),
    })),
    pairwise: [...pairAgree].map(([key, acc]) => {
      const [a, b] = key.split(" ") as [string, string];
      return { a, b, agree: rate(acc.n, acc.d) };
    }),
  };
}

/**
 * Render the panel's readout. Lives beside the counting so the shell cannot reformat a number on
 * its way out, and so "no prompt text, no hashes, every rate with its denominator" is testable
 * without running the script.
 */
export function renderPanelReport(r: PanelReport): string {
  const lines: string[] = [
    "Reference panel — consensus labels (MUB-216)",
    `corpus revision: ${r.corpusRev}`,
    "panel (one model per training lineage):",
  ];
  for (const p of r.panel) lines.push(`  ${p.modelId.padEnd(24)} ${p.lineage}`);
  lines.push(
    "",
    "Coverage",
    `  distinct prompts in corpus   ${r.corpusPrompts}`,
    `  complete panels              ${formatRate(r.completePanels)}  (every panelist produced a label)`,
    `  incomplete                   ${r.incomplete}`,
    "",
    "Agreement — the headline, and this evaluation's reliability metric",
    `  UNANIMOUS -> reference label ${formatRate(r.unanimity)}`,
    `  split, excluded from scored  ${formatRate(rate(r.split, r.completePanels.n))}`,
    "",
    `Scored set: ${r.referenceLabels} reference labels · ${r.excludedSplit} excluded as split` +
      ` · ${r.excludedIncomplete} excluded as incomplete · ${r.corpusPrompts} corpus`,
  );

  lines.push("", "Unanimity per task type");
  if (r.perLabel.length === 0) {
    lines.push("  no complete panels to break down");
  }
  for (const l of r.perLabel) {
    lines.push(`  ${l.label.padEnd(28)} ${formatRate(l.unanimous)}`);
  }

  lines.push("", "Task types the panel most often disagrees on");
  if (r.topDisagreements.length === 0) {
    lines.push("  none — no split panels");
  }
  for (const d of r.topDisagreements) {
    lines.push(`  ${`${d.labels[0]} vs ${d.labels[1]}`.padEnd(28)} ${d.count}`);
  }

  lines.push("", "Panelists — how often each produced a usable label");
  for (const p of r.panelists) {
    lines.push(`  ${p.modelId.padEnd(24)} ${formatRate(p.usable)}`);
  }
  if (r.pairwise.length) {
    lines.push("", "Pairwise agreement (over prompts both panelists labelled)");
    for (const p of r.pairwise) {
      lines.push(`  ${`${p.a} vs ${p.b}`.padEnd(44)} ${formatRate(p.agree)}`);
    }
  }

  // The panel's limits travel with the report, not alongside it.
  lines.push(
    "",
    "What these labels are, which travels with every figure above:",
    "  · CONSENSUS IS NOT TRUTH. Three models agreeing is evidence of an easy, well-specified",
    "    prompt — not proof of the right answer. Shared blind spots remain possible: all three",
    "    were trained on overlapping public text and can be wrong together, and no lineage",
    "    separation prevents that. Treat a unanimous label as pseudo-gold, never as gold.",
    "  · Unanimity is denominated in COMPLETE panels, not in the corpus. A prompt where a",
    "    panelist produced no usable label is incomplete, never a 2-of-2 agreement — two",
    "    agreeing panelists out of three have not agreed unanimously.",
    "  · Per-task-type denominators are 'complete panels where at least one panelist named this",
    "    type', so they sum to MORE than the corpus: a split prompt lands in the denominator of",
    "    every type named on it. Attributing a split to its majority type instead would hide the",
    "    disagreement this section exists to show.",
    "  · A low unanimity rate is a finding about the TAXONOMY or the instruction, not only about",
    "    the classifier. If three strong models given the shipped instruction cannot agree on what",
    "    a prompt is, no classifier can be scored against it — that result stands on its own.",
    "  · Panelists answer the shipped CLASSIFY_SYSTEM verbatim, parsed by the shipped parser, so",
    "    a measured gap is model capability rather than prompt difference.",
    "  · One developer's traffic, a few hundred prompts. Aggregate figures mean something;",
    "    per-task-type figures over single-digit denominators mostly will not.",
  );
  return lines.join("\n");
}
