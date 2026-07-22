/**
 * apply_patch — atomic multi-file, multi-hunk edits in one tool call.
 * Port of minima_harness/tools/apply_patch.py.
 *
 * A single `edit` does one old→new swap, so a change spanning three files costs
 * three tool calls and can leave a half-applied refactor if a later one fails.
 * `apply_patch` takes one patch describing adds/updates/deletes/moves across many
 * files, resolves every hunk in memory first, and only touches disk if ALL of them
 * resolve — all-or-nothing.
 *
 * Grammar (Codex/OpenCode format):
 *
 *   *** Begin Patch
 *   *** Add File: path/new.ts
 *   +line one
 *   *** Update File: path/existing.ts
 *   *** Move to: path/renamed.ts        (optional)
 *   @@ optional anchor
 *    context line kept as-is
 *   -removed line
 *   +added line
 *   *** Delete File: path/old.ts
 *   *** End Patch
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { resolveWithin } from "./_io.ts";
import { objectSchema } from "./schema.ts";
import type { FsToolOptions } from "./types.ts";

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const UPDATE = "*** Update File: ";
const DELETE = "*** Delete File: ";
const MOVE = "*** Move to: ";
const EOF = "*** End of File";

/** A patch is malformed or cannot be applied cleanly to the current files. */
export class PatchError extends Error {}

interface Hunk {
  before: string[]; // context + removed lines (prefix stripped), in file order
  after: string[]; // context + added lines (prefix stripped), in file order
  anchor: string | null; // optional @@ heading to seek before matching
}

interface FileChange {
  kind: "add" | "update" | "delete";
  path: string;
  moveTo?: string | null;
  newContent?: string | null; // for "add"
  hunks: Hunk[]; // for "update"
}

export interface PatchPlan {
  writes: Map<string, string>; // path -> full new content
  deletes: string[]; // paths to remove
  summary: string[]; // one human-readable line per change
}

/** relative-or-absolute path -> file text, or null if it doesn't exist. */
type ReadFile = (path: string) => string | null;

// --------------------------------------------------------------------------- parse

export function parsePatch(patch: string): FileChange[] {
  const lines = patch.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  if (i >= lines.length || lines[i]!.trim() !== BEGIN) {
    throw new PatchError("patch must start with '*** Begin Patch'");
  }
  i++;
  const changes: FileChange[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    const s = line.trim();
    if (s === END) return changes;
    if (s === EOF || !s) {
      i++;
      continue;
    }
    if (line.startsWith(ADD)) {
      const path = line.slice(ADD.length).trim();
      const [content, next] = parseAddedLines(lines, i + 1);
      changes.push({ kind: "add", path, newContent: content, hunks: [] });
      i = next;
      continue;
    }
    if (line.startsWith(DELETE)) {
      changes.push({ kind: "delete", path: line.slice(DELETE.length).trim(), hunks: [] });
      i++;
      continue;
    }
    if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length).trim();
      i++;
      let moveTo: string | null = null;
      if (i < lines.length && lines[i]!.startsWith(MOVE)) {
        moveTo = lines[i]!.slice(MOVE.length).trim();
        i++;
      }
      const [hunks, next] = parseHunks(lines, i);
      if (!hunks.length) throw new PatchError(`Update File: ${path}: no hunks`);
      changes.push({ kind: "update", path, moveTo, hunks });
      i = next;
      continue;
    }
    throw new PatchError(`unexpected line in patch: ${JSON.stringify(line)}`);
  }
  throw new PatchError("patch missing '*** End Patch'");
}

function parseAddedLines(lines: string[], start: number): [string, number] {
  const out: string[] = [];
  let i = start;
  while (i < lines.length && !lines[i]!.startsWith("*** ")) {
    const cl = lines[i]!;
    if (cl.startsWith("+")) out.push(cl.slice(1));
    else if (!cl.trim()) out.push("");
    else throw new PatchError(`Add File lines must start with '+': ${JSON.stringify(cl)}`);
    i++;
  }
  return [out.join("\n"), i];
}

