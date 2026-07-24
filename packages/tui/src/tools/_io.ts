/**
 * Shared filesystem IO helpers — port of the Python harness's tools/_io.py.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const MAX_LINE = 2000;

export function expand(path: string): string {
  return path.startsWith("~") ? path.replace(/^~/, homedir()) : path;
}

/**
 * Resolve `path` against an optional `workdir` base and confine it there.
 *
 * Without a base this is just expand() (current behavior — relative paths resolve against
 * the ambient process.cwd()). With a base, relative paths resolve against IT, and any
 * resolved target escaping the base (`..`, absolute paths outside it) is rejected — the
 * isolation contract that lets parallel sub-agents share one process without clobbering
 * each other. This is a convenience boundary, not a sandbox (symlinks/bash can still
 * escape); the permission layer stays the real gate.
 */
export function resolveWithin(
  path: string,
  base?: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const expanded = expand(path);
  if (!base) return { ok: true, path: expanded };
  const absBase = resolve(expand(base));
  const abs = isAbsolute(expanded) ? expanded : resolve(absBase, expanded);
  const rel = relative(absBase, abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return { ok: true, path: abs };
  return { ok: false, error: `path escapes workdir (${absBase}): ${path}` };
}

export function truncateLine(line: string): string {
  if (line.length <= MAX_LINE) return line;
  return `${line.slice(0, MAX_LINE)} …(truncated)`;
}

const READ_SCAN_LIMIT = 100 * 1024 * 1024;
const READ_BODY_CAP = 200_000;

/** Return { numberedBody, nSelected, eof } for lines [offset, offset+limit). 1-based offset.
 * `hasher` sees every raw chunk pre-decode (the whole file streams regardless of the
 * window); `eof` is false only when the 100MB scan stop truncated the stream. */
export async function readLines(
  path: string,
  opts: { offset: number; limit: number; hasher?: (chunk: Uint8Array) => void },
): Promise<{ body: string; n: number; eof: boolean }> {
  const start = Math.max(0, opts.offset - 1);
  const limit = Math.max(0, opts.limit);
  const selected: string[] = [];
  let lineIndex = 0;
  let current = "";
  let currentLen = 0;
  let extra = 0;
  let tailContent = false;
  let scanned = 0;
  let stopped = false;

  const complete = () => {
    // A terminator \r survives capped accumulation only when nothing was discarded.
    const line =
      current.length === currentLen && current.endsWith("\r") ? current.slice(0, -1) : current;
    selected.push(line);
    lineIndex += 1;
    current = "";
    currentLen = 0;
  };

  const consume = (s: string) => {
    let i = 0;
    while (i < s.length) {
      const nl = s.indexOf("\n", i);
      if (lineIndex >= start && selected.length >= limit) {
        // Window complete: count remaining lines for the trailer, no accumulation.
        if (nl === -1) {
          tailContent = true;
          return;
        }
        extra += 1;
        tailContent = false;
        i = nl + 1;
        continue;
      }
      const seg = nl === -1 ? s.slice(i) : s.slice(i, nl);
      if (lineIndex >= start && seg) {
        currentLen += seg.length;
        if (current.length <= MAX_LINE) current += seg.slice(0, MAX_LINE + 1 - current.length);
      }
      if (nl === -1) return;
      if (lineIndex >= start) complete();
      else lineIndex += 1;
      i = nl + 1;
    }
  };

  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      scanned += value.byteLength;
      opts.hasher?.(value);
      consume(decoder.decode(value, { stream: true }));
      if (scanned > READ_SCAN_LIMIT) {
        stopped = true;
        break;
      }
    }
    if (!stopped) {
      const tail = decoder.decode();
      if (tail) consume(tail);
      if (currentLen > 0 && lineIndex >= start && selected.length < limit) complete();
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const more = stopped ? 0 : extra + (tailContent ? 1 : 0);
  const end = start + selected.length;
  const width = String(end || 1).length;
  const numbered = selected.map(
    (line, i) => `${String(start + i + 1).padStart(width)}: ${truncateLine(line)}`,
  );
  let joinedLen = 0;
  let cut = numbered.length;
  for (const [i, line] of numbered.entries()) {
    const add = line.length + (i > 0 ? 1 : 0);
    if (joinedLen + add > READ_BODY_CAP) {
      cut = i;
      break;
    }
    joinedLen += add;
  }
  const capped = cut < numbered.length;
  if (capped) numbered.length = cut;
  let body = numbered.join("\n");
  if (capped) body += `\n…(output capped at ${READ_BODY_CAP} chars; use offset/limit)`;
  // A completed window on a >100MB file is a success, not a failure — the "too large"
  // trailer is reserved for windows the scan ceiling actually cut short.
  if (stopped && selected.length >= limit)
    body += "\n…(more lines follow; use a larger offset to continue)";
  else if (stopped) body += "\n…(stopped after 100MB scanned; file too large for this offset)";
  else if (!capped && more > 0) body += `\n…(${more} more lines; use a larger offset to continue)`;
  return { body, n: numbered.length, eof: !stopped };
}

export async function writeText(path: string, content: string): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return content.split(/\r?\n/).length;
}
