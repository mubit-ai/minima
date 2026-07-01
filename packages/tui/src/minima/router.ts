/**
 * MinimaRouter — the thin seam between the harness and a running Minima service.
 *
 * Port of minima_harness/minima/router.py. Owns the two halves of the Minima loop on
 * the harness side: recommend (ask Minima which model, map it to a callable harness
 * model) and feedback (report realized tokens / cost / latency / quality so Minima's
 * memory sharpens). Realized cost comes from the provider's actual usage, NOT Minima's
 * prior estimate — that is what lets the cost basis climb estimate -> observed -> rescaled.
 */

import type { Model, Usage } from "../ai/types.ts";
import { MinimaClient } from "./client.ts";
import type { HarnessConfig } from "./config.ts";
import { MinimaError } from "./errors.ts";
import { ModelMapping } from "./mapping.ts";
import type { RankedModel, TaskInput, TaskType } from "./schemas.ts";

/** A harness-native view of one ranked candidate (no minima schema leak). */
export interface Ranking {
  modelId: string;
  provider: string;
  predictedSuccess: number;
  estCostUsd: number;
  rationale: string;
  decisionBasis: string;
  estLatencyMs: number | null;
  latencyBasis: string;
  estCostLow: number | null;
  estCostHigh: number | null;
  costBandBasis: string;
  successIntervalWidth: number;
  evidenceCount: number;
}

/** The outcome of a routing decision for one prompt. */
export interface RoutingResult {
  recommendationId: string | null;
  chosenModelId: string | null;
  model: Model;
  estCostUsd: number;
  decisionBasis: string;
  ranked: Ranking[];
  rationale: string;
  warnings: string[];
  thresholdUsed: number;
  confidence: number;
  fallbackModelId: string | null;
  baselineCostUsd: number | null;
  estCostLow: number | null;
  estCostHigh: number | null;
  costBandBasis: string;
}

function needsAuth(url: string): boolean {
  const host = (tryHost(url) || "").toLowerCase();
  return Boolean(host) && !["localhost", "127.0.0.1", "::1"].includes(host);
}

function tryHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function baselineCost(ranked: Ranking[], baselineId: string | null): number | null {
  if (!baselineId) return null;
  return ranked.find((r) => r.modelId === baselineId)?.estCostUsd ?? null;
}

function toRanking(r: RankedModel): Ranking {
  return {
    modelId: r.model_id,
    provider: r.provider,
    predictedSuccess: r.predicted_success,
    estCostUsd: r.est_cost_usd,
    rationale: r.rationale ?? "",
    decisionBasis: String(r.decision_basis ?? ""),
    estLatencyMs: r.est_latency_ms ?? null,
    latencyBasis: r.latency_basis ?? "",
    estCostLow: r.est_cost_low ?? null,
    estCostHigh: r.est_cost_high ?? null,
    costBandBasis: r.cost_band_basis ?? "",
    successIntervalWidth: r.success_interval_width ?? 0,
    evidenceCount: r.evidence?.length ?? 0,
  };
}

export interface MinimaRouterOptions {
  client: MinimaClient;
  config: HarnessConfig;
  mapping?: ModelMapping;
}

export class MinimaRouter {
  readonly config: HarnessConfig;
  readonly mapping: ModelMapping;
  private readonly client: MinimaClient;

  constructor(opts: MinimaRouterOptions) {
    this.client = opts.client;
    this.config = opts.config;
    this.mapping = opts.mapping ?? new ModelMapping();
  }

  static forConfig(config: HarnessConfig, mapping?: ModelMapping): MinimaRouter {
    const client = new MinimaClient({
      baseUrl: config.minimaUrl,
      apiKey: config.minimaApiKey ?? undefined,
      timeoutMs: config.timeout * 1000,
    });
    return new MinimaRouter({ client, config, mapping });
  }

  async recommend(opts: {
    task: string;
    taskType?: string;
    slider?: number;
    tags?: string[];
    difficulty?: string;
    expectedInputTokens?: number;
    candidates?: string[];
  }): Promise<RoutingResult> {
    if (!(this.config.minimaUrl || "").trim()) {
      throw new Error("routing disabled (offline mode)");
    }
    if (!(this.config.minimaApiKey || "").trim() && needsAuth(this.config.minimaUrl)) {
      throw new MinimaError("no Mubit API key configured", 401, {});
    }

    const effective = opts.candidates ?? [...this.config.candidates];
    const constraints = effective.length ? { candidate_models: effective } : undefined;

    // Build a TaskInput only when enriching signals are present; else pass the bare string.
    let taskInput: string | TaskInput;
    if (opts.taskType || opts.tags || opts.difficulty || opts.expectedInputTokens !== undefined) {
      const enriched: TaskInput = { task: opts.task };
      if (opts.taskType) enriched.task_type = opts.taskType as TaskType;
      if (opts.tags) enriched.tags = opts.tags;
      if (opts.difficulty) enriched.difficulty = opts.difficulty as TaskInput["difficulty"];
      if (opts.expectedInputTokens !== undefined)
        enriched.expected_input_tokens = opts.expectedInputTokens;
      taskInput = enriched;
    } else {
      taskInput = opts.task;
    }

    const rec = await this.client.recommend(taskInput, {
      cost_quality_tradeoff: opts.slider ?? this.config.costQualityTradeoff,
      constraints,
      namespace: this.config.namespace ?? undefined,
      baseline_model_id: this.config.baselineModelId ?? undefined,
    });

    const ranked = rec.recommended_model;
    const model = this.mapping.toModel(ranked, this.mapping.defaultModel());
    const rankingList = (rec.ranked ?? []).map(toRanking);
    return {
      recommendationId: rec.recommendation_id,
      chosenModelId: ranked.model_id,
      model,
      estCostUsd: ranked.est_cost_usd,
      decisionBasis: String(rec.decision_basis),
      ranked: rankingList,
      rationale: ranked.rationale ?? "",
      warnings: [...(rec.warnings ?? [])],
      thresholdUsed: rec.threshold_used,
      confidence: rec.confidence,
      fallbackModelId: rec.fallback_model?.model_id ?? null,
      baselineCostUsd: baselineCost(rankingList, this.config.baselineModelId),
      estCostLow: ranked.est_cost_low ?? null,
      estCostHigh: ranked.est_cost_high ?? null,
      costBandBasis: ranked.cost_band_basis ?? "",
    };
  }

  async feedback(opts: {
    recommendationId: string;
    chosenModelId: string;
    outcome: string;
    quality: number | null;
    usage: Usage;
    latencyMs: number;
    iterations?: number;
  }): Promise<void> {
    await this.client.feedback({
      recommendation_id: opts.recommendationId,
      chosen_model_id: opts.chosenModelId,
      outcome: opts.outcome as "success" | "partial" | "failure",
      quality_score: opts.quality ?? undefined,
      input_tokens: opts.usage.input || undefined,
      output_tokens: opts.usage.output || undefined,
      actual_cost_usd: Math.round(opts.usage.cost.total * 1e8) / 1e8,
      latency_ms: opts.latencyMs,
      iterations: opts.iterations,
      verified_in_production: true,
    });
  }
}
