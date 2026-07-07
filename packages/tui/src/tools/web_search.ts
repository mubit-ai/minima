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
