/**
 * read tool — port of minima_harness/tools/read.py.
 */

import { existsSync, statSync } from "node:fs";
import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { expand, readLines } from "./_io.ts";
import { objectSchema } from "./schema.ts";

const parameters = objectSchema(
  {
    path: { type: "string", description: "Absolute or relative file path." },
    offset: { type: "integer", description: "1-based line to start at.", default: 1 },
    limit: { type: "integer", description: "Max lines to return.", default: 2000 },
  },
  ["path"],
);

async function execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
  const p = expand(String(params.path));
  if (!existsSync(p)) return errorResult(`read: no such file: ${p}`);
  if (statSync(p).isDirectory()) return errorResult(`read: is a directory: ${p}`);
  const { body, n } = await readLines(p, {
    offset: params.offset as number,
    limit: params.limit as number,
  });
  return { content: [text(body || "(empty)")], details: { lines_read: n } };
}

export function readTool(): AgentTool {
  return {
    name: "read",
    description:
      "Read a text file from the local filesystem. Returns lines with 1-based line numbers. Use `offset` and `limit` to page through large files.",
    parameters,
    execute,
  };
}
