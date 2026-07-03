/**
 * web_search — search the web via Exa and return a numbered list of results.
 * Port of minima_harness/tools/web_search.py.
 */

import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { ExaError, exaSearch } from "./_exa.ts";
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

  let data: Awaited<ReturnType<typeof exaSearch>>;
  try {
    data = await exaSearch(query, numResults);
  } catch (exc) {
    if (exc instanceof ExaError) return errorResult(`web_search failed: ${exc.message}`);
    throw exc;
  }

  if (!data.results.length) {
    return { content: [text("No results found.")], details: { count: 0 } };
  }

  const lines = data.results.map((r, i) => {
    const title = r.title || "(no title)";
    const date = r.publishedDate ? ` (${r.publishedDate})` : "";
    return `[${i + 1}] ${title}${date}\n    ${r.url}`;
  });
  return {
    content: [text(lines.join("\n"))],
    details: { count: data.results.length },
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
