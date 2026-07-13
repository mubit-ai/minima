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
import type { AskUserRef } from "../tools/question.ts";
import {
  type AntiSpiralGate,
  DoomLoopRing,
  makeAntiSpiral,
  ringCapacityForRepeats,
  toolCallFailed,
} from "./anti_spiral.ts";
import { type BudgetLedger, reserveAmount } from "./budget.ts";
import { type HarnessConfig, refreshRoutingEnv } from "./config.ts";
import {
  type FailureDecision,
  type Intervention,
  isTransientError,
  makeFailureMatcher,
  replanPreamble,
  writeRecoveryGate,
} from "./failure_kind.ts";
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
import { makeStopGate } from "./stop_gate.ts";

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
  /** Late-bound ask channel (A2 stop-gate). The TUI populates `.current` on mount; null in
   * headless. Read at run-stop so the stop-gate can raise the "keep going / accept / steer"
   * overlay once its strikes are spent. */
  askUser: AskUserRef | null = null;
  /** Budget following (optional): reserve-after-route / reconcile-after-run, graduated
   * warnings, and (enforce mode) refusal once exhausted. */
  budget: BudgetLedger | null = null;
  /** Recovery-ladder retries per prompt (total attempts = 1 + rungs; 0 disables). */
  recoveryRungs = 2;
  /** How many ladder escalations (exclude + re-route to a stronger model) happened this session. */
  ladderEscalations = 0;
  /** A4: how many transient-error backoffs (retry the SAME model) happened this session. */
  ladderBackoffs = 0;
  /** A4: how many structural replans (plan-revision steer, same model) happened this session. */
  ladderReplans = 0;
  /** Effort routing Phase A (staged, default OFF): map the server's classified difficulty
   * to a per-prompt thinking level — route (model, effort), not just model. */
  autoEffort = false;
  /** Aborts the routing phase (the recommend HTTP call) — the base Agent's own
   * controller only covers the run phase. Set for the lifetime of promptRouted. */
  private routeController: AbortController | null = null;
  /** The routed rung currently executing (set around super.prompt) — gate rows minted during
   * tool dispatch carry it as their identity (GtAgentRef.currentRecId). Null when idle. */
  currentRecId: string | null = null;
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
      // A4: one failure-kind matcher per prompt (its gate-fail streak spans rungs), consulted after
      // each rung to pick backoff / escalate / replan. Null (inert) unless groundTruth +
      // failureMatcher — the default path then keeps the classic always-escalate ladder.
      const failureMatcher = this.failureMatcherActive() ? makeFailureMatcher() : null;
      // A pending `replan` steer to prepend to the NEXT rung's prompt (null = none). Steering drains
      // post-turn, so prepending to the prompt is the only way a replan lands on the model turn-1.
      let replanPrefix: string | null = null;

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
        // Per-turn stop seam (single slot): compose the budget cutoff and the ground-truth
        // stop-gate into one function so neither clobbers the other. Budget wins first (finish the
        // CURRENT turn on cross, stop gracefully — no partial-tool corruption); the stop-gate then
        // decides whether an END-of-run with unfinished/failing steps is allowed (A2). Rebuilt per
        // rung so the stop-gate's strike counter resets on each recovery attempt.
        let disposeSpiralFeed: (() => void) | null = null;
        let budgetStop: ((a: AssistantMessage) => boolean) | null = null;
        if (this.budget) {
          let runSpend = 0;
          const limitLeft = this.budget.status().remainingUsd;
          const enforce = this.budget.mode === "enforce";
          budgetStop = (assistant) => {
            runSpend += assistant.usage.cost.total;
            return enforce && runSpend >= limitLeft;
          };
        }
        const gtStop =
          this.config.groundTruth && this.config.stopStrikes > 0
            ? makeStopGate({
                db: this.db,
                sessionId: this.runId,
                agentId: this.agentId,
                maxStrikes: this.config.stopStrikes,
                askUser: this.askUser,
              })
            : null;
        // Anti-spiral (A3): a doom-loop ring buffer fed by an afterToolCall hook, plus a soft turn
        // cap, both resolved here. Runs BEFORE the A2 stop-gate so a "stop the spiral" verdict wins
        // over A2's "the plan isn't done, keep going" — looping forever is worse than stopping with
        // unfinished work. Fresh ring + counters per rung (like the other stop closures).
        let antiSpiral: AntiSpiralGate | null = null;
        if (this.config.groundTruth && (this.config.spiralRepeats > 0 || this.config.stepCap > 0)) {
          const ring = new DoomLoopRing(ringCapacityForRepeats(this.config.spiralRepeats));
          disposeSpiralFeed = this.addAfterToolCall(async (ctx) => {
            ring.push(
              ctx.toolCall.name,
              ctx.toolCall.arguments,
              toolCallFailed(ctx.result, ctx.isError),
            );
            return null;
          });
          antiSpiral = makeAntiSpiral({
            ring,
            repeats: this.config.spiralRepeats,
            stepCap: this.config.stepCap,
            db: this.db,
            sessionId: this.runId,
            agentId: this.agentId,
          });
        }
        // Install ONLY when we have something to install. If nothing applies, leave the slot
        // untouched — a sub-agent's per-node budget cutoff arrives as a CONSTRUCTOR-provided
        // shouldStopAfterTurn (spawn.ts), and clobbering it here would silently disable it.
        const installedStop = Boolean(budgetStop || gtStop || antiSpiral);
        if (installedStop) {
          this.setShouldStopAfterTurn(async (assistant, results, state, messages) => {
            if (budgetStop?.(assistant)) return true;
            if (antiSpiral) {
              const v = await antiSpiral(assistant, results, state);
              if (v === "stop") return true;
              if (v === "handled") return false; // injected a steer; skip A2 this turn
            }
            return gtStop ? gtStop(assistant, results, state, messages) : false;
          });
        }
        // Everything appended from here belongs to THIS rung (for rung-total usage). The
        // rung's rec_id is minted BEFORE the run so every gate row written during tool
        // dispatch (which only happens inside super.prompt) carries this turn's identity.
        const rungRecId = routing?.recommendationId ?? `local-${newId()}`;
        const runStartIdx = this.agentState.messages.length;
        const start = Date.now();
        let runError: unknown = null;
        this.currentRecId = rungRecId;
        // A4 replan: if the prior rung classified a structural failure, prepend its plan-revision
        // steer to THIS rung's prompt (consumed once). The task itself is unchanged.
        const runContent = replanPrefix ? `${replanPrefix}\n\n${content}` : content;
        replanPrefix = null;
        try {
          await super.prompt(runContent);
        } catch (exc) {
          runError = exc;
        } finally {
          this.currentRecId = null;
          // Clear ONLY a seam we installed above; never null out a constructor-provided hook
          // (sub-agent budget cutoff) that we deliberately left in place.
          if (installedStop) this.setShouldStopAfterTurn(null);
          disposeSpiralFeed?.(); // unregister the ring-feed afterToolCall hook for this rung
        }
        const latencyMs = Date.now() - start;
        const turnsTaken = this.agentState.turnsTaken;
        const last = this.lastAssistant();
        const failed = runError !== null || (last !== null && last.stop_reason === "error");
        // A4: a hard failure's error text. Provider failures don't throw — they surface as an
        // assistant with stop_reason==='error' + a free-text error_message; a thrown runError is the
        // rarer path. Feeds the transient/infra classifier.
        const errorText = !failed
          ? null
          : runError !== null
            ? errText(runError)
            : (last?.error_message ?? null);
        // A4: the grounded (deterministic) verdict THIS rung minted — read up front so a real
        // check-fail can never be masked by a coincidental transient error. M7.2/M7.3 identity join:
        // only gates under this rung's rec_id count. Passed into feedbackSafely (single read).
        const grounded = this.config.groundTruth ? groundedOutcomeFor(this.db, rungRecId) : null;
        const gateFailed = grounded !== null && grounded.outcome === "failed";
        // A transient/infra blip (429 / timeout / 5xx / network) is not the model's fault: suppress
        // the failure feedback so it never teaches Minima this model is low-quality. But a real
        // deterministic check-fail OUTRANKS an incidental blip — never suppress on `gateFailed`.
        const transient =
          failureMatcher !== null && failed && !gateFailed && isTransientError(errorText);
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
        const { quality, outcome, reinforcedEntryIds, lessonPromoted } = await this.feedbackSafely(
          content,
          routing,
          runUsage,
          latencyMs,
          failed,
          turnsTaken,
          transient,
          grounded,
        );

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
          recId: rungRecId,
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

        // Recover? Only with a rung left, a routed (non-pinned) decision to learn from, and a REAL
        // trigger: provider failure, a non-null judge grade below τ, or a grounded check that FAILED
        // this rung. M7.3: a red gate outranks the judge as a trigger — but only `failed` (the check
        // ran and said no); `unrunnable` is an environment error and must not roll back work, exclude
        // an innocent model, or burn paid rungs. A4 then classifies WHICH recovery move to make.
        const judgeFailed =
          !failed && quality !== null && routing !== null && quality < routing.thresholdUsed;
        // `gateFailed` was computed before feedback (so `transient` couldn't mask a real check-fail).
        const failedModel =
          routing !== null && routing.recommendationId !== null ? routing.chosenModelId : null;
        const canRecover =
          attempt < this.recoveryRungs &&
          failedModel !== null &&
          (failed || judgeFailed || gateFailed);
        if (!canRecover) {
          if (runError !== null) throw runError;
          return routing;
        }
        // A4: pick the recovery move by failure kind. With the matcher off (default path) the
        // intervention stays `escalate`, so behavior is identical to the classic ladder.
        let intervention: Intervention = "escalate";
        let decision: FailureDecision | null = null;
        if (failureMatcher) {
          decision = failureMatcher({ hardError: failed, errorText, judgeFailed, gateFailed });
          if (decision) intervention = decision.intervention;
        }
        // Roll back this rung's messages so the retry starts from the same context the failed rung
        // saw (no confusing half-answers in the next rung's prompt).
        this.agentState.messages.length = preRunIdx;
        if (intervention === "escalate") {
          // Exclude the failed model → the next recommend re-routes to a stronger/different rung.
          excluded.push(failedModel);
          this.ladderEscalations += 1;
        } else if (intervention === "replan") {
          // Keep the model; prepend a plan-revision steer to the next rung. Audit-only gate.
          replanPrefix = replanPreamble(decision?.reason ?? "verification keeps failing");
          if (decision) writeRecoveryGate(this.recoveryGateDeps(), decision);
          this.ladderReplans += 1;
        } else {
          // backoff: keep the model (a transient/infra blip), optionally pace the retry. Audit-only.
          if (decision) writeRecoveryGate(this.recoveryGateDeps(), decision);
          this.ladderBackoffs += 1;
          if (this.config.backoffMs > 0) await sleep(this.config.backoffMs);
        }
        lastError = runError;
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
      /** The rung's identity, minted at rung start (routing rec_id, else a local-* id). */
      recId: string;
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
      const recId = o.recId;
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
      // gates THIS rung minted onto gt_* — a real check outranks the judge. Identity join:
      // gates from other rungs can never stamp this row. Fail-open inside the helper.
      if (this.config.groundTruth) {
        stampGroundedOutcome(this.db, recId);
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
    /** A4: this rung failed on a transient/infra error — record locally but send NO feedback (a
     * 429/timeout is not evidence the model is low-quality). */
    transient = false,
    /** M7.2/M7.3: the grounded (deterministic) verdict THIS rung minted, read once by the caller
     * (A4 reads it before feedback so a transient error can't mask a real check-fail). */
    grounded: GroundedOutcome | null = null,
  ): Promise<{
    quality: number | null;
    outcome: "success" | "partial" | "failure";
    reinforcedEntryIds: string[] | null;
    lessonPromoted: boolean | null;
  }> {
    // M7.2: a real check (deterministic gate) outranks the judge. Identity join: only gates
    // THIS rung minted (rec_id) count — stale verdicts from earlier prompts are invisible.
    // `unrunnable` is an environmental error (spawn failure, timeout), not evidence about the
    // model: it never outranks the judge and never sends failure feedback — the judge path
    // proceeds and the red stays visible in the UI only.
    const deterministic =
      grounded?.verifiedBy === "deterministic" && grounded.outcome !== "unrunnable"
        ? grounded
        : null;
    if (!routing || routing.recommendationId === null || routing.chosenModelId === null) {
      return {
        quality: null,
        outcome: "success",
        reinforcedEntryIds: null,
        lessonPromoted: null,
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
      // A4: a transient/infra failure (429/timeout/5xx/network) is not the model's fault — keep the
      // local failure label for honesty but send NO feedback, so a blip never penalizes the model
      // in Minima's learning loop. The backoff retry re-runs the SAME model.
      if (transient) {
        return { quality, outcome, reinforcedEntryIds, lessonPromoted };
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
    return { quality, outcome, reinforcedEntryIds, lessonPromoted };
  }

  // ----------------------------------------------------------------- helpers
  private shouldJudge(): boolean {
    const every = this.config.judgeEvery;
    return every > 0 && this.promptsRun % every === 0;
  }

  /** A4: is the failure-kind matcher live? Gated by groundTruth + the failureMatcher flag, so the
   * default path keeps the classic escalate-only ladder. */
  private failureMatcherActive(): boolean {
    return this.config.groundTruth && this.config.failureMatcher;
  }

  /** A4: provenance for a recovery (backoff/replan) audit gate. */
  private recoveryGateDeps(): {
    db: MinimaDb | null;
    sessionId: string | null;
    agentId: string | null;
  } {
    return { db: this.db, sessionId: this.runId, agentId: this.agentId };
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

/** A4: bounded pause before a transient-error backoff retry (config.backoffMs; 0 → never called). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
