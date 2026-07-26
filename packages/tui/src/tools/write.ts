/**
 * write tool — port of the Python harness's tools/write.py.
 */

import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { resolveWithin, writeText } from "./_io.ts";
import { sha256Hex } from "./_seen.ts";
import { objectSchema } from "./schema.ts";
import type { FsToolOptions } from "./types.ts";

const parameters = objectSchema(
  {
    path: { type: "string", description: "Absolute or relative file path." },
    content: { type: "string", description: "The full intended file contents." },
  },
  ["path", "content"],
);

export function writeTool(opts: FsToolOptions = {}): AgentTool {
  return {
    name: "write",
    description:
      "Create or overwrite a file. Overwrites entirely — prefer edit for targeted changes. " +
      "Parent directories are created automatically. Pass the full intended file contents.",
    parameters,
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const r = resolveWithin(String(params.path), opts.workdir);
      if (!r.ok) return errorResult(`write: ${r.error}`);
      const content = String(params.content);
      const n = await writeText(r.path, content);
      if (opts.seen?.enabled) {
        opts.seen.record(r.path, sha256Hex(content), [{ start: 1, end: n }], "write");
      }
      return {
        content: [text(`wrote ${n} lines to ${r.path}`)],
        details: { bytes: content.length },
      };
    },
  };
}
