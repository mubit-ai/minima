/**
 * linkbox — tiny response constructors shared by every handler.
 */

import type { ApiResponse } from "./types.ts";

/** A JSON response with the given status. */
export function json(status: number, body: unknown): ApiResponse {
  return { status, body };
}

/** An empty 204 response. */
export function noContent(): ApiResponse {
  return { status: 204, body: null };
}

/** A 302 redirect to `location`. */
export function redirect(location: string): ApiResponse {
  return { status: 302, body: null, headers: { location } };
}
