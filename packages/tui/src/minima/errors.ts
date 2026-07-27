/**
 * HTTP errors — mirrors client_sdk/minima_client/errors.py.
 *
 * Server errors come back as {"detail": "..."} (FastAPI) or {"detail": {...}};
 * we surface the detail string on MinimaError for parity with the Python client.
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
  // A non-JSON body (proxy HTML, empty 502/504) parses to null — JSON.stringify would
  // render the literal string "null" as the error message. Return empty so raiseForStatus
  // falls back to the status, which is the only real information such a response carries.
  if (body === null || body === undefined) return "";
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

/** Throw the matching MinimaError subtype on non-2xx, mirroring Python's raise_for_status. */
export function raiseForStatus(
  status: number,
  body: unknown,
  retryAfter: number | null = null,
): void {
  if (status >= 200 && status < 300) return;
  const detail = extractDetail(body) || `HTTP ${status}`;
  if (status === 429) throw new MinimaRateLimited(detail, status, body, retryAfter);
  if (status === 502 || status === 503 || status === 504)
    throw new MinimaUnavailable(detail, status, body);
  throw new MinimaError(detail, status, body);
}

/**
 * The server's structured budget-infeasibility rejection: NoCandidatesError → 422
 * problem+json with detail "no model within max_cost_per_call budget" (api/errors.py).
 * A reachable, healthy service saying "nothing fits this cost cap" — never conflate it
 * with connectivity offline.
 */
export function isBudgetInfeasible(exc: unknown): boolean {
  return exc instanceof MinimaError && exc.status === 422 && exc.message.includes("budget");
}
