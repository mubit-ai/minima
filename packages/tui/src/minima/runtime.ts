/**
 * MinimaAgent — an Agent that routes each prompt through Minima and feeds the realized
 * outcome back.
 *
 * Port of the Python harness's minima/runtime.py (focused core). Per promptRouted(): (1) ask
 * Minima which model and set state.model, (2) run the agent loop, (3) judge the final
 * answer and send POST /v1/feedback with realized tokens/cost/latency. Routing is
 * bypassable: if Minima is unreachable and allowOffline is set, the run proceeds on the
 * current model with no feedback. Bookkeeping failures are logged-and-swallowed so the
 * Minima round-trip never breaks the caller's run.
 *
 * (The Python runtime's dead-key auto-reroute, signals extractor, and diff-approval
 * rejected-tools land in a later phase; this port covers the core loop faithfully.)
 */

import { Agent, type AgentOptions } from "../agent/agent.ts";
import type { ThinkingLevel } from "../agent/tools.ts";
import { providerKeyPresent } from "../ai/provider_catalog.ts";
import type { Model, Usage } from "../ai/types.ts";
import { Usage as UsageClass } from "../ai/types.ts";
import { AssistantMessage } from "../ai/types.ts";
import { type MinimaDb, newId } from "../db/minima_db.ts";
import { errText } from "../errtext.ts";
import { type BudgetLedger, reserveAmount } from "./budget.ts";
import { type HarnessConfig, refreshRoutingEnv } from "./config.ts";
import {
  GROUND_TRUTH_SYSTEM_GUIDANCE,
  type GroundedOutcome,
  groundedOutcomeFor,
  planProjectionFor,
  stampGroundedOutcome,
} from "./ground_truth.ts";
import { type QualityJudge, clamp01 } from "./judge.ts";
import { ModelMapping } from "./mapping.ts";
import { type HarnessMemory, NoopHarnessMemory, formatRecallBlock } from "./memory.ts";
import type { CostMeter } from "./meter.ts";
import { MinimaRouter, type RoutingResult } from "./router.ts";

/** Inspect/override a recommendation before the model runs. Return a result to override;
 * null to accept as-is; a result with recommendationId=null to veto (no feedback attribution). */
export type BeforeRoute = (routing: RoutingResult, task: string) => Promise<RoutingResult | null>;

export interface MinimaAgentOptions extends Omit<AgentOptions, "model"> {
  config: HarnessConfig;
  router?: MinimaRouter;
  judge?: QualityJudge;
  mapping?: ModelMapping;
  model?: Model;
  meter?: CostMeter;
  beforeRoute?: BeforeRoute;
  taskType?: string;
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  /** Mubit memory seam: recall-before-route + write-back. Defaults to a no-op. */
  memory?: HarnessMemory;
  /** Recovery-ladder retries per prompt (default 2; 0 disables the ladder). */
  recoveryRungs?: number;
}

export function gradeOutcome(quality: number): "success" | "partial" | "failure" {
  if (quality >= 0.8) return "success";
  if (quality >= 0.4) return "partial";
  return "failure";
}

/** Effort Phase A: server-classified difficulty → per-prompt thinking level. */
export const EFFORT_BY_DIFFICULTY: Record<string, ThinkingLevel> = {
  trivial: "off",
  easy: "off",
  medium: "low",
  hard: "medium",
  expert: "high",
};

export class MinimaAgent extends Agent {
  readonly config: HarnessConfig;
  readonly mapping: ModelMapping;
  router: MinimaRouter;
  judge: QualityJudge;
  readonly meter: CostMeter | null;
  private readonly beforeRouteHook: BeforeRoute | null;
  private readonly taskTypeHint: string | null;
  private promptsRun = 0;
  /** Why the last route fell back to offline (null = routed fine). */
  offlineReason: string | null = null;
  /** Why the last feedback write failed (null = ok). Non-fatal — kept for diagnostics. */
  lastFeedbackError: string | null = null;
  /** Mubit memory: recall-before-route + write-back. No-op unless wired in. */
  memory: HarnessMemory;
  /** Persistence spine (optional): when set with runId, every routed prompt writes a
   * durable DecisionRecord — the replay buffer + provenance substrate. */
  db: MinimaDb | null = null;
  runId: string | null = null;
  /** Set for sub-agents so their rows demux from the lead's. */
  agentId: string | null = null;
  /** Budget following (optional): reserve-after-route / reconcile-after-run, graduated
   * warnings, and (enforce mode) refusal once exhausted. */
  budget: BudgetLedger | null = null;
  /** Recovery-ladder retries per prompt (total attempts = 1 + rungs; 0 disables). */
  recoveryRungs = 2;
  /** How many ladder escalations happened this session (diagnostics). */
  ladderEscalations = 0;
  /** Effort routing Phase A (staged, default OFF): map the server's classified difficulty
   * to a per-prompt thinking level — route (model, effort), not just model. */
  autoEffort = false;
  /** Aborts the routing phase (the recommend HTTP call) — the base Agent's own
   * controller only covers the run phase. Set for the lifetime of promptRouted. */
  private routeController: AbortController | null = null;
  /** True when the last promptRouted was cut short by Esc during routing (so the
   * UI shows "aborted" instead of a misleading "routing offline" note). */
  lastAborted = false;

