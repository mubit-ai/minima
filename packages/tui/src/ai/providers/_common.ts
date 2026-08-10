/**
 * Shared helpers for provider implementations.
 *
 * Port of the Python harness's ai/providers/_common.py.
 */

import { errText } from "../../errtext.ts";
import { type ErrorEvent, error as errorEv } from "../events.ts";
import { AssistantMessage, type Model, type ToolSchema, text } from "../types.ts";

/**
 * The uniform "this call failed" event every provider yields: an error-stopped
 * AssistantMessage tagged with the model that failed. `reason` takes a thrown value or a
 * plain message string. agent/loop.ts drops these from history before the next request,
 * which is why the empty text block here never reaches a provider.
 */
export function providerError(model: Model, reason: unknown): ErrorEvent {
  const err = new AssistantMessage({
    content: [text("")],
    stop_reason: "error",
    error_message: errText(reason),
  });
  err.model = model.id;
  return errorEv("error", err);
}

/**
 * A failure worth a second attempt: a network blip, or a status the host wants us to come
 * back on. Providers classify; {@link retryTransient} only counts and sleeps.
 */
export class TransientError extends Error {}

/** Attempts for a request that fails BEFORE any bytes arrive. 3 adds at most 1.5s. */
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

/**
 * Status codes worth retrying: request timeout, rate limit, and any server-side failure
 * (which covers Anthropic's 529 and whatever a proxy invents). Everything else — 400, 401,
 * 404 — is the request's own fault and repeating it just wastes the user's time.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Sleep `ms`, waking early if `signal` aborts, so Esc is never stuck behind a backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Run `fn`, retrying ONLY what it marks {@link TransientError}, 3 attempts at 500ms → 1s.
 *
 * Callers wrap the part of a request that runs before the first byte of the response body:
 * once deltas are out a retry would duplicate them, so a mid-stream failure is terminal and
 * belongs to the recovery ladder (minima/runtime.ts), which is the layer that can re-route.
 *
 * `enabled: false` collapses this to a single attempt — how tests keep their suites instant
 * without pretending the retry does not exist.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  opts: { signal?: AbortSignal; enabled?: boolean } = {},
): Promise<T> {
  const attempts = opts.enabled === false ? 1 : RETRY_ATTEMPTS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (exc) {
      if (attempt >= attempts || !(exc instanceof TransientError) || opts.signal?.aborted)
        throw exc;
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), opts.signal);
      if (opts.signal?.aborted) throw exc;
    }
  }
}

/** Options value wins, then the first set environment variable. */
export function resolveApiKey(
  options: Record<string, unknown> | undefined,
  ...envVars: string[]
): string | undefined {
  if (options?.api_key) return String(options.api_key);
  for (const v of envVars) {
    const value = process.env[v];
    if (value) return value;
  }
  return undefined;
}

/** Request deadline (ms) from the harness's seconds-based option. options.timeout is in
 * SECONDS (the harness-wide contract); every SDK and AbortSignal.timeout expects
 * milliseconds. Passing seconds through gave every request a 30-60ms deadline: all Claude
 * calls died with "Request timed out". */
export function sdkTimeoutMs(options: Record<string, unknown>): number {
  return Math.round(Number(options.timeout ?? 60) * 1000);
}

/**
 * A provider-agnostic JSON Schema for a tool's parameter model.
 *
 * In the Python port this derives the schema from a pydantic model and strips
 * title/anyOf-const noise. Here the ToolSchema already carries its jsonSchema,
 * so we just normalize it (drop `title`, flatten anyOf[{const}] -> enum).
 */
export function toJsonSchema(schema: ToolSchema): Record<string, unknown> {
  const clone: Record<string, unknown> = JSON.parse(JSON.stringify(schema.jsonSchema));
  cleanSchema(clone);
  return clone;
}

function cleanSchema(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) cleanSchema(item);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    delete obj.title;
    const anyOf = obj.anyOf;
    if (Array.isArray(anyOf) && anyOf.every((a) => a && typeof a === "object" && "const" in a)) {
      obj.enum = anyOf.map((a) => (a as { const: unknown }).const);
      delete obj.anyOf;
    }
    for (const v of Object.values(obj)) cleanSchema(v);
  }
}
