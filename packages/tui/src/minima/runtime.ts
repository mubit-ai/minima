/**
 * MinimaAgent — an Agent that routes each prompt through Minima and feeds the realized
 * outcome back.
 *
 * Port of minima_harness/minima/runtime.py (focused core). Per promptRouted(): (1) ask
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
import { errText } from "../errtext.ts";
import { type HarnessConfig, refreshRoutingEnv } from "./config.ts";
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
}

export function gradeOutcome(quality: number): "success" | "partial" | "failure" {
  if (quality >= 0.8) return "success";
  if (quality >= 0.4) return "partial";
  return "failure";
}

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

    // Recall-before-route: inject task-relevant prior Mubit context into THIS turn's system
    // prompt (restored in `finally` — no leak across turns). No-op unless memory is wired.
    const origSystem = this.agentState.systemPrompt;
    const recalled = await this.memory.recall(content);
    if (recalled.length > 0) {
      const block = formatRecallBlock(recalled);
      this.agentState.systemPrompt = origSystem ? `${origSystem}\n\n${block}` : block;
    }
    try {
      const routing = await this.route(content, {
        taskType: effectiveTaskType ?? null,
        slider: opts.slider ?? null,
        tags: opts.tags,
        difficulty: opts.difficulty,
        maxCostPerCall: opts.maxCostPerCall,
        minQuality: opts.minQuality,
        excludedModels: opts.excludedModels,
      });
      // Everything appended from here belongs to THIS prompt's run (for run-total usage).
      const runStartIdx = this.agentState.messages.length;
      const start = Date.now();
      let runError: unknown = null;
      try {
        await super.prompt(content);
      } catch (exc) {
        runError = exc;
      }
      const latencyMs = Date.now() - start;
      const turnsTaken = this.agentState.turnsTaken;
      const last = this.lastAssistant();
      const failed = runError !== null || (last !== null && last.stop_reason === "error");
      // Run-TOTAL usage: a multi-turn run has one assistant message per turn — summing is
      // what makes the reported cost truthful (last-turn-only under-reports and corrupts
      // the server's observed-cost basis).
      const runUsage = this.usageSince(runStartIdx);

      const { quality, outcome } = await this.feedbackSafely(
        content,
        routing,
        runUsage,
        latencyMs,
        failed,
        turnsTaken,
      );

      if (this.meter) {
        this.meter.record({
          label: shortLabel(content),
          routing,
          actualCostUsd: runUsage.cost.total,
          quality: failed ? 0 : quality,
          outcome: failed ? "failure" : outcome,
          turns: turnsTaken,
        });
      }

      if (runError !== null) throw runError;
      return routing;
    } finally {
      // Never let this turn's recalled context leak into the next turn's base prompt.
      this.agentState.systemPrompt = origSystem;
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
      });
      this.offlineReason = null;
      if (this.beforeRouteHook) {
        const overridden = await this.beforeRouteHook(routing, taskText);
        if (overridden) return overridden;
      }
      this.agentState.model = routing.model;
      return routing;
    } catch (exc) {
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
  ): Promise<{ quality: number | null; outcome: "success" | "partial" | "failure" }> {
    if (!routing || routing.recommendationId === null || routing.chosenModelId === null) {
      return { quality: null, outcome: "success" };
    }
    let quality: number | null = null;
    let outcome: "success" | "partial" | "failure" = "success";
    try {
      const last = this.lastAssistant();
      if (failed) {
        quality = 0.0;
        outcome = "failure";
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
      //  - verified_in_production is NEVER claimed — nothing here runs the project's tests
      //    yet, and a fabricated flag makes the server treat unjudged successes as
      //    high-importance ground truth (it substitutes quality 0.9 for null);
      //  - unjudged turns are tagged so the server/analytics can discriminate them.
      const judged = quality !== null;
      await this.router.feedback({
        recommendationId: routing.recommendationId,
        chosenModelId: routing.chosenModelId,
        outcome,
        quality,
        usage: runUsage,
        latencyMs,
        iterations: turnsTaken || undefined,
        verifiedInProduction: false,
        notes: judged ? undefined : "judged=false",
      });
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
      this.lastFeedbackError = null;
    } catch (exc) {
      // Feedback/write-back must never break a successful run, but don't vanish silently — keep
      // the reason for diagnostics (/reconnect, tests, debugging the learning loop).
      this.lastFeedbackError = errText(exc);
    }
    return { quality, outcome };
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
