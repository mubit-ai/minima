/**
 * HTTP errors — mirrors client_sdk/minima_client/errors.py, including the
 * retryable subtypes.
 */

export class MinimaError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "MinimaError";
    this.status = status;
    this.body = body;
  }
}

/** 429 — the server asked us to slow down; retryAfter is seconds when provided. */
export class MinimaRateLimited extends MinimaError {
  readonly retryAfter: number | null;

  constructor(message: string, status: number, body: unknown, retryAfter: number | null) {
    super(message, status, body);
    this.name = "MinimaRateLimited";
    this.retryAfter = retryAfter;
  }
}

/** 502/503/504 — transient upstream trouble; safe to retry idempotent calls. */
export class MinimaUnavailable extends MinimaError {
  constructor(message: string, status: number, body: unknown) {
    super(message, status, body);
    this.name = "MinimaUnavailable";
  }
}

function extractDetail(body: unknown): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    try {
      return JSON.stringify(detail);
    } catch {
      return String(detail);
    }
  }
  return JSON.stringify(body);
}

/** Throw the matching MinimaError subtype on non-2xx. */
export function raiseForStatus(
  status: number,
  body: unknown,
  retryAfter: number | null = null,
): void {
  if (status >= 200 && status < 300) return;
  const detail = extractDetail(body);
  if (status === 429) throw new MinimaRateLimited(detail, status, body, retryAfter);
  if (status === 502 || status === 503 || status === 504)
    throw new MinimaUnavailable(detail, status, body);
  throw new MinimaError(detail, status, body);
}
