/**
 * ls tool — port of the Python harness's tools/ls.py.
 */

import { readdir, stat } from "node:fs/promises";
import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { boundDetails, boundText } from "./_bounds.ts";
import { resolveWithin } from "./_io.ts";
import { objectSchema } from "./schema.ts";
import type { FsToolOptions, ToolArtifacts } from "./types.ts";

const parameters = objectSchema(
  { path: { type: "string", description: "Directory to list.", default: "." } },
  [],
);

const MAX_ENTRIES = 500;

async function executeWithin(
  workdir: string | undefined,
  artifacts: ToolArtifacts | undefined,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const r = resolveWithin((params.path as string) ?? ".", workdir);
  if (!r.ok) return errorResult(`ls: ${r.error}`);
  const root = r.path;
  let rootInfo: Awaited<ReturnType<typeof stat>>;
  try {
    rootInfo = await stat(root);
  } catch {
    return errorResult(`ls: no such path: ${root}`);
  }
  if (!rootInfo.isDirectory()) return errorResult(`ls: not a directory: ${root}`);
  const dirents = await readdir(root, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (dirent) => {
      let isDir = dirent.isDirectory();
      if (dirent.isSymbolicLink()) {
        // Resolve the target; a dangling symlink lists as a plain file.
        try {
          isDir = (await stat(`${root}/${dirent.name}`)).isDirectory();
        } catch {
          isDir = false;
        }
      }
      return { name: dirent.name, isDir };
    }),
  );
  // Directories first, then case-insensitive by name — matches the Python sort key.
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  if (!entries.length) return { content: [text("(empty)")] };
  const lines = entries.map((e) => (e.isDir ? `${e.name}/` : e.name));
  const b = boundText(lines.join("\n"), {
    maxLines: MAX_ENTRIES,
    unit: "entries",
    spill: artifacts?.sink("ls") ?? null,
  });
  let body = b.body;
  if (b.notice) body += `\n${b.notice}`;
  return {
    content: [text(body)],
    details: { count: b.totalLines, ...boundDetails(b) },
  };
}

export function lsTool(opts: FsToolOptions = {}): AgentTool {
  return {
    name: "ls",
    description:
      "List entries in a directory. Includes hidden files. Directories suffixed with /, sorted first. Use glob for pattern matching.",
    parameters,
    execute: (_id, params) => executeWithin(opts.workdir, opts.artifacts, params),
  };
}
