/**
 * web_search — search the web and return a numbered list of results.
 * Port of minima_harness/tools/web_search.py.
 *
 * Uses Exa when `EXA_API_KEY` is set, falling back to a keyless DuckDuckGo search when
 * the key is absent or the Exa call fails (see _search.ts).
 */

import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { attr, resolveHref, textFromHtml } from "./_ddg.ts";
import { WebSearchError, searchWeb } from "./_search.ts";
import { objectSchema } from "./schema.ts";

const DEFAULT_RESULTS = 5;

/** A parsed DuckDuckGo HTML SERP hit: a title/url pair with its snippet. */
export interface ParsedResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Parse a DuckDuckGo HTML SERP into `{ title, url, snippet }` hits. Each result is a
 * `result__a` anchor (title text + a `/l/?uddg=` redirect href we unwrap) paired with the
 * following `result__snippet` anchor. Best-effort regex scan; stops at `limit`.
 */
export function parseResults(html: string, limit: number): ParsedResult[] {
  const out: ParsedResult[] = [];
  let pending: { title: string; url: string } | null = null;
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(anchor)) {
    if (out.length >= limit) break;
    const cls = attr(m[1]!, "class") ?? "";
    if (/\bresult__a\b/i.test(cls)) {
      const href = attr(m[1]!, "href");
      pending = href ? { title: textFromHtml(m[2]!), url: resolveHref(href) } : null;
    } else if (/\bresult__snippet\b/i.test(cls) && pending) {
      out.push({ title: pending.title, url: pending.url, snippet: textFromHtml(m[2]!) });
      pending = null;
    }
  }
  return out;
}

const parameters = objectSchema(
  {
    query: { type: "string", description: "The search query." },
    num_results: {
      type: "integer",
      description: "How many results to return (1–10).",
      default: DEFAULT_RESULTS,
    },
  },
  ["query"],
);

async function execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
  const query = String(params.query ?? "");
  const numResults = Math.max(1, Math.min(10, (params.num_results as number) ?? DEFAULT_RESULTS));

  let data: Awaited<ReturnType<typeof searchWeb>>;
  try {
    data = await searchWeb(query, numResults);
  } catch (exc) {
    if (exc instanceof WebSearchError) return errorResult(`web_search failed: ${exc.message}`);
    throw exc;
  }

  if (!data.results.length) {
    return { content: [text("No results found.")], details: { count: 0, provider: data.provider } };
  }

  const lines = data.results.map((r, i) => {
    const title = r.title || "(no title)";
    const date = r.publishedDate ? ` (${r.publishedDate})` : "";
    return `[${i + 1}] ${title}${date}\n    ${r.url}`;
  });
  return {
    content: [text(lines.join("\n"))],
    details: { count: data.results.length, provider: data.provider },
  };
}

export function webSearchTool(): AgentTool {
  return {
    name: "web_search",
    description:
      "Search the web for current information. Returns a numbered list of " +
      "results with titles and URLs. Use this when you need facts you don't " +
      "know or that may have changed. To read a result, pass its URL to web_fetch.",
    parameters,
    execute,
  };
}
