/**
 * Typed client for the Minima recommender service (/v1/* contract).
 *
 * The loop this SDK serves: recommend → run the model yourself → judge → feedback.
 * Minima never runs the model. Feedback must carry REALIZED usage (what the provider
 * actually billed — never Minima's own est_cost_usd echoed back); that is what lets
 * the cost basis climb estimate → observed → rescaled for your org.
 */

import { MinimaUnavailable, raiseForStatus } from "./errors.ts";
import type {
  CalibrationResponse,
  CapabilitiesResponse,
  Constraints,
  DiagnoseRequest,
  DiagnoseResponse,
  FeedbackRequest,
  FeedbackResponse,
  MemoryHealthResponse,
  ModelsResponse,
  OutcomeLabel,
  PolicyValueResponse,
  RecommendRequest,
  RecommendResponse,
  SavingsResponse,
  StrategiesResponse,
  TaskInput,
  TaskLike,
  WorkflowRequest,
  WorkflowResponse,
} from "./schemas.ts";
import { VERSION } from "./version.ts";

/** Minimal fetch-like transport. Real callers omit this (uses global fetch). */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  json(): Promise<unknown>;
  headers?: { get(name: string): string | null };
}>;

/**
 * Realized per-call usage — the single biggest accuracy lever of the loop.
 * Fields left undefined mean "not measured"; an explicit 0 is a real measurement.
 */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
}

export interface FeedbackOptions {
  usage?: Usage;
  qualityScore?: number;
  /**
   * Provenance of the quality signal: gate = deterministic verification (the only
   * origin that may claim verified-in-production); judge = LLM judge; human =
   * caller-asserted; none = cost/latency telemetry only.
   */
  evidenceSource?: "gate" | "judge" | "human" | "none";
  /** infra = provider/tooling fault (telemetry only, never model quality). */
  errorCause?: "infra" | "quality";
  chosenEffort?: string;
  iterations?: number;
  notes?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface RecommendOptions {
  costQualityTradeoff?: number;
  constraints?: Constraints;
  userId?: string;
  namespace?: string;
  maxCandidates?: number;
  explain?: boolean;
  baselineModelId?: string;
  /** The model holding this session's prompt cache — stickiness via honest pricing. */
  incumbentModelId?: string;
  /** Reference-client convention: rides as a `phase:<value>` tag. */
  phase?: string;
  signal?: AbortSignal;
}

export interface MinimaClientOptions {
  baseUrl: string;
  apiKey?: string;
  /**
   * Backoff schedule for feedback retries (ms). Feedback is safe to retry (the
   * server's reconcile replay guard dedupes) and a lost label is a silent learning
   * loss; recommend never retries — fail fast, fail open in the caller.
   */
  feedbackRetryDelaysMs?: number[];
  /** Inject a fetch transport for hermetic tests. */
  fetch?: FetchLike;
}

function coerceTask(task: TaskLike): TaskInput {
  if (typeof task === "string") return { task };
  return task;
}

function applyPhase(task: TaskInput, phase?: string): TaskInput {
  if (!phase) return task;
  const tag = `phase:${phase}`;
  const tags = task.tags ?? [];
  if (tags.includes(tag)) return task;
  return { ...task, tags: [...tags, tag] };
}

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    "x-minima-client": VERSION,
    "user-agent": `minima-sdk-ts/${VERSION}`,
  };
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

function dropUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MinimaClient {
  private readonly base: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchLike;
  private readonly feedbackRetryDelaysMs: number[];

  constructor(opts: MinimaClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.feedbackRetryDelaysMs = opts.feedbackRetryDelaysMs ?? [500, 2000];
    // Global fetch bound to avoid `Illegal invocation` in some runtimes.
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  }

  private url(path: string, params?: Record<string, unknown>): string {
    const u = new URL(this.base + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const resp = await this.fetchImpl(this.url(path, params), {
      method: "GET",
      headers: headers(this.apiKey),
    });
    const body = await resp.json();
    raiseForStatus(resp.status, body, retryAfterOf(resp));
    return body as T;
  }

  private async post<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const resp = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: headers(this.apiKey),
      body: JSON.stringify(payload),
      signal,
    });
    const body = await resp.json();
    raiseForStatus(resp.status, body, retryAfterOf(resp));
    return body as T;
  }

  // --- Recommend -------------------------------------------------------------

  recommend(task: TaskLike, opts: RecommendOptions = {}): Promise<RecommendResponse> {
    const req: RecommendRequest = {
      task: applyPhase(coerceTask(task), opts.phase),
      cost_quality_tradeoff: opts.costQualityTradeoff ?? 5.0,
      constraints: opts.constraints ?? {},
      ...dropUndefined({
        user_id: opts.userId,
        namespace: opts.namespace,
        max_candidates: opts.maxCandidates,
        explain: opts.explain,
        baseline_model_id: opts.baselineModelId,
        incumbent_model_id: opts.incumbentModelId,
      }),
    };
    return this.post<RecommendResponse>("/v1/recommend", req, opts.signal);
  }

  recommendWorkflow(req: WorkflowRequest): Promise<WorkflowResponse> {
    return this.post<WorkflowResponse>("/v1/recommend/workflow", req);
  }

  // --- Feedback --------------------------------------------------------------

  async feedback(
    recommendationId: string,
    chosenModelId: string,
    outcome: OutcomeLabel | string,
    opts: FeedbackOptions = {},
  ): Promise<FeedbackResponse> {
    const usage = opts.usage ?? {};
    const req: FeedbackRequest = {
      recommendation_id: recommendationId,
      chosen_model_id: chosenModelId,
      outcome: outcome as OutcomeLabel,
      ...dropUndefined({
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        actual_cost_usd: usage.costUsd,
        latency_ms: usage.latencyMs,
        quality_score: opts.qualityScore,
        evidence_source: opts.evidenceSource,
        error_cause: opts.errorCause,
        chosen_effort: opts.chosenEffort,
        iterations: opts.iterations,
        notes: opts.notes,
        idempotency_key: opts.idempotencyKey,
      }),
    };
    return this.feedbackRaw(req, opts.signal);
  }

  /** The raw wire shape, retried like feedback() — for callers that build requests. */
  async feedbackRaw(req: FeedbackRequest, signal?: AbortSignal): Promise<FeedbackResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.feedbackRetryDelaysMs.length; attempt++) {
      try {
        return await this.post<FeedbackResponse>("/v1/feedback", req, signal);
      } catch (exc) {
        lastError = exc;
        const transport = !(exc instanceof Error && exc.name.startsWith("Minima"));
        const retryable = exc instanceof MinimaUnavailable || transport;
        const delay = this.feedbackRetryDelaysMs[attempt];
        if (!retryable || delay === undefined || signal?.aborted) throw exc;
        await sleep(delay);
      }
    }
    throw lastError;
  }

  // --- Reporting -------------------------------------------------------------

  savings(
    opts: { namespace?: string; days?: number; group_by?: string } = {},
  ): Promise<SavingsResponse> {
    return this.get<SavingsResponse>("/v1/savings", dropUndefined(opts));
  }

  calibration(opts: { namespace?: string; days?: number } = {}): Promise<CalibrationResponse> {
    return this.get<CalibrationResponse>("/v1/calibration", dropUndefined(opts));
  }

  /** Regret-vs-oracle: doubly-robust policy values over reconciled decisions. */
  policyValue(opts: { namespace?: string; days?: number } = {}): Promise<PolicyValueResponse> {
    return this.get<PolicyValueResponse>("/v1/policy-value", dropUndefined(opts));
  }

  strategies(
    opts: { namespace?: string; max_strategies?: number; lesson_types?: string[] } = {},
  ): Promise<StrategiesResponse> {
    return this.get<StrategiesResponse>("/v1/strategies", dropUndefined(opts));
  }

  /** Failure lessons matching an error — "here's how this failed before". */
  diagnose(req: DiagnoseRequest): Promise<DiagnoseResponse> {
    return this.post<DiagnoseResponse>("/v1/diagnose", req);
  }

  /** Per-namespace memory hygiene: staleness, contradictions, promotion candidates. */
  memoryHealth(
    opts: { namespace?: string; stale_threshold_days?: number } = {},
  ): Promise<MemoryHealthResponse> {
    return this.get<MemoryHealthResponse>("/v1/memory/health", dropUndefined(opts));
  }

  models(
    opts: {
      provider?: string;
      task_type?: string;
      max_cost?: number;
      include_stale?: boolean;
    } = {},
  ): Promise<ModelsResponse> {
    return this.get<ModelsResponse>("/v1/models", dropUndefined(opts));
  }

  health(): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>("/v1/health");
  }

  capabilities(): Promise<CapabilitiesResponse> {
    return this.get<CapabilitiesResponse>("/v1/capabilities");
  }
}

function retryAfterOf(resp: { headers?: { get(name: string): string | null } }): number | null {
  const raw = resp.headers?.get("retry-after");
  if (raw == null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