  /** Esc must stop BOTH phases: the in-flight route and the model run. */
  override abort(): void {
    this.routeController?.abort();
    super.abort();
  }

  constructor(opts: MinimaAgentOptions) {
    const {
      config,
      router,
      judge,
      mapping,
      model,
      meter,
      beforeRoute,
      taskType,
      memory,
      recoveryRungs,
      ...agentOpts
    } = opts;
    const map = mapping ?? router?.mapping ?? new ModelMapping();
    const initial = model ?? map.defaultModel();
    super({ ...agentOpts, model: initial });
    this.config = config;
    this.mapping = map;
    this.router = router ?? MinimaRouter.forConfig(config, map);
    this.judge = judge ?? { grade: async () => null };
    this.meter = meter ?? null;
    this.beforeRouteHook = beforeRoute ?? null;
    this.taskTypeHint = taskType ?? null;
    this.memory = memory ?? new NoopHarnessMemory();
    this.recoveryRungs = recoveryRungs ?? 2;
  }

  /** Rebuild the Minima client from the current environment (/reconnect, /auth, /config set). */
  reconnect(): void {
    // Re-read MINIMA_URL / MUBIT_API_KEY from the env so a key set mid-session
    // (via /config set or /auth) actually reaches the rebuilt client.
    refreshRoutingEnv(this.config);
    this.router = MinimaRouter.forConfig(this.config, this.mapping);
    this.offlineReason = null;
  }

