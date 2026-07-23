/**
 * edit tool — port of the Python harness's tools/edit.py.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { resolveWithin } from "./_io.ts";
import {
  coalesce,
  countNewlines,
  intersects,
  occurrenceSpans,
  sha256Hex,
  staleMessage,
  unseenMessage,
} from "./_seen.ts";
import { objectSchema } from "./schema.ts";
import type { FsToolOptions } from "./types.ts";

const parameters = objectSchema(
  {
    path: { type: "string", description: "Absolute or relative file path." },
    old_string: { type: "string", description: "The exact string to replace." },
    new_string: { type: "string", description: "The replacement string." },
    replace_all: { type: "boolean", description: "Replace every occurrence.", default: false },
  },
  ["path", "old_string", "new_string"],
);

export function editTool(opts: FsToolOptions = {}): AgentTool {
  return {
    name: "edit",
    description:
      "Replace an exact string in a file. Read the file first to get exact strings. " +
      "Errors if old_string is absent or (without replace_all) appears more than once — add context to disambiguate.",
    parameters,
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const r = resolveWithin(String(params.path), opts.workdir);
      if (!r.ok) return errorResult(`edit: ${r.error}`);
      const p = r.path;
      if (!existsSync(p)) return errorResult(`edit: no such file: ${p}`);
      const raw = await readFile(p);
      const body = raw.toString("utf8");
      const oldStr = String(params.old_string);
      const newStr = String(params.new_string);
      const replaceAll = Boolean(params.replace_all);

      // Guard state: rows === null means fail-open (ledger off/unattached/errored) —
      // every check below is skipped and behavior is byte-identical to the unguarded tool.
      const seen = opts.seen;
      const rows = seen?.enabled ? seen.rows(p) : null;
      const hashNow = rows ? sha256Hex(raw) : null;
      if (rows && hashNow && rows.length > 0 && rows[0]!.file_hash !== hashNow) {
        const ranges = coalesce(rows.map((s) => ({ start: s.start_line, end: s.end_line })));
        const { message, reread } = staleMessage(p, rows[0]!.file_hash, hashNow, ranges);
        return {
          content: [text(message)],
          details: { error: true, edit_guard: "stale", reread },
        };
      }

      const count = body.split(oldStr).length - 1;
      if (count === 0) return errorResult(`edit: old_string not found in ${p}`);
      if (count > 1 && !replaceAll) {
        return errorResult(
          `edit: old_string matches ${count} times in ${p}; add more surrounding context or set replace_all=true`,
        );
      }

      const spans = rows && hashNow ? occurrenceSpans(body, oldStr, replaceAll) : [];
      if (rows && hashNow) {
        const covered = rows
          .filter((s) => s.file_hash === hashNow)
          .map((s) => ({ start: s.start_line, end: s.end_line }));
        const unseen = spans.filter((sp) => !covered.some((c) => intersects(sp, c)));
        if (unseen.length > 0) {
          const { message, reread } = unseenMessage(p, coalesce(unseen));
          return {
            content: [text(message)],
            details: { error: true, edit_guard: "unseen", reread },
          };
        }
      }

      const updated = replaceAll ? body.split(oldStr).join(newStr) : body.replace(oldStr, newStr);
      await writeFile(p, updated, "utf8");
      if (seen && rows && hashNow) {
        seen.applyEdit(p, {
          spans,
          lineDelta: countNewlines(newStr) - countNewlines(oldStr),
          newHash: sha256Hex(updated),
        });
      }
      const replaced = replaceAll ? count : 1;
      return {
        content: [text(`edited ${p}: ${replaced} replacement(s)`)],
        details: { replacements: replaced },
      };
    },
  };
}
