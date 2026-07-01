/**
 * edit tool — port of minima_harness/tools/edit.py.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { expand } from "./_io.ts";
import { objectSchema } from "./schema.ts";

const parameters = objectSchema(
  {
    path: { type: "string", description: "Absolute or relative file path." },
    old_string: { type: "string", description: "The exact string to replace." },
    new_string: { type: "string", description: "The replacement string." },
    replace_all: { type: "boolean", description: "Replace every occurrence.", default: false },
  },
  ["path", "old_string", "new_string"],
);

async function execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
  const p = expand(String(params.path));
  if (!existsSync(p)) return errorResult(`edit: no such file: ${p}`);
  const body = await readFile(p, "utf8");
  const oldStr = String(params.old_string);
  const newStr = String(params.new_string);
  const replaceAll = Boolean(params.replace_all);

  const count = body.split(oldStr).length - 1;
  if (count === 0) return errorResult(`edit: old_string not found in ${p}`);
  if (count > 1 && !replaceAll) {
    return errorResult(
      `edit: old_string matches ${count} times in ${p}; add more surrounding context or set replace_all=true`,
    );
  }
  const updated = replaceAll ? body.split(oldStr).join(newStr) : body.replace(oldStr, newStr);
  await writeFile(p, updated, "utf8");
  const replaced = replaceAll ? count : 1;
  return {
    content: [text(`edited ${p}: ${replaced} replacement(s)`)],
    details: { replacements: replaced },
  };
}

export function editTool(): AgentTool {
  return {
    name: "edit",
    description:
      "Replace an exact string in a file. Read the file first to get exact strings. " +
      "Errors if old_string is absent or (without replace_all) appears more than once — add context to disambiguate.",
    parameters,
    execute,
  };
}
