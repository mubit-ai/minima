/**
 * ls tool — port of the Python harness's tools/ls.py.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { resolveWithin } from "./_io.ts";
import { objectSchema } from "./schema.ts";
import type { FsToolOptions } from "./types.ts";

const parameters = objectSchema(
  { path: { type: "string", description: "Directory to list.", default: "." } },
  [],
);

async function executeWithin(
  workdir: string | undefined,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const r = resolveWithin((params.path as string) ?? ".", workdir);
  if (!r.ok) return errorResult(`ls: ${r.error}`);
  const root = r.path;
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

export function lsTool(opts: FsToolOptions = {}): AgentTool {
  return {
    name: "ls",
    description:
      "List entries in a directory. Includes hidden files. Directories suffixed with /, sorted first. Use glob for pattern matching.",
    parameters,
    execute: (_id, params) => executeWithin(opts.workdir, params),
  };
}
