/**
 * Shared test utilities: a controllable clock, a fixed token registry and a
 * tiny request builder so tests read close to the wire format.
 */

import type { ApiRequest, TokenRecord } from "../src/types.ts";
import { createApp, type App, type AppOptions } from "../src/app.ts";

/** Secrets used across the suite. */
export const TOKENS = {
  alice: "tok_alice",
  bob: "tok_bob",
  carol: "tok_carol",
  root: "tok_root",
} as const;

/** Registry used by every test app: two writers, a reader, an admin. */
export function testTokens(): TokenRecord[] {
  return [
    { id: "alice", token: TOKENS.alice, scopes: ["read", "write"] },
    { id: "bob", token: TOKENS.bob, scopes: ["read", "write"] },
    { id: "carol", token: TOKENS.carol, scopes: ["read"] },
    { id: "root", token: TOKENS.root, scopes: ["read", "write", "admin"] },
  ];
}

/** Deterministic, manually advanced clock. */
export class TestClock {
  private t = Date.parse("2026-01-01T00:00:00.000Z");
  readonly now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Build an app wired to a TestClock and the standard test registry. */
export function makeApp(overrides: AppOptions = {}): { app: App; clock: TestClock } {
  const clock = new TestClock();
  const app = createApp({ now: clock.now, tokens: testTokens(), ...overrides });
  return { app, clock };
}

/** Extra request knobs accepted by {@link req}. */
export interface ReqOptions {
  token?: string;
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

/** Build an ApiRequest the way the transport adapter would. */
export function req(method: string, path: string, opts: ReqOptions = {}): ApiRequest {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  const request: ApiRequest = { method, path, headers, query: opts.query ?? {} };
  if (opts.body !== undefined) request.body = opts.body;
  return request;
}
