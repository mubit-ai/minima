/**
 * Internal client for the Exa web-search API (https://docs.exa.ai).
 *
 * Shared by the `web_search` and `web_fetch` tools. Port of
 * minima_harness/tools/_exa.py. Talks to Exa over `fetch` and classifies failures
 * so callers can react sensibly:
 *
 * - ExaAuthError    — bad/missing key (HTTP 401/403). Never retried.
 * - ExaTransientError — network blip or HTTP 429/5xx. Retried with backoff.
 * - ExaError        — anything else (bad request, malformed JSON). Not retried.
 *
 * Every failure surfaces as an ExaError (or subclass), so tools catch one type.
 * The API key is read from `EXA_API_KEY` at call time — never hard-coded, never logged.
 */

const EXA_BASE_URL = "https://api.exa.ai";

export class ExaError extends Error {}
/** Authentication failed (missing/invalid key). Not retryable. */
export class ExaAuthError extends ExaError {}
/** Transient failure (network error or HTTP 429/5xx). Retryable. */
export class ExaTransientError extends ExaError {}

/** A single search hit or fetched document. Extra fields from Exa are ignored. */
export interface ExaResult {
  url: string;
  id?: string;
  title?: string | null;
  publishedDate?: string | null;
  author?: string | null;
  score?: number | null;
  text?: string | null;
}

export interface ExaResponse {
  results: ExaResult[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function postOnce(
  path: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new ExaError("EXA_API_KEY is not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${EXA_BASE_URL}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (exc) {
    throw new ExaTransientError(`network error: ${String(exc)}`);
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new ExaAuthError(`authentication failed (HTTP ${resp.status})`);
  }
  if (resp.status === 429 || resp.status >= 500) {
    throw new ExaTransientError(`transient HTTP ${resp.status}`);
  }
  if (resp.status >= 400) {
    const body = (await resp.text()).slice(0, 200);
    throw new ExaError(`HTTP ${resp.status}: ${body}`);
  }

  try {
    return (await resp.json()) as Record<string, unknown>;
  } catch (exc) {
    throw new ExaError(`invalid JSON from Exa: ${String(exc)}`);
  }
}

/**
 * POST `payload` to `{EXA_BASE_URL}{path}` and return parsed JSON.
 * Retries only transient failures (network / 429 / 5xx) up to 3 attempts with
 * exponential backoff (0.5s → 4s); auth and other client errors surface immediately.
 */
async function post(
  path: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await postOnce(path, payload, timeoutMs);
    } catch (exc) {
      lastErr = exc;
      if (!(exc instanceof ExaTransientError) || attempt === 2) throw exc;
      await sleep(Math.min(4000, 500 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new ExaError(String(lastErr));
}

function toResults(data: Record<string, unknown>): ExaResult[] {
  const raw = Array.isArray(data.results) ? data.results : [];
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      url: String(o.url ?? ""),
      id: o.id ? String(o.id) : "",
      title: (o.title as string | null | undefined) ?? null,
      publishedDate: (o.publishedDate as string | null | undefined) ?? null,
      author: (o.author as string | null | undefined) ?? null,
      score: (o.score as number | null | undefined) ?? null,
      text: (o.text as string | null | undefined) ?? null,
    };
  });
}

/** Run a web search and return ranked results (titles + URLs, no body text). */
export async function exaSearch(
  query: string,
  numResults = 5,
  timeoutMs = 15_000,
): Promise<ExaResponse> {
  const data = await post("/search", { query, numResults }, timeoutMs);
  return { results: toResults(data) };
}

/** Fetch readable text for one or more URLs (Exa extracts the main content). */
export async function exaContents(
  urls: string[],
  maxChars = 8000,
  timeoutMs = 20_000,
): Promise<ExaResponse> {
  const text: unknown = maxChars ? { maxCharacters: maxChars } : true;
  const data = await post("/contents", { urls, text }, timeoutMs);
  return { results: toResults(data) };
}
