/**
 * Built-in tools and the registry that assembles the default toolset.
 *
 * Port of minima_harness/tools/builtin.py. Each tool is an AgentTool factory; the
 * default set (read/write/edit/bash/ls) is what the agent runs with unless the caller
 * opts into more or excludes some.
 */

import type { AgentTool } from "../agent/tools.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";
import { readTool } from "./read.ts";
import { todowriteTool } from "./todowrite.ts";
import { webFetchTool } from "./web_fetch.ts";
import { writeTool } from "./write.ts";

export { readTool } from "./read.ts";
export { writeTool } from "./write.ts";
export { editTool } from "./edit.ts";
export { bashTool } from "./bash.ts";
export { lsTool } from "./ls.ts";
export { globTool } from "./glob.ts";
export { grepTool } from "./grep.ts";
export { todowriteTool } from "./todowrite.ts";
export { webFetchTool } from "./web_fetch.ts";

export interface BuiltinToolsOptions {
  exclude?: string[];
}

/** The default coding-agent toolset, minus any excluded by name. */
export function builtinTools(opts: BuiltinToolsOptions = {}): AgentTool[] {
  const all: AgentTool[] = [
    readTool(),
    writeTool(),
    editTool(),
    bashTool(),
    lsTool(),
    globTool(),
    grepTool(),
    todowriteTool(),
    webFetchTool(),
  ];
  const exclude = new Set(opts.exclude ?? []);
  return all.filter((t) => !exclude.has(t.name));
}
