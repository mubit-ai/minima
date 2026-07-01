/**
 * Typed async client for the Minima recommender service.
 *
 * A TypeScript port of client_sdk/minima_client/client.py:AsyncMinimaClient.
 * Uses the global fetch (Bun/Node 18+); an injectable transport is accepted for
 * hermetic tests (no network).
 */

import { raiseForStatus } from "./errors.ts";
import type {
  CalibrationResponse,
  Constraints,
  FeedbackRequest,
  FeedbackResponse,
  ModelsResponse,
  OutcomeLabel,
  RecommendRequest,
  RecommendResponse,
  SavingsResponse,
  StrategiesResponse,
  TaskInput,
  TaskLike,
  WorkflowRequest,
  WorkflowResponse,
} from "./schemas.ts";

/** Minimal fetch-like transport. Real callers omit this (uses global fetch). */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

function coerceTask(task: TaskLike): TaskInput {
  if (typeof task === "string") return { task };
  return task;
}

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
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

export interface MinimaClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Inject a fetch transport for hermetic tests. */
  fetch?: FetchLike;
}

export class MinimaClient {
  private readonly base: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: MinimaClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
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
    raiseForStatus(resp.status, body);
    return body as T;
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const resp = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: headers(this.apiKey),
      body: JSON.stringify(payload),
    });
    const body = await resp.json();
    raiseForStatus(resp.status, body);
    return body as T;
  }

  // --- Recommend -------------------------------------------------------------

  recommend(
    task: TaskLike,
    opts: {
      cost_quality_tradeoff?: number;
      constraints?: Constraints;
      user_id?: string;
      namespace?: string;
      allow_llm_escalation?: boolean;
      explain?: boolean;
      baseline_model_id?: string;
    } = {},
  ): Promise<RecommendResponse> {
    const req: RecommendRequest = {
      task: coerceTask(task),
      cost_quality_tradeoff: opts.cost_quality_tradeoff ?? 5.0,
      constraints: opts.constraints ?? {},
      ...dropUndefined({
        user_id: opts.user_id,
        namespace: opts.namespace,
        allow_llm_escalation: opts.allow_llm_escalation,
        explain: opts.explain,
        baseline_model_id: opts.baseline_model_id,
      }),
    };
    return this.post<RecommendResponse>("/v1/recommend", req);
  }

  recommendWorkflow(req: WorkflowRequest): Promise<WorkflowResponse> {
    return this.post<WorkflowResponse>("/v1/recommend/workflow", req);
  }

  // --- Feedback --------------------------------------------------------------

  feedback(req: FeedbackRequest): Promise<FeedbackResponse> {
    return this.post<FeedbackResponse>("/v1/feedback", req);
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

  strategies(
    opts: { namespace?: string; max_strategies?: number; lesson_types?: string[] } = {},
  ): Promise<StrategiesResponse> {
    return this.get<StrategiesResponse>("/v1/strategies", dropUndefined(opts));
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
}

/** Convenience: validate an outcome string against the wire enum. */
export function asOutcome(o: OutcomeLabel | string): OutcomeLabel {
  if ((["success", "partial", "failure"] as string[]).includes(o)) {
    return o as OutcomeLabel;
  }
  throw new TypeError(`invalid outcome: ${o}`);
}
