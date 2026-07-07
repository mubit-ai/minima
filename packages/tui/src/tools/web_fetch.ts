/**
 * web_fetch — fetch a single URL's main readable text.
 * Port of minima_harness/tools/web_fetch.py.
 *
 * Uses Exa's /contents extraction when `EXA_API_KEY` is set, falling back to a keyless
 * raw fetch + HTML→text strip when the key is absent or the Exa call fails (see
 * _search.ts). The fallback's extraction is coarser than Exa's readability.
 */

import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { WebSearchError, fetchWeb } from "./_search.ts";
import { objectSchema } from "./schema.ts";

const DEFAULT_MAX_CHARS = 8000;
const MIN_MAX_CHARS = 500;
const MAX_MAX_CHARS = 50_000;

const parameters = objectSchema(
  {
    url: { type: "string", description: "The URL to fetch and read." },
    max_chars: {
      type: "integer",
      description:
        "Maximum characters of page text to return (output is truncated past this). 500–50000.",
      default: DEFAULT_MAX_CHARS,
    },
  },
  ["url"],
);

async function execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
  const url = String(params.url ?? "");
  const maxChars = Math.max(
    MIN_MAX_CHARS,
    Math.min(MAX_MAX_CHARS, (params.max_chars as number) ?? DEFAULT_MAX_CHARS),
  );

  let data: Awaited<ReturnType<typeof fetchWeb>>;
  try {
    data = await fetchWeb(url, maxChars);
  } catch (exc) {
    if (exc instanceof WebSearchError) return errorResult(`web_fetch failed: ${exc.message}`);
    throw exc;
  }

  if (!data.results.length) {
    return errorResult(`web_fetch: no content returned for ${url}`);
  }

  const r = data.results[0]!;
  let body = (r.text ?? "").trim();
  if (!body) {
    return errorResult(`web_fetch: page had no extractable text (${url})`);
  }

  let suffix = "";
  if (body.length > maxChars) {
    const extra = body.length - maxChars;
    body = body.slice(0, maxChars);
    suffix = `\n\n[truncated — ${extra} more chars]`;
  }

  const header = r.title ? `# ${r.title}\n${url}\n\n` : `${url}\n\n`;
  return {
    content: [text(header + body + suffix)],
    details: { url, chars: body.length, truncated: Boolean(suffix) },
  };
}

export function webFetchTool(): AgentTool {
  return {
    name: "web_fetch",
    description:
      "Fetch a single URL and return its main readable text (not raw HTML). " +
      "Use after web_search to read a result, or on any URL you already have. " +
      "Long pages are truncated; raise max_chars if you need more.",
    parameters,
    execute,
  };
}