  /**
   * Route -> run -> judge -> feedback. Returns the routing result (null when offline with
   * no routing produced).
   */
  async promptRouted(
    content: string,
    opts: {
      taskType?: string;
      slider?: number;
      tags?: string[];
      difficulty?: string;
      maxCostPerCall?: number;
      minQuality?: number;
      excludedModels?: string[];
    } = {},
  ): Promise<RoutingResult | null> {
    const effectiveTaskType = opts.taskType ?? this.taskTypeHint;
    this.promptsRun += 1;
    // The surfaced learning-loop note must reflect THIS turn only. Reset here because
    // feedbackSafely early-returns without touching the field on turns that send no feedback
    // (pinned / offline / no-recommendation) — otherwise an earlier rejection would re-display
    // indefinitely on later pinned turns.
    this.lastFeedbackError = null;

    // Fresh abort scope for THIS prompt's routing phase; abort() (Esc) cancels it.
    const routeController = new AbortController();
    this.routeController = routeController;
    this.lastAborted = false;

    // Recall-before-route: inject task-relevant prior Mubit context into THIS turn's system
    // prompt (restored in `finally` — no leak across turns). No-op unless memory is wired.
    const origSystem = this.agentState.systemPrompt;
    const origThinking = this.agentState.thinkingLevel;
    const recalled = await this.memory.recall(content);
    if (recalled.length > 0) {
      const block = formatRecallBlock(recalled);
      this.agentState.systemPrompt = origSystem ? `${origSystem}\n\n${block}` : block;
    }
    // Ground-Truth: inject the verify contract + the plan of record into THIS turn's system
    // prompt (appended after recall, reverted together in `finally`). Off unless groundTruth is set.
    //   1. The static contract (GROUND_TRUTH_SYSTEM_GUIDANCE) goes in EVERY groundTruth turn,
    //      including the first — before any plan exists — so the model learns to attach a `verify`
    //      to each checkable step WHEN IT AUTHORS THE PLAN, not one turn late.
    //   2. The plan projection (M1.2) then shows the current numbered plan with its active step;
    //      planProjectionFor returns null until the first todowrite has created a plan.
    if (this.config.groundTruth) {
      const withGuidance = this.agentState.systemPrompt;
      this.agentState.systemPrompt = withGuidance
        ? `${withGuidance}\n\n${GROUND_TRUTH_SYSTEM_GUIDANCE}`
        : GROUND_TRUTH_SYSTEM_GUIDANCE;
      const planBlock = planProjectionFor(this.db, this.runId);
      if (planBlock) {
        const cur = this.agentState.systemPrompt;
        this.agentState.systemPrompt = cur ? `${cur}\n\n${planBlock}` : planBlock;
      }
    }
    try {
      // Recovery ladder: walk SERVER-SUPPLIED rungs (fresh recommend per rung with the
      // failed model excluded — never a client-side re-rank, which would corrupt the
      // server's logged propensities). Triggers: a provider hard failure, or a REAL judge
      // grade below the rung's τ. Never retries on a null judge. Max attempts = 1 + rungs.
      const excluded = [...(opts.excludedModels ?? [])];
      const preRunIdx = this.agentState.messages.length;
      let firstRecId: string | null = null;
      let lastError: unknown = null;
      let lastRouting: RoutingResult | null = null;

      for (let attempt = 0; attempt <= this.recoveryRungs; attempt++) {
        // Budget gate (enforce mode only): refuse BEFORE any provider spend.
        if (this.budget && this.budget.mode === "enforce" && this.budget.exhausted()) {
          if (attempt > 0) break; // keep the last rung's (failed) result; never overrun
          const s = this.budget.status();
          throw new Error(
            `budget exhausted: $${s.spentUsd.toFixed(4)} spent of $${s.limitUsd.toFixed(2)} — raise it with /budget set <usd> or relax with /budget mode warn`,
          );
        }
        let routing: RoutingResult | null;
        try {
          routing = await this.route(content, {
            taskType: effectiveTaskType ?? null,
            slider: opts.slider ?? null,
            tags: opts.tags,
            difficulty: opts.difficulty,
            // The remaining budget rides into the server as a (soft) per-call cost cap.
            maxCostPerCall: opts.maxCostPerCall ?? this.budget?.maxCostPerCall(),
            minQuality: opts.minQuality,
            excludedModels: excluded.length ? excluded : undefined,
            signal: routeController.signal,
          });
        } catch (exc) {
          // Esc during routing: stop cleanly, don't run the model, don't record.
          if (routeController.signal.aborted) {
            this.offlineReason = null;
            this.lastAborted = true;
            return lastRouting;
          }
          throw exc;
        }
        // Aborted the instant routing returned (before any spend): end right here.
        if (routeController.signal.aborted) {
          this.offlineReason = null;
          this.lastAborted = true;
          return routing;
        }
        lastRouting = routing;
        if (firstRecId === null) firstRecId = routing?.recommendationId ?? null;

        // Effort routing Phase A: the second decision axis. The server's classified
        // difficulty picks THIS prompt's thinking level (restored after the prompt).
        if (this.autoEffort && routing?.classifiedDifficulty) {
          const effort = EFFORT_BY_DIFFICULTY[routing.classifiedDifficulty];
          if (effort !== undefined) this.agentState.thinkingLevel = effort;
        }

        // Reserve-after-route: hold a padded estimate so parallel agents sharing this
        // scope can't jointly overshoot; reconciled with realized cost after the run.
        let reservationId: string | null = null;
        if (this.budget && routing) {
          const r = this.budget.reserve(
            reserveAmount(routing.estCostUsd, routing.estCostHigh),
            shortLabel(content),
          );
          if (r.ok) reservationId = r.id;
          else if (this.budget.mode === "enforce") {
            if (attempt > 0) break;
            throw new Error(r.reason);
          }
        }
        // Mid-run stop: once realized spend crosses the limit, finish the CURRENT turn
        // (the model gets its wrap-up) and stop gracefully — no partial-tool corruption.
        if (this.budget) {
          let runSpend = 0;
          const limitLeft = this.budget.status().remainingUsd;
          const enforce = this.budget.mode === "enforce";
          this.setShouldStopAfterTurn(async (assistant) => {
            runSpend += assistant.usage.cost.total;
            return enforce && runSpend >= limitLeft;
          });
        }
        // Everything appended from here belongs to THIS rung (for rung-total usage).
        const runStartIdx = this.agentState.messages.length;
        const start = Date.now();
        let runError: unknown = null;
        try {
          await super.prompt(content);
        } catch (exc) {
          runError = exc;
        } finally {
          if (this.budget) this.setShouldStopAfterTurn(null);
        }
        const latencyMs = Date.now() - start;
        const turnsTaken = this.agentState.turnsTaken;
        const last = this.lastAssistant();
        const failed = runError !== null || (last !== null && last.stop_reason === "error");
        // Rung-TOTAL usage: a multi-turn run has one assistant message per turn — summing
        // is what makes the reported cost truthful (last-turn-only under-reports and
        // corrupts the server's observed-cost basis).
        const runUsage = this.usageSince(runStartIdx);
        // Swap the reservation for realized spend (even on error — partial spend is real).
        if (this.budget && reservationId) {
          this.budget.reconcile(reservationId, runUsage.cost.total, routing?.recommendationId);
        }

        // Per-rung feedback: the failed rung's outcome reaches the server too — that IS
        // the signal that sharpens the next recommendation.
        const { quality, outcome, reinforcedEntryIds, lessonPromoted, grounded } =
          await this.feedbackSafely(content, routing, runUsage, latencyMs, failed, turnsTaken);

        if (this.meter) {
          this.meter.record({
            label:
              attempt > 0 ? `${shortLabel(content)} (rung ${attempt + 1})` : shortLabel(content),
            routing,
            actualCostUsd: runUsage.cost.total,
            quality: failed ? 0 : quality,
            outcome: failed ? "failure" : outcome,
            turns: turnsTaken,
          });
        }

        this.persistDecision(content, routing, {
          actualCostUsd: runUsage.cost.total,
          quality: failed ? 0 : quality,
          judged: (failed ? 0 : quality) !== null,
          outcome: failed ? "failure" : outcome,
          turns: turnsTaken,
          latencyMs,
          taskType: effectiveTaskType ?? null,
          difficulty: opts.difficulty ?? null,
          parentRecId: attempt > 0 ? firstRecId : null,
          reinforcedEntryIds,
          lessonPromoted,
        });

        // Escalate? Only with a rung left, a routed (non-pinned) decision to learn from,
        // and a REAL trigger: provider failure, a non-null judge grade below τ, or a grounded
        // check that failed. M7.3: a red gate (failed|unrunnable) outranks the judge as a
        // trigger — the same ladder that recovers judge-failures now recovers check-failures.
        const judgeFailed =
          !failed && quality !== null && routing !== null && quality < routing.thresholdUsed;
        const gateFailed = grounded !== null && grounded.outcome !== "verified";
        const failedModel =
          routing !== null && routing.recommendationId !== null ? routing.chosenModelId : null;
        const canEscalate =
          attempt < this.recoveryRungs &&
          failedModel !== null &&
          (failed || judgeFailed || gateFailed);
        if (!canEscalate) {
          if (runError !== null) throw runError;
          return routing;
        }
        // Roll back this rung's messages so the retry starts from the same context the
        // failed rung saw (no confusing half-answers in the next rung's prompt).
        this.agentState.messages.length = preRunIdx;
        excluded.push(failedModel);
        lastError = runError;
        this.ladderEscalations += 1;
      }
      if (lastError !== null) throw lastError;
      return lastRouting;
    } finally {
      // Never let this turn's recalled context or effort override leak into the next turn.
      this.agentState.systemPrompt = origSystem;
      if (this.autoEffort) this.agentState.thinkingLevel = origThinking;
      if (this.routeController === routeController) this.routeController = null;
    }
  }

