/**
 * read tool — port of the Python harness's tools/read.py.
 */

import { existsSync, statSync } from "node:fs";
import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { readLines, resolveWithin } from "./_io.ts";
import { objectSchema } from "./schema.ts";
import type { FsToolOptions } from "./types.ts";

const parameters = objectSchema(
  {
    path: { type: "string", description: "Absolute or relative file path." },
    offset: { type: "integer", description: "1-based line to start at.", default: 1 },
    limit: { type: "integer", description: "Max lines to return.", default: 2000 },
  },
  ["path"],
);

export function readTool(opts: FsToolOptions = {}): AgentTool {
  return {
    name: "read",
    description:
      "Read a text file. Returns lines with 1-based line numbers. Always read a file before editing it — never guess contents. Use offset/limit for large files (default limit: 2000 lines).",
    parameters,
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const r = resolveWithin(String(params.path), opts.workdir);
      if (!r.ok) return errorResult(`read: ${r.error}`);
      const p = r.path;
      if (!existsSync(p)) return errorResult(`read: no such file: ${p}`);
      if (statSync(p).isDirectory()) return errorResult(`read: is a directory: ${p}`);
      const { body, n } = await readLines(p, {
        offset: params.offset as number,
        limit: params.limit as number,
      });
      return { content: [text(body || "(empty)")], details: { lines_read: n } };
    },
  };
}
