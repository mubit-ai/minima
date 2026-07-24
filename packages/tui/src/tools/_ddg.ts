/**
 * Internal client for DuckDuckGo — the keyless fallback for `web_search` / `web_fetch`
 * when Exa is unavailable (no `EXA_API_KEY`, or the Exa call failed).
 *
 * DuckDuckGo has no official keyless "web results" API, so search scrapes the lite HTML
 * endpoint (`lite.duckduckgo.com/lite/`) and fetch does a raw GET + HTML→text strip. Both
 * are unofficial and best-effort: DDG may rate-limit or return a challenge page, in which
 * case we surface a transient/plain error and callers degrade gracefully.
 *
 * Failure taxonomy mirrors `_exa.ts` so the orchestrator can treat providers uniformly:
 * - DdgTransientError — network blip or HTTP 202/429/5xx. Retried with backoff.
 * - DdgError          — anything else (bad request, unsupported content, parse failure).
 *
 * No API key, no HTML-parsing dependency: parsing is done with small local regex helpers.
 */

import { NetGuardError, assertPublicUrl } from "./_net_guard.ts";

const DDG_LITE_URL = "https://lite.duckduckgo.com/lite/";

/**
 * Sent as User-Agent for both search and fetch. DDG's lite endpoint and many sites reject
 * or challenge requests without a browser-ish UA.
 */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0 Safari/537.36";

export class DdgError extends Error {}
/** Transient failure (network error or HTTP 202/429/5xx). Retryable. */
export class DdgTransientError extends DdgError {}

/** A single search hit or fetched document. Text is only populated by `ddgFetch`. */
export interface DdgResult {
  url: string;
  title?: string | null;
  text?: string | null;
}

export interface DdgResponse {
  results: DdgResult[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Classify a Response's status the way `_exa.ts` does, throwing on non-2xx. */
function checkStatus(status: number): void {
  // 202 is DDG's "anomaly detected" / challenge response — treat as transient.
  if (status === 202 || status === 429 || status >= 500) {
    throw new DdgTransientError(`transient HTTP ${status}`);
  }
  if (status >= 400) {
    throw new DdgError(`HTTP ${status}`);
  }
}

/** GET/POST once with an AbortController timeout; network errors become transient. */
async function requestOnce(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (exc) {
    throw new DdgTransientError(`network error: ${String(exc)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Run `fn`, retrying only transient failures up to 3 attempts (backoff 0.5s → 4s). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (exc) {
      lastErr = exc;
      if (!(exc instanceof DdgTransientError) || attempt === 2) throw exc;
      await sleep(Math.min(4000, 500 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new DdgError(String(lastErr));
}

// --- HTML helpers -----------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
  "#x2F": "/",
  "#47": "/",
};

/** Decode the handful of HTML entities that show up in titles and body text. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    const named = ENTITIES[name];
    if (named !== undefined) return named;
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      if (Number.isFinite(code)) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
    }
    return whole;
  });
}

/** Read one HTML attribute out of an opening-tag's attribute string. */
function attr(attrs: string, name: string): string | null {
  const quoted = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  if (quoted) return quoted[2]!;
  const bare = attrs.match(new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, "i"));
  return bare ? bare[1]! : null;
}

/**
 * Resolve a DDG result href to the real target URL. Lite results are often wrapped in a
 * `//duckduckgo.com/l/?uddg=<encoded>&…` redirect; unwrap it. Protocol-relative hrefs get
 * an https scheme.
 */
function resolveHref(href: string): string {
  let raw = decodeEntities(href.trim());
  if (raw.startsWith("//")) raw = `https:${raw}`;
  try {
    const parsed = new URL(raw, DDG_LITE_URL);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return uddg; // URLSearchParams already percent-decodes
    return parsed.toString();
  } catch {
    return raw;
  }
}

/** Strip tags and decode entities to plain text (title/inner-link text). */
function textFromHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Convert a full HTML document to readable-ish plain text (best-effort, no dependency). */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|head|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Turn block-level closers into line breaks so text doesn't run together.
  s = s.replace(/<br\s*\/?>(?=)/gi, "\n");
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|table|section|article|header|footer|ul|ol)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\r]+/g, " ");
  s = s
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Extract the document `<title>`, if any. */
function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? textFromHtml(m[1]!) || null : null;
}

/** Parse the lite DuckDuckGo results page into `{ url, title }` hits. */
function parseLiteResults(html: string, numResults: number): DdgResult[] {
  const out: DdgResult[] = [];
  const seen = new Set<string>();
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(anchor)) {
    const attrs = m[1]!;
    const inner = m[2]!;
    const cls = attr(attrs, "class") ?? "";
    if (!/\bresult-link\b/i.test(cls)) continue;
    const href = attr(attrs, "href");
    if (!href) continue;
    const url = resolveHref(href);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: textFromHtml(inner) || null });
    if (out.length >= numResults) break;
  }
  return out;
}

// --- Public API -------------------------------------------------------------

/** Search DuckDuckGo (lite HTML endpoint) and return ranked `{ url, title }` results. */
export async function ddgSearch(
  query: string,
  numResults = 5,
  timeoutMs = 15_000,
): Promise<DdgResponse> {
  return withRetry(async () => {
    const resp = await requestOnce(
      DDG_LITE_URL,
      {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "text/html",
        },
        body: new URLSearchParams({ q: query }).toString(),
      },
      timeoutMs,
    );
    checkStatus(resp.status);
    const html = await resp.text();
    return { results: parseLiteResults(html, Math.max(1, numResults)) };
  });
}

const MAX_REDIRECT_HOPS = 5;

/** Run the SSRF guard, converting a policy rejection into a clean non-retryable DdgError. */
async function guardUrl(url: string): Promise<void> {
  try {
    await assertPublicUrl(url);
  } catch (exc) {
    if (exc instanceof NetGuardError) throw new DdgError(exc.message);
    throw exc;
  }
}

/** GET with redirects followed manually so every hop — not just the first URL — passes
 * the SSRF guard before a connection is opened. */
async function fetchGuarded(url: string, timeoutMs: number): Promise<Response> {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    await guardUrl(target);
    const resp = await requestOnce(
      target,
      {
        method: "GET",
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
        redirect: "manual",
      },
      timeoutMs,
    );
    const location = resp.headers.get("location");
    if (resp.status < 300 || resp.status >= 400 || !location) return resp;
    try {
      target = new URL(location, target).toString();
    } catch {
      throw new DdgError(`invalid redirect location from ${target}`);
    }
  }
  throw new DdgError(`too many redirects (>${MAX_REDIRECT_HOPS}) fetching ${url}`);
}

/** Fetch one URL directly and return its main text (raw GET + HTML→text strip). */
export async function ddgFetch(url: string, timeoutMs = 20_000): Promise<DdgResponse> {
  return withRetry(async () => {
    const resp = await fetchGuarded(url, timeoutMs);
    checkStatus(resp.status);
    const ctype = (resp.headers.get("content-type") ?? "").toLowerCase();
    if (ctype && !/text\/html|text\/plain|application\/xhtml/.test(ctype)) {
      throw new DdgError(`unsupported content type: ${ctype.split(";")[0]}`);
    }
    const html = await resp.text();
    const isHtml = !ctype || /html|xml/.test(ctype);
    const text = isHtml ? htmlToText(html) : html.trim();
    return { results: [{ url, title: isHtml ? extractTitle(html) : null, text }] };
  });
}