  /**
   * Persist this prompt's DecisionRecord — the row that closes the local learning loop
   * (replay buffer for regret-vs-oracle) and grounds later provenance. Idempotent on
   * rec_id; offline/pinned rows get a synthetic local id (never the hosted join key) and
   * are labeled so metrics can report them as unrouted spend. Fail-open: a write failure
   * marks the run degraded, never breaks the turn.
   */
  private persistDecision(
    taskText: string,
    routing: RoutingResult | null,
    o: {
      actualCostUsd: number;
      quality: number | null;
      judged: boolean;
      outcome: "success" | "partial" | "failure";
      turns: number;
      latencyMs: number;
      taskType: string | null;
      difficulty: string | null;
      /** First rung's rec_id when this row is a ladder retry (links the escalation chain). */
      parentRecId?: string | null;
      /** Mubit-side provenance from FeedbackResponse (cited by the work record). */
      reinforcedEntryIds?: string[] | null;
      lessonPromoted?: boolean | null;
    },
  ): void {
    if (!this.db || !this.runId) return;
    try {
      const routed: "server" | "offline" | "pinned" =
        routing === null ? "offline" : routing.recommendationId === null ? "pinned" : "server";
      const recId = routing?.recommendationId ?? `local-${newId()}`;
      const eventId = this.db.appendEvent({
        runId: this.runId,
        agentId: this.agentId,
        type: "routing",
        payload: {
          rec_id: recId,
          routed,
          chosen_model: routing?.chosenModelId ?? this.agentState.model?.id ?? null,
          decision_basis: routing?.decisionBasis ?? "offline",
          warnings: routing?.warnings ?? [],
          offline_reason: routed === "offline" ? this.offlineReason : undefined,
        },
      });
      this.db.writeDecision({
        recId,
        runId: this.runId,
        eventId,
        agentId: this.agentId,
        parentRecId: o.parentRecId ?? null,
        taskLabel: shortLabel(taskText),
        taskType: routing?.classifiedTaskType || o.taskType,
        difficulty: routing?.classifiedDifficulty || o.difficulty,
        chosenModel: routing?.chosenModelId ?? this.agentState.model?.id ?? null,
        decisionBasis: routing?.decisionBasis ?? "offline",
        selectionPolicy: routing?.selectionPolicy ?? null,
        confidence: routing?.confidence ?? 0,
        thresholdUsed: routing?.thresholdUsed ?? 0,
        ranked: routing?.ranked ?? [],
        estCostUsd: routing?.estCostUsd ?? 0,
        estCostLow: routing?.estCostLow ?? null,
        estCostHigh: routing?.estCostHigh ?? null,
        allPremiumCostUsd: routing?.ranked.length
          ? Math.max(...routing.ranked.map((r) => r.estCostUsd))
          : null,
        configuredBaselineCostUsd: routing?.baselineCostUsd ?? null,
        actualCostUsd: o.actualCostUsd,
        quality: o.quality,
        judged: o.judged,
        outcome: o.outcome,
        routed,
        turns: o.turns,
        latencyMs: o.latencyMs,
        reinforcedEntryIds: o.reinforcedEntryIds ?? null,
        lessonPromoted: o.lessonPromoted ?? null,
      });
      // M7.1: once the decision row exists, stamp the grounded (deterministic) verdict of the
      // step verified under it onto gt_* — a real check outranks the judge. Inert until gates
      // exist (Track A / /gt-seed); fail-open inside the helper.
      if (this.config.groundTruth) {
        stampGroundedOutcome(this.db, this.runId, recId);
      }
    } catch {
      try {
        this.db.markDegraded(this.runId);
      } catch {
        // persistence is fail-open — never break the turn
      }
    }
  }

