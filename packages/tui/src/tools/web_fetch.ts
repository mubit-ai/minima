import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { objectSchema } from "./schema.ts";

const MAX_CHARS = 5000;
const TIMEOUT_MS = 15_000;

const parameters = objectSchema(
  {
    url: { type: "string", description: "URL to fetch." },
    max_chars: {
      type: "integer",
      description: "Maximum characters to return.",
      default: MAX_CHARS,
    },
  },
  ["url"],
);

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

async function execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
  const url = String(params.url ?? "");
  const maxChars = (params.max_chars as number) ?? MAX_CHARS;

  if (!url || !url.startsWith("http")) {
    return errorResult(`web_fetch: invalid URL: ${url}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*",
      },
      redirect: "follow",
    });

    if (!resp.ok) {
      return errorResult(`web_fetch: HTTP ${resp.status} ${resp.statusText}`);
    }

    const contentType = resp.headers.get("content-type") ?? "";
    const raw = await resp.text();

    let clean: string;
    if (contentType.includes("application/json")) {
      clean = raw;
    } else if (contentType.includes("text/plain")) {
      clean = raw;
    } else {
      clean = stripHtml(raw);
    }

    if (clean.length > maxChars) {
      clean = `${clean.slice(0, maxChars)}\n\n…(truncated, ${clean.length - maxChars} more chars)`;
    }

    if (!clean.trim()) {
      return errorResult("web_fetch: empty response after processing");
    }

    return {
      content: [text(`URL: ${url}\nStatus: ${resp.status}\n\n${clean}`)],
      details: { url, status: resp.status, chars: clean.length },
    };
  } catch (exc) {
    if (controller.signal.aborted) {
      return errorResult(`web_fetch: timed out after ${TIMEOUT_MS}ms`);
    }
    return errorResult(`web_fetch: ${String(exc)}`);
  } finally {
    clearTimeout(timer);
  }
}

export function webFetchTool(): AgentTool {
  return {
    name: "web_fetch",
    description:
      "Fetch a URL and return clean text content. Strips HTML to readable text. " +
      "Works for documentation pages, GitHub, Stack Overflow, npm, PyPI, MDN, etc. " +
      "Max 5000 chars by default.",
    parameters,
    execute,
  };
}
