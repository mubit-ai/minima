/**
 * Provider orchestration for the `web_search` / `web_fetch` tools.
 *
 * Keeps the tools thin: they call `searchWeb` / `fetchWeb` and never know which backend
 * answered. The fallback policy is:
 *
 *   - `EXA_API_KEY` set  → try Exa; if the Exa call fails, fall back to DuckDuckGo.
 *   - `EXA_API_KEY` unset → use DuckDuckGo directly.
 *
 * DuckDuckGo is keyless (scrapes the lite endpoint), so it is always reachable as a
 * backup. Any known provider failure surfaces to the tool as a single `WebSearchError`;
 * unexpected (non-provider) errors propagate unchanged.
 */

import { DdgError, ddgFetch, ddgSearch } from "./_ddg.ts";
import { ExaError, exaContents, exaSearch } from "./_exa.ts";

export type SearchProvider = "exa" | "duckduckgo";

/** A normalized result, provider-agnostic. `text` is only set for fetches. */
export interface WebResult {
  url: string;
  title?: string | null;
  publishedDate?: string | null;
  text?: string | null;
}

export interface WebResponse {
  results: WebResult[];
  /** Which backend produced these results (surfaced in tool `details`). */
  provider: SearchProvider;
}

/** Uniform error the tools catch, regardless of which provider failed. */
export class WebSearchError extends Error {}

function hasExaKey(): boolean {
  return Boolean(process.env.EXA_API_KEY);
}

/**
 * Run `exa` when a key is present, falling back to `ddg` on any Exa failure; run `ddg`
 * directly when there is no key. Provider errors are normalized to `WebSearchError`.
 */
async function withFallback(
  exa: () => Promise<WebResult[]>,
  ddg: () => Promise<WebResult[]>,
): Promise<WebResponse> {
  if (hasExaKey()) {
    try {
      return { results: await exa(), provider: "exa" };
    } catch (exc) {
      // Exa gave up (auth/transient/other) — try the keyless backup before failing.
      if (!(exc instanceof ExaError)) throw exc;
    }
  }
  try {
    return { results: await ddg(), provider: "duckduckgo" };
  } catch (exc) {
    if (exc instanceof DdgError) throw new WebSearchError(exc.message);
    throw exc;
  }
}

/** Search the web via Exa, falling back to DuckDuckGo. */
export function searchWeb(query: string, numResults: number): Promise<WebResponse> {
  return withFallback(
    async () => (await exaSearch(query, numResults)).results,
    async () => (await ddgSearch(query, numResults)).results,
  );
}

/** Fetch one URL's readable text via Exa, falling back to a raw DuckDuckGo fetch. */
export function fetchWeb(url: string, maxChars: number): Promise<WebResponse> {
  return withFallback(
    async () => (await exaContents([url], maxChars)).results,
    async () => (await ddgFetch(url)).results,
  );
}