function parseHunks(lines: string[], start: number): [Hunk[], number] {
  const hunks: Hunk[] = [];
  let i = start;
  let before: string[] = [];
  let after: string[] = [];
  let anchor: string | null = null;

  const flush = () => {
    if (before.length || after.length) hunks.push({ before, after, anchor });
    before = [];
    after = [];
    anchor = null;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("*** ")) break;
    if (line.startsWith("@@")) {
      flush();
      anchor = line.slice(2).trim() || null;
      i++;
      continue;
    }
    if (line.startsWith("+")) {
      after.push(line.slice(1));
    } else if (line.startsWith("-")) {
      before.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      before.push(line.slice(1));
      after.push(line.slice(1));
    } else if (line === "") {
      before.push("");
      after.push("");
    } else {
      throw new PatchError(`hunk line must start with ' ', '+', or '-': ${JSON.stringify(line)}`);
    }
    i++;
  }
  flush();
  return [hunks, i];
}

// --------------------------------------------------------------------------- plan

export function planPatch(changes: FileChange[], readFile: ReadFile): PatchPlan {
  const writes = new Map<string, string>();
  const deletes: string[] = [];
  const summary: string[] = [];
  for (const ch of changes) {
    if (ch.kind === "add") {
      if (readFile(ch.path) !== null) throw new PatchError(`Add File: ${ch.path} already exists`);
      let content = ch.newContent ?? "";
      if (content && !content.endsWith("\n")) content += "\n";
      writes.set(ch.path, content);
      summary.push(`add    ${ch.path}`);
    } else if (ch.kind === "delete") {
      if (readFile(ch.path) === null)
        throw new PatchError(`Delete File: ${ch.path} does not exist`);
      deletes.push(ch.path);
      summary.push(`delete ${ch.path}`);
    } else {
      const original = readFile(ch.path);
      if (original === null) throw new PatchError(`Update File: ${ch.path} does not exist`);
      const newText = applyHunks(original, ch.hunks, ch.path);
      const dest = ch.moveTo || ch.path;
      if (ch.moveTo) {
        deletes.push(ch.path);
        summary.push(`move   ${ch.path} -> ${ch.moveTo}`);
      } else {
        summary.push(`update ${ch.path}`);
      }
      writes.set(dest, newText);
    }
  }
  return { writes, deletes, summary };
}

function applyHunks(original: string, hunks: Hunk[], path: string): string {
  const hadFinalNl = original.endsWith("\n");
  const out = original.split("\n");
  // A trailing newline produces a spurious empty final element; drop it so line
  // indices match the file's real lines (re-added below if present).
  if (hadFinalNl && out.length && out[out.length - 1] === "") out.pop();
  let cursor = 0;
  for (const h of hunks) {
    let start = cursor;
    if (h.anchor) {
      const a = findAnchor(out, h.anchor, cursor);
      if (a >= 0) start = a;
    }
    let idx = find(out, h.before, start);
    if (idx < 0 && start > 0) idx = find(out, h.before, 0); // context may sit before the cursor
    if (idx < 0) {
      const ctx = h.before.slice(0, 6).join("\n") || "(no context lines)";
      throw new PatchError(`Update File: ${path}: could not locate hunk context:\n${ctx}`);
    }
    out.splice(idx, h.before.length, ...h.after);
    cursor = idx + h.after.length;
  }
  let out_text = out.join("\n");
  if (hadFinalNl && !out_text.endsWith("\n")) out_text += "\n";
  return out_text;
}

/**
 * First index >= start where needle matches, trying progressively looser
 * whitespace normalization. Empty needle matches at start (pure insertion).
 */