  /** Sum usage over the assistant messages appended since `startIdx` (this run's turns). */
  private usageSince(startIdx: number): Usage {
    const total = new UsageClass();
    for (let i = startIdx; i < this.agentState.messages.length; i++) {
      const m = this.agentState.messages[i];
      if (!(m instanceof AssistantMessage)) continue;
      total.input += m.usage.input;
      total.output += m.usage.output;
      total.cache_read += m.usage.cache_read;
      total.cache_write += m.usage.cache_write;
      total.cost.input += m.usage.cost.input;
      total.cost.output += m.usage.cost.output;
      total.cost.cache_read += m.usage.cost.cache_read;
      total.cost.cache_write += m.usage.cost.cache_write;
      total.cost.total += m.usage.cost.total;
    }
    return total;
  }

  /** Distil this run into durable Mubit memory (reflect + checkpoint). Call at shutdown. */
  async endSession(): Promise<void> {
    await this.memory.endSession();
  }

  /** Restore the routed-prompt count (judge cadence) when rehydrating a persisted run. */
  setPromptsRun(n: number): void {
    this.promptsRun = Math.max(0, Math.floor(n));
  }

  // ------------------------------------------------------------------ routing
  private async route(
    taskText: string,
    opts: {
      taskType: string | null;
      slider: number | null;
      tags: string[] | undefined;
      difficulty?: string;
      maxCostPerCall?: number;
      minQuality?: number;
      excludedModels?: string[];
      signal?: AbortSignal;
    },
  ): Promise<RoutingResult | null> {
    // A hard pin bypasses Minima entirely: run that model directly.
    if (this.config.pinned) {
      const pinnedId = this.config.candidates[0];
      const model = pinnedId
        ? this.mapping.resolve(this.providerOf(pinnedId) ?? "", pinnedId)
        : undefined;
      if (model) {
        this.agentState.model = model;
        this.offlineReason = null;
        return pinnedResult(model);
      }
    }
    try {
      // Only let Minima pick models the user can actually run: restrict candidates to those
      // whose provider key is present, so a routed turn never dies with a provider auth error.
      // If NO candidate is runnable (no provider keys at all), fall back to the full set and
      // let the provider layer surface an actionable "no API key" message.
      const runnable = this.config.candidates.filter((id) => {
        const m = this.mapping.resolve(this.providerOf(id) ?? "", id);
        return m ? providerKeyPresent(m.provider) : false;
      });
      const effective = runnable.length ? runnable : undefined;
      const routing = await this.router.recommend({
        task: taskText,
        taskType: opts.taskType ?? undefined,
        slider: opts.slider ?? undefined,
        tags: opts.tags,
        difficulty: opts.difficulty,
        // The live context IS the input the chosen model will read — the server's cost
        // estimate is only truthful when it knows the real prompt size.
        expectedInputTokens: this.estimateContextTokens(taskText),
        candidates: effective,
        maxCostPerCall: opts.maxCostPerCall,
        minQuality: opts.minQuality,
        excludedModels: opts.excludedModels,
        // The server caps candidate selection at 8 by default; widen when the pool is larger.
        maxCandidates:
          effective && effective.length > 8 ? Math.min(effective.length, 16) : undefined,
        signal: opts.signal,
      });
      this.offlineReason = null;
      if (this.beforeRouteHook) {
        const overridden = await this.beforeRouteHook(routing, taskText);
        if (overridden) return overridden;
      }
      this.agentState.model = routing.model;
      return routing;
    } catch (exc) {
      // An Esc during routing is a user abort, NOT a routing failure — never
      // degrade it to an offline run; let promptRouted short-circuit cleanly.
      if (opts.signal?.aborted) throw exc;
      if (this.config.allowOffline) {
        this.offlineReason = errText(exc);
        return null;
      }
      throw exc;
    }
  }

