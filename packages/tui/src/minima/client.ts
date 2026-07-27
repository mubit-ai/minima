/**
 * Typed async client for the Minima recommender service.
 *
 * A TypeScript port of client_sdk/minima_client/client.py:AsyncMinimaClient.
 * Uses the global fetch (Bun/Node 18+); an injectable transport is accepted for
 * hermetic tests (no network).
 */

import { VERSION } from "../version.ts";
import { MinimaRateLimited, MinimaUnavailable, raiseForStatus } from "./errors.ts";
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
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  json(): Promise<unknown>;
  /** Optional so existing test fakes stay valid; real Responses always have it. */
  headers?: { get(name: string): string | null };
}>;

function coerceTask(task: TaskLike): TaskInput {
  if (typeof task === "string") return { task };
  return task;
}

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    // Server-side compat gating: old servers ignore it; new servers can version-gate
    // response shapes (e.g. effort-arm model ids) on it.
    "x-minima-client": VERSION,
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

export interface MinimaClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  /**
   * Backoff schedule for feedback retries (ms). Feedback is safe to retry (the server's
   * reconcile replay guard dedupes) and a lost label is a silent, permanent learning loss —
   * runtime.ts swallows the error, so nothing ever sends it again. recommend never retries:
   * fail fast, fail open in the caller.
   */
  feedbackRetryDelaysMs?: number[];
  /** Inject a fetch transport for hermetic tests. */
  fetch?: FetchLike;
}

export class MinimaClient {
  private readonly base: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number | null;
  private readonly feedbackRetryDelaysMs: number[];

  constructor(opts: MinimaClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : null;
    this.feedbackRetryDelaysMs = opts.feedbackRetryDelaysMs ?? [500, 2000];
    // Global fetch bound to avoid `Illegal invocation` in some runtimes.
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  }

  /** Per-request deadline: `timeoutMs` was accepted but never enforced, so a
   * black-holed request hung forever. Composes with a caller signal when given. */
  private withTimeout(signal?: AbortSignal): AbortSignal | undefined {
    if (this.timeoutMs === null) return signal;
    const t = AbortSignal.timeout(this.timeoutMs);
    return signal ? AbortSignal.any([signal, t]) : t;
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
      signal: this.withTimeout(undefined),
    });
    const body = await readBody(resp);
    raiseForStatus(resp.status, body, retryAfterOf(resp));
    return body as T;
  }

  private async post<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const resp = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: headers(this.apiKey),
      body: JSON.stringify(payload),
      signal: this.withTimeout(signal),
    });
    const body = await readBody(resp);
    raiseForStatus(resp.status, body, retryAfterOf(resp));
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
      max_candidates?: number;
      allow_llm_escalation?: boolean;
      explain?: boolean;
      baseline_model_id?: string;
      incumbent_model_id?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<RecommendResponse> {
    const req: RecommendRequest = {
      task: coerceTask(task),
      cost_quality_tradeoff: opts.cost_quality_tradeoff ?? 5.0,
      constraints: opts.constraints ?? {},
      ...dropUndefined({
        user_id: opts.user_id,
        namespace: opts.namespace,
        max_candidates: opts.max_candidates,
        allow_llm_escalation: opts.allow_llm_escalation,
        explain: opts.explain,
        baseline_model_id: opts.baseline_model_id,
        incumbent_model_id: opts.incumbent_model_id,
      }),
    };
    return this.post<RecommendResponse>("/v1/recommend", req, opts.signal);
  }

  recommendWorkflow(req: WorkflowRequest): Promise<WorkflowResponse> {
    return this.post<WorkflowResponse>("/v1/recommend/workflow", req);
  }

  // --- Feedback --------------------------------------------------------------

  /**
   * Feedback, retried on transient faults. A dropped label is a PERMANENT learning loss:
   * runtime.ts's feedbackSafely logs-and-swallows, so nothing ever re-sends it, and a
   * gate-verified outcome — the harness's only honest label source — is gone. Safe to
   * retry: the server's reconcile replay guard dedupes on recommendation_id.
   *
   * Diverges from packages/sdk deliberately: that client retries ANY transport fault, but
   * here feedbackSafely is awaited in the turn's critical path (runtime.ts:700), so
   * retrying a 30s timeout would stall the user up to 90s at end of turn. Retry only faults
   * that come back FAST — the server answered 429/502/503/504, or the connection was
   * refused/reset. An abort or a deadline is never retried.
   */
  async feedback(req: FeedbackRequest): Promise<FeedbackResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.post<FeedbackResponse>("/v1/feedback", req);
      } catch (exc) {
        const backoff = this.feedbackRetryDelaysMs[attempt];
        if (backoff === undefined || !isFastRetryable(exc)) throw exc;
        await sleep(retryDelayMs(exc, backoff));
      }
    }
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

  /** Failure lessons matching an error — the recovery ladder's "how this failed before" brief. */
  diagnose(req: DiagnoseRequest): Promise<DiagnoseResponse> {
    return this.post<DiagnoseResponse>("/v1/diagnose", req);
  }

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

/**
 * Parse the JSON body, tolerating a non-JSON one (proxy HTML on a 502/503/504, empty
 * body). Returning null lets raiseForStatus throw the typed MinimaError carrying the real
 * status instead of an opaque SyntaxError — otherwise the parse throws FIRST, the status
 * is lost, and the routing banner reads "routing offline: Unexpected token '<'" while
 * lastFeedbackError surfaces the same noise as "ℹ learning loop: …".
 * Ported from packages/sdk/src/client.ts (the SDK fixed this in dce63eb; the TUI, which is
 * the shipping product, never picked it up).
 */
async function readBody(resp: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

function retryAfterOf(resp: { headers?: { get(name: string): string | null } }): number | null {
  const raw = resp.headers?.get("retry-after");
  if (raw == null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Upper bound on an honored `retry-after` so a bad header can't stall the turn. */
const RETRY_AFTER_CAP_MS = 10_000;

/**
 * Delay before the next feedback retry: a 429's `retry-after` (capped) wins over the
 * backoff schedule; every other retryable fault uses `backoff`.
 */
export function retryDelayMs(exc: unknown, backoff: number): number {
  if (exc instanceof MinimaRateLimited && exc.retryAfter != null) {
    return Math.min(exc.retryAfter * 1000, RETRY_AFTER_CAP_MS);
  }
  return backoff;
}

/**
 * Retryable AND fast to fail: a 429/502/503/504 the server actually answered, or a
 * connection-level fault. Deliberately excludes AbortError/TimeoutError — those already
 * cost a full deadline, and this runs while the user waits for the turn to end.
 */
export function isFastRetryable(exc: unknown): boolean {
  if (exc instanceof MinimaRateLimited || exc instanceof MinimaUnavailable) return true;
  if (exc instanceof Error) {
    if (exc.name === "AbortError" || exc.name === "TimeoutError") return false;
    // Any other MinimaError is a real answer (4xx) — retrying re-sends a request the
    // server already rejected on its merits.
    return !exc.name.startsWith("Minima");
  }
  return false;
}

/** Convenience: validate an outcome string against the wire enum. */
export function asOutcome(o: OutcomeLabel | string): OutcomeLabel {
  if ((["success", "partial", "failure"] as string[]).includes(o)) {
    return o as OutcomeLabel;
  }
  throw new TypeError(`invalid outcome: ${o}`);
}
