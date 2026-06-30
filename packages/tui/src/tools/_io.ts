/**
 * Shared filesystem IO helpers — port of minima_harness/tools/_io.py.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

const MAX_LINE = 2000;

export function expand(path: string): string {
  return path.startsWith("~") ? path.replace(/^~/, homedir()) : path;
}

export function truncateLine(line: string): string {
  if (line.length <= MAX_LINE) return line;
  return `${line.slice(0, MAX_LINE)} …(truncated)`;
}

/** Return { numberedBody, nSelected } for lines [offset, offset+limit). 1-based offset. */
export async function readLines(
  path: string,
  opts: { offset: number; limit: number },
): Promise<{ body: string; n: number }> {
  const text = await readFile(path, "utf8");
  const lines = text.split(/\r?\n/);
  // A trailing newline produces a spurious empty final element; drop it.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const start = Math.max(0, opts.offset - 1);
  const end = Math.min(lines.length, start + opts.limit);
  const selected = lines.slice(start, end);
  const width = String(end || 1).length;
  let body = selected
    .map((line, i) => `${String(start + i + 1).padStart(width)}: ${truncateLine(line)}`)
    .join("\n");
  if (end < lines.length)
    body += `\n…(${lines.length - end} more lines; use a larger offset to continue)`;
  return { body, n: selected.length };
}

export async function writeText(path: string, content: string): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return content.split(/\r?\n/).length;
}