  // ----------------------------------------------------------------- feedback
  private async feedbackSafely(
    taskText: string,
    routing: RoutingResult | null,
    runUsage: Usage,
    latencyMs: number,
    failed: boolean,
    turnsTaken: number,
  ): Promise<{
    quality: number | null;
    outcome: "success" | "partial" | "failure";
    reinforcedEntryIds: string[] | null;
    lessonPromoted: boolean | null;
    /** M7.2/M7.3: the grounded verdict of the step verified under this prompt (null = none). */
    grounded: GroundedOutcome | null;
  }> {
    // M7.2: a real check (deterministic gate) outranks the judge. Read the run's most recent
    // grounded verdict once; the escalation block reuses it (M7.3) so the ledger is read once.
    const grounded = this.config.groundTruth ? groundedOutcomeFor(this.db, this.runId) : null;
    const deterministic = grounded?.verifiedBy === "deterministic" ? grounded : null;
    if (!routing || routing.recommendationId === null || routing.chosenModelId === null) {
      return {
        quality: null,
        outcome: "success",
        reinforcedEntryIds: null,
        lessonPromoted: null,
        grounded,
      };
    }
    let quality: number | null = null;
    let outcome: "success" | "partial" | "failure" = "success";
    let reinforcedEntryIds: string[] | null = null;
    let lessonPromoted: boolean | null = null;
    try {
      const last = this.lastAssistant();
      if (failed) {
        quality = 0.0;
        outcome = "failure";
      } else if (deterministic) {
        // M7.2: the step carried a real check — its verdict IS the outcome (no judge, no
        // fabricated quality). verified/failed/unrunnable → success/failure label only.
        quality = null;
        outcome = deterministic.outcome === "verified" ? "success" : "failure";
      } else if (!this.shouldJudge()) {
        quality = null;
        outcome = "success";
      } else {
        const output = last?.textContent ?? "";
        const graded = await this.judge.grade(taskText, output);
        if (graded === null) {
          // Judge abstained: record realized cost/latency but send NO fabricated quality.
          quality = null;
          outcome = "success";
        } else {
          quality = clamp01(graded);
          outcome = gradeOutcome(quality);
        }
      }
      // Feedback truth (the learning loop is only as good as this call):
      //  - usage is the RUN TOTAL (all turns), not the last assistant message;
      //  - a deterministic gate is the only source that flips verified_in_production, and only
      //    when its tier is GREEN (trustworthy origin: pre-existing/user + red→green + coverage).
      //    Yellow/agent_new stays false — a self-written test must never be claimed as ground
      //    truth (the server promotes verified successes as high-importance, substituting 0.9);
      //  - the judge path (no gate) never claims it, and quality is never fabricated;
      //  - unjudged/deterministic turns are tagged so the server/analytics can discriminate them.
      const judged = quality !== null;
      const verifiedInProduction = deterministic?.confidence === "green";
      const resp = await this.router.feedback({
        recommendationId: routing.recommendationId,
        chosenModelId: routing.chosenModelId,
        outcome,
        quality,
        usage: runUsage,
        latencyMs,
        iterations: turnsTaken || undefined,
        verifiedInProduction,
        judged,
        notes: deterministic
          ? `verified_by=deterministic;tier=${deterministic.confidence ?? "unknown"}`
          : judged
            ? undefined
            : "judged=false",
      });
      // Keep the Mubit-side provenance ids (previously discarded) — the work record
      // cites which memory entries this outcome reinforced.
      reinforcedEntryIds = resp.reinforced_entry_ids ?? null;
      lessonPromoted = resp.lesson_promoted ?? null;
      // An HTTP-200 rejection (accepted=false, e.g. memory_write_failed) is NOT success:
      // keep it visible in diagnostics or a server-side outage silently starves the
      // learning loop (observed live for a full day of traffic).
      const rejection = resp.accepted
        ? null
        : `feedback not accepted: ${(resp.warnings ?? []).join(", ") || "unknown"}`;
      // Close the Mubit learning loop: record this turn's realized outcome as a trace + score,
      // attributed to the recommendation. Fail-open, never fabricated (quality null -> trace
      // only, no score). No-op unless a MubitHarnessMemory is wired in.
      await this.memory.recordOutcome({
        task: taskText,
        recommendationId: routing.recommendationId,
        modelId: routing.chosenModelId,
        outcome,
        quality,
        costUsd: runUsage.cost.total,
        latencyMs,
        turns: turnsTaken,
      });
      this.lastFeedbackError = rejection;
    } catch (exc) {
      // Feedback/write-back must never break a successful run, but don't vanish silently — keep
      // the reason for diagnostics (/reconnect, tests, debugging the learning loop).
      this.lastFeedbackError = errText(exc);
    }
    return { quality, outcome, reinforcedEntryIds, lessonPromoted, grounded };
  }

