/**
 * web_search — search the web and return a numbered list of results.
 * Port of minima_harness/tools/web_search.py.
 *
 * Uses Exa when `EXA_API_KEY` is set, falling back to a keyless DuckDuckGo search when
 * the key is absent or the Exa call fails (see _search.ts).
 */

import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { WebSearchError, searchWeb } from "./_search.ts";
import { objectSchema } from "./schema.ts";

const DEFAULT_RESULTS = 5;

/** Exa's published per-search price ($5 / 1k searches) — real provider spend the meter
 * books per call (MUB-172). DuckDuckGo is keyless and free. */
export const EXA_SEARCH_FEE_USD = 0.005;

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

export interface WebSearchToolOptions {
  /** Booking seam for the provider fee, keyed by this call's tool_call_id. Fires only when
   * the answering provider charges (Exa) — a fee is charged even for zero results. */
  onFeeUsd?: (usd: number, toolCallId: string) => void;
}

export function webSearchTool(opts: WebSearchToolOptions = {}): AgentTool {
  async function execute(id: string, params: Record<string, unknown>): Promise<ToolResult> {
    const query = String(params.query ?? "");
    const numResults = Math.max(1, Math.min(10, (params.num_results as number) ?? DEFAULT_RESULTS));

    let data: Awaited<ReturnType<typeof searchWeb>>;
    try {
      data = await searchWeb(query, numResults);
    } catch (exc) {
      if (exc instanceof WebSearchError) return errorResult(`web_search failed: ${exc.message}`);
      throw exc;
    }

    const feeUsd = data.provider === "exa" ? EXA_SEARCH_FEE_USD : 0;
    if (feeUsd > 0) opts.onFeeUsd?.(feeUsd, id);

    if (!data.results.length) {
      return {
        content: [text("No results found.")],
        details: { count: 0, provider: data.provider, feeUsd },
      };
    }

    const lines = data.results.map((r, i) => {
      const title = r.title || "(no title)";
      const date = r.publishedDate ? ` (${r.publishedDate})` : "";
      return `[${i + 1}] ${title}${date}\n    ${r.url}`;
    });
    return {
      content: [text(lines.join("\n"))],
      details: { count: data.results.length, provider: data.provider, feeUsd },
    };
  }

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
