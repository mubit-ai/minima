/**
 * ls tool — port of minima_harness/tools/ls.py.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { expand } from "./_io.ts";
import { objectSchema } from "./schema.ts";

const parameters = objectSchema(
  { path: { type: "string", description: "Directory to list.", default: "." } },
  [],
);

async function execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
  const root = expand((params.path as string) ?? ".");
  if (!existsSync(root)) return errorResult(`ls: no such path: ${root}`);
  const entries = readdirSync(root)
    .map((name) => ({ name, isDir: statSync(`${root}/${name}`).isDirectory() }))
    // Directories first, then case-insensitive by name — matches the Python sort key.
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  if (!entries.length) return { content: [text("(empty)")] };
  const lines = entries.map((e) => (e.isDir ? `${e.name}/` : e.name));
  return { content: [text(lines.join("\n"))], details: { count: lines.length } };
}

export function lsTool(): AgentTool {
  return {
    name: "ls",
    description:
      "List entries in a directory. Includes hidden files. Directories suffixed with /, sorted first. Use glob for pattern matching.",
    parameters,
    execute,
  };
}