  // ----------------------------------------------------------------- helpers
  private shouldJudge(): boolean {
    const every = this.config.judgeEvery;
    return every > 0 && this.promptsRun % every === 0;
  }

  /** Rough input-token estimate for THIS turn: live context + system prompt + the new task
   * (chars/4 — the standard heuristic; the server only needs the right order of magnitude
   * to price candidates truthfully). */
  private estimateContextTokens(taskText: string): number {
    let chars = (this.agentState.systemPrompt ?? "").length + taskText.length;
    for (const m of this.agentState.messages) {
      chars += m.textContent.length;
    }
    return Math.max(1, Math.ceil(chars / 4));
  }

  private lastAssistant(): AssistantMessage | null {
    for (let i = this.agentState.messages.length - 1; i >= 0; i--) {
      const m = this.agentState.messages[i]!;
      if (m instanceof AssistantMessage) return m;
    }
    return null;
  }

  private providerOf(modelId: string): string | null {
    if (modelId.includes("/")) return modelId.split("/")[0] ?? null;
    return null;
  }
}

function pinnedResult(model: Model): RoutingResult {
  return {
    recommendationId: null,
    chosenModelId: model.id,
    model,
    estCostUsd: 0,
    decisionBasis: "pinned",
    ranked: [],
    rationale: "",
    warnings: [],
    thresholdUsed: 0,
    confidence: 1,
    fallbackModelId: null,
    baselineCostUsd: null,
    estCostLow: null,
    estCostHigh: null,
    costBandBasis: "",
    recommendedActions: [],
    selectionPolicy: "pinned",
    classifiedTaskType: "",
    classifiedDifficulty: "",
  };
}

function shortLabel(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean;
}
