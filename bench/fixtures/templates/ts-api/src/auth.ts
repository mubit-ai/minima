/**
 * linkbox — bearer-token authentication.
 *
 * The only accepted credential form is:
 *
 *     Authorization: Bearer <token>
 *
 * The scheme is matched case-insensitively (RFC 7235), exactly one space
 * separates scheme and token, and the token must be a single run of
 * non-whitespace characters. Anything else — a missing scheme, a different
 * scheme, extra whitespace, trailing garbage — is rejected outright; the
 * server never guesses what a malformed client meant.
 */

import type { AuthContext, Scope, TokenRecord } from "./types.ts";
import { ValidationError } from "./errors.ts";

/**
 * Extract the bearer token from an Authorization header value.
 *
 * Leading/trailing whitespace around the whole header value is tolerated
 * (some proxies pad it); everything inside must match the strict form.
 * Returns `null` when the header is absent or malformed.
 */
export function parseBearerToken(headerValue: string | undefined): string | null {
  if (headerValue === undefined) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(headerValue.trim());
  return match ? match[1]! : null;
}

/** In-memory token registry with O(1) secret lookup. */
export class TokenRegistry {
  private readonly byToken = new Map<string, TokenRecord>();

  constructor(records: TokenRecord[]) {
    for (const record of records) {
      if (this.byToken.has(record.token)) {
        throw new ValidationError(`duplicate token secret for id ${record.id}`);
      }
      this.byToken.set(record.token, { ...record, scopes: [...record.scopes] });
    }
  }

  /** Look a secret up; returns the token record or `undefined`. */
  lookup(token: string): TokenRecord | undefined {
    return this.byToken.get(token);
  }

  /** Number of registered tokens (diagnostics only). */
  size(): number {
    return this.byToken.size;
  }
}

/**
 * Authenticate a request from its header map.
 *
 * Returns the caller's {@link AuthContext} when the Authorization header is
 * well-formed AND the token is registered; `null` otherwise. The caller maps
 * `null` to HTTP 401.
 */
export function authenticate(
  headers: Record<string, string>,
  registry: TokenRegistry,
): AuthContext | null {
  const token = parseBearerToken(headers["authorization"]);
  if (token === null) return null;
  const record = registry.lookup(token);
  if (record === undefined) return null;
  return { tokenId: record.id, scopes: [...record.scopes] };
}

/** True when the authenticated caller holds the given scope. */
export function hasScope(auth: AuthContext, scope: Scope): boolean {
  return auth.scopes.includes(scope);
}