function find(hay: string[], needle: string[], start: number): number {
  if (!needle.length) return start;
  const span = needle.length;
  const last = hay.length - span;
  const norms: ((x: string) => string)[] = [
    (x) => x,
    (x) => x.replace(/\s+$/, ""),
    (x) => x.trim(),
  ];
  for (const norm of norms) {
    const target = needle.map(norm);
    for (let i = Math.max(start, 0); i <= last; i++) {
      let ok = true;
      for (let j = 0; j < span; j++) {
        if (norm(hay[i + j]!) !== target[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
  }
  return -1;
}

function findAnchor(hay: string[], anchor: string, start: number): number {
  const target = anchor.trim();
  for (let i = Math.max(start, 0); i < hay.length; i++) {
    if (hay[i]!.trim() === target) return i;
  }
  return -1;
}

// --------------------------------------------------------------------------- apply

function makeResolver(workdir?: string): (rel: string) => string {
  return (rel: string) => {
    const r = resolveWithin(rel, workdir);
    if (!r.ok) throw new PatchError(r.error);
    return r.path;
  };
}

/**
 * Pre-read every file the parsed changes reference so planPatch can stay sync.
 * Mirrors the old disk reader exactly: unreadable or missing files map to null
 * (an Add File target need not exist), and a path-resolution failure is stored
 * and re-thrown only when planPatch actually reads that path.
 */
async function preloadFiles(
  changes: FileChange[],
  resolve: (rel: string) => string,
): Promise<Map<string, string | null | PatchError>> {
  const files = new Map<string, string | null | PatchError>();
  for (const ch of changes) {
    if (files.has(ch.path)) continue;
    let abs: string;
    try {
      abs = resolve(ch.path);
    } catch (exc) {
      if (exc instanceof PatchError) {
        files.set(ch.path, exc);
        continue;
      }
      throw exc;
    }
    try {
      files.set(ch.path, await readFile(abs, "utf8"));
    } catch {
      files.set(ch.path, null);
    }
  }
  return files;
}

function mapReader(files: Map<string, string | null | PatchError>): ReadFile {
  return (rel: string) => {
    const cached = files.get(rel);
    if (cached instanceof PatchError) throw cached;
    return cached ?? null;
  };
}

/** Flush a resolved plan to disk: writes (with mkdir) first, then deletes. */
export async function writePlan(plan: PatchPlan, resolve: (rel: string) => string): Promise<void> {
  for (const [rel, content] of plan.writes) {
    const abs = resolve(rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  for (const rel of plan.deletes) {
    if (plan.writes.has(rel)) continue; // a moved-to-itself or re-created path; keep it
    await rm(resolve(rel), { force: true });
  }
}

const parameters = objectSchema({ patch: { type: "string", description: "The patch text." } }, [
  "patch",
]);

export function applyPatchTool(opts: FsToolOptions = {}): AgentTool {
  return {
    name: "apply_patch",
    description:
      "Apply a multi-file patch atomically in one call — add, update, delete, or move " +
      "files together. Prefer this over multiple `edit` calls for any change touching " +
      "more than one file or more than one region. Every hunk is resolved before " +
      "anything is written; if any hunk fails to match, NO file is changed.\n\n" +
      "Format:\n" +
      "*** Begin Patch\n" +
      "*** Add File: path/new.ts\n" +
      "+full contents, each line prefixed with +\n" +
      "*** Update File: path/existing.ts\n" +
      "*** Move to: path/renamed.ts   (optional; omit to edit in place)\n" +
      "@@ optional anchor line for large files\n" +
      " unchanged context line (leading space)\n" +
      "-removed line\n" +
      "+added line\n" +
      "*** Delete File: path/old.ts\n" +
      "*** End Patch\n\n" +
      "Include a few unchanged context lines (leading space) around each change so the " +
      "hunk can be located. Paths are relative to the working directory.",
    parameters,
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const resolve = makeResolver(opts.workdir);
      let plan: PatchPlan;
      let changeCount: number;
      try {
        const changes = parsePatch(String(params.patch));
        if (!changes.length) return errorResult("apply_patch: empty patch (no file sections)");
        changeCount = changes.length;
        const files = await preloadFiles(changes, resolve);
        plan = planPatch(changes, mapReader(files));
      } catch (exc) {
        if (exc instanceof PatchError) return errorResult(`apply_patch: ${exc.message}`);
        throw exc;
      }
      await writePlan(plan, resolve);
      const summary = plan.summary.join("\n");
      return {
        content: [text(`applied patch (${changeCount} change(s)):\n${summary}`)],
        details: { writes: [...plan.writes.keys()], deletes: plan.deletes },
      };
    },
  };
}
