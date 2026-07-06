/**
 * linkbox — application shell.
 *
 * {@link createApp} wires the store, token registry, rate limiter and route
 * table behind a single synchronous `handle()` function. The shell owns all
 * cross-cutting behaviour, in this order:
 *
 *   1. routing            (unknown path → 404, known path wrong verb → 405)
 *   2. rate limiting      (routes flagged `rateLimited`, keyed by client ip)
 *   3. authentication     (routes with a `scope`: 401 bad/missing credential,
 *                          403 valid credential lacking the scope)
 *   4. handler dispatch   (typed store errors are mapped to HTTP statuses)
 *
 * Everything time-dependent flows from the injected `now` clock, so tests
 * can drive expiry windows and timestamps deterministically.
 */

import type { ApiRequest, ApiResponse, AuthContext, TokenRecord } from "./types.ts";
import { Router } from "./router.ts";
import { Store } from "./store.ts";
import { TokenRegistry, authenticate, hasScope } from "./auth.ts";
import { FixedWindowLimiter } from "./ratelimit.ts";
import { ConflictError, NotFoundError, ValidationError } from "./errors.ts";
import { json } from "./respond.ts";
import { linkRoutes } from "./handlers/links.ts";
import { noteRoutes } from "./handlers/notes.ts";
import { statsRoutes } from "./handlers/stats.ts";
import { adminRoutes } from "./handlers/admin.ts";

/** Options for {@link createApp}; everything has a sensible default. */
export interface AppOptions {
  /** Injected clock (ms since epoch); defaults to Date.now. */
  now?: () => number;
  /** Token registry contents; defaults to the local-dev tokens. */
  tokens?: TokenRecord[];
  /** Rate-limit policy for `rateLimited` routes. */
  rateLimit?: { limit: number; windowMs: number };
  /** Seed for the store's slug generator. */
  slugSeed?: number;
}

/** A fully wired application instance. */
export interface App {
  /** Dispatch one request through the full middleware pipeline. */
  handle(req: ApiRequest): ApiResponse;
  store: Store;
  registry: TokenRegistry;
  limiter: FixedWindowLimiter;
}

/**
 * Tokens shipped for local development only. Deployments always pass their
 * own registry via {@link AppOptions.tokens}.
 */
const DEV_TOKENS: TokenRecord[] = [
  { id: "dev-admin", token: "tok_dev_admin", scopes: ["read", "write", "admin"] },
  { id: "dev-writer", token: "tok_dev_writer", scopes: ["read", "write"] },
];

/** Default policy: 120 redirects per minute per client address. */
const DEFAULT_RATE_LIMIT = { limit: 120, windowMs: 60_000 };

/** Rate-limit key: proxy-provided client address, or a local fallback. */
function clientKey(req: ApiRequest): string {
  return req.headers["x-forwarded-for"] ?? "local";
}

/** Build an application instance. */
export function createApp(options: AppOptions = {}): App {
  const now = options.now ?? (() => Date.now());
  const bootedAt = now();
  const store = new Store({ now, slugSeed: options.slugSeed });
  const registry = new TokenRegistry(options.tokens ?? DEV_TOKENS);
  const policy = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const limiter = new FixedWindowLimiter({ ...policy, now });

  const router = new Router();
  router.add({
    method: "GET",
    pattern: "/api/health",
    handler: () => json(200, { ok: true, uptimeMs: now() - bootedAt }),
  });
  router.addAll(linkRoutes({ store }));
  router.addAll(noteRoutes({ store }));
  router.addAll(statsRoutes({ store }));
  router.addAll(adminRoutes({ store, limiter }));

  function handle(req: ApiRequest): ApiResponse {
    const match = router.resolve(req.method, req.path);
    if (match === null) {
      return router.hasPath(req.path)
        ? json(405, { error: "method_not_allowed" })
        : json(404, { error: "not_found" });
    }
    const { def, params } = match;

    if (def.rateLimited === true) {
      const decision = limiter.hit(clientKey(req));
      if (!decision.allowed) {
        return {
          status: 429,
          body: { error: "rate_limited", retryAfterMs: decision.retryAfterMs },
          headers: { "retry-after-ms": String(decision.retryAfterMs) },
        };
      }
    }

    let auth: AuthContext | null = null;
    if (def.scope !== undefined) {
      auth = authenticate(req.headers, registry);
      if (auth === null) return json(401, { error: "unauthorized" });
      if (!hasScope(auth, def.scope)) return json(403, { error: "forbidden" });
    }

    try {
      return def.handler(req, { params, auth, now });
    } catch (err) {
      if (err instanceof ValidationError) return json(400, { error: "invalid_request", detail: err.message });
      if (err instanceof NotFoundError) return json(404, { error: "not_found" });
      if (err instanceof ConflictError) return json(409, { error: "conflict" });
      const detail = err instanceof Error ? err.message : String(err);
      return json(500, { error: "internal", detail });
    }
  }

  return { handle, store, registry, limiter };
}
