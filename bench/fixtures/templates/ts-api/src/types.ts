/**
 * linkbox — shared type definitions.
 *
 * The service is deliberately transport-agnostic: every handler consumes a
 * plain {@link ApiRequest} and produces a plain {@link ApiResponse}. A thin
 * adapter (not part of this package) can bind the app to a real socket,
 * while tests drive the handlers fully in-process without opening a port.
 */

/** Scopes a token may carry. Route definitions declare the scope they need. */
export type Scope = "read" | "write" | "admin";

/** Incoming request, already decoded by the transport adapter. */
export interface ApiRequest {
  /** HTTP verb, e.g. `"GET"`. Matching is case-insensitive. */
  method: string;
  /** Path component only (no query string), e.g. `"/api/links/docs"`. */
  path: string;
  /** Header map; keys are lower-cased by the adapter. */
  headers: Record<string, string>;
  /** Decoded query-string parameters. */
  query: Record<string, string>;
  /** Parsed JSON body when the request carried one. */
  body?: unknown;
}

/** Outgoing response produced by a handler. */
export interface ApiResponse {
  status: number;
  /** JSON-serialisable payload; `null` for empty bodies (204, redirects). */
  body: unknown;
  /** Optional extra headers (e.g. `location` for redirects). */
  headers?: Record<string, string>;
}

/** Authenticated caller identity attached to the handler context. */
export interface AuthContext {
  /** Stable id of the token record (never the secret itself). */
  tokenId: string;
  /** Scopes granted to the token. */
  scopes: Scope[];
}

/** Per-request context passed to handlers alongside the raw request. */
export interface HandlerCtx {
  /** Path parameters extracted by the router, e.g. `{ slug: "docs" }`. */
  params: Record<string, string>;
  /** Present when the matched route declared a scope; `null` on public routes. */
  auth: AuthContext | null;
  /** Injected clock (milliseconds since epoch). Never call Date.now directly. */
  now: () => number;
}

/** A single route table entry. */
export interface RouteDef {
  method: string;
  /** Pattern with `:name` placeholders, e.g. `"/api/links/:slug"`. */
  pattern: string;
  /** Scope required to call the route; omit for public routes. */
  scope?: Scope;
  /** When true the route is subject to the app's rate limiter. */
  rateLimited?: boolean;
  handler: (req: ApiRequest, ctx: HandlerCtx) => ApiResponse;
}

/** API token registry entry. */
export interface TokenRecord {
  /** Stable identifier used for attribution in logs and audit trails. */
  id: string;
  /** The bearer secret presented in the Authorization header. */
  token: string;
  scopes: Scope[];
}

/**
 * A stored short link. Click counts are deliberately NOT part of the record:
 * they live in the store's click ledger so that hot resolve traffic never
 * rewrites canonical records.
 */
export interface LinkRecord {
  id: string;
  slug: string;
  url: string;
  /** ISO-8601 creation timestamp derived from the injected clock. */
  createdAt: string;
}

/** A stored note. */
export interface NoteRecord {
  id: string;
  title: string;
  body: string;
  tags: string[];
  /** ISO-8601 creation timestamp derived from the injected clock. */
  createdAt: string;
}
