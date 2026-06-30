/**
 * write tool — port of minima_harness/tools/write.py.
 */

import type { AgentTool, ToolResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { expand, writeText } from "./_io.ts";
import { objectSchema } from "./schema.ts";

const parameters = objectSchema(
  {
    path: { type: "string", description: "Absolute or relative file path." },
    content: { type: "string", description: "The full intended file contents." },
  },
  ["path", "content"],
);

async function execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
  const p = expand(String(params.path));
  const content = String(params.content);
  const n = await writeText(p, content);
  return { content: [text(`wrote ${n} lines to ${p}`)], details: { bytes: content.length } };
}

export function writeTool(): AgentTool {
  return {
    name: "write",
    description:
      "Create or overwrite a file on the local filesystem. Parent directories are created automatically. Pass the full intended file contents.",
    parameters,
    execute,
  };
}
