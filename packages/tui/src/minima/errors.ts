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

/** Throw a MinimaError on non-2xx, mirroring Python's raise_for_status. */
export function raiseForStatus(status: number, body: unknown): void {
  if (status >= 200 && status < 300) return;
  throw new MinimaError(extractDetail(body), status, body);
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
