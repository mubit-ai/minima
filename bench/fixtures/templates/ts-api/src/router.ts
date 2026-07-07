/**
 * linkbox — a tiny exact-segment router.
 *
 * Patterns are plain paths whose `:name` segments each capture exactly one
 * path segment, e.g. `"/api/links/:slug"`. Matching rules:
 *
 *   - segment counts must match exactly (no wildcards, no optional parts);
 *   - literal segments compare case-sensitively;
 *   - empty segments are ignored, so `/api/links/` matches `/api/links`;
 *   - captured values are URL-decoded before being handed to handlers.
 *
 * Routes are checked in registration order; the first match wins.
 */

import type { RouteDef } from "./types.ts";

/** A successful lookup: the route plus its captured path parameters. */
export interface RouteMatch {
  def: RouteDef;
  params: Record<string, string>;
}

/** Split a path into its non-empty segments (`"/a//b/"` → `["a", "b"]`). */
export function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * Match a single pattern against a concrete path.
 *
 * Returns the captured `:name` parameters on success, or `null` when the
 * path does not fit the pattern.
 */
export function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const want = splitPath(pattern);
  const got = splitPath(path);
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const expected = want[i]!;
    const actual = got[i]!;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

/** Ordered route table with first-match-wins resolution. */
export class Router {
  private readonly routes: RouteDef[] = [];

  /** Register a single route. Returns `this` for chaining. */
  add(def: RouteDef): this {
    this.routes.push(def);
    return this;
  }

  /** Register several routes preserving their order. */
  addAll(defs: RouteDef[]): this {
    for (const def of defs) this.add(def);
    return this;
  }

  /** Find the first route matching `method` + `path`, or `null`. */
  resolve(method: string, path: string): RouteMatch | null {
    const verb = method.toUpperCase();
    for (const def of this.routes) {
      if (def.method.toUpperCase() !== verb) continue;
      const params = matchPattern(def.pattern, path);
      if (params !== null) return { def, params };
    }
    return null;
  }

  /**
   * True when at least one route matches the path regardless of method.
   * The app shell uses this to distinguish 404 from 405 responses.
   */
  hasPath(path: string): boolean {
    return this.routes.some((def) => matchPattern(def.pattern, path) !== null);
  }

  /** Number of registered routes (diagnostics only). */
  size(): number {
    return this.routes.length;
  }
}
