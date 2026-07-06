/**
 * Built-in tools and the registry that assembles the default toolset.
 *
 * Port of the Python harness's tools/builtin.py. Each tool is an AgentTool factory; the
 * default set (read/write/edit/bash/ls) is what the agent runs with unless the caller
 * opts into more or excludes some.
 */

import type { AgentTool } from "../agent/tools.ts";
import { applyPatchTool } from "./apply_patch.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";
import { readTool } from "./read.ts";
import { todowriteTool } from "./todowrite.ts";
import { webFetchTool } from "./web_fetch.ts";
import { webSearchTool } from "./web_search.ts";
import { writeTool } from "./write.ts";

export { readTool } from "./read.ts";
export { writeTool } from "./write.ts";
export { editTool } from "./edit.ts";
export { applyPatchTool } from "./apply_patch.ts";
export { bashTool } from "./bash.ts";
export { lsTool } from "./ls.ts";
export { globTool } from "./glob.ts";
export { grepTool } from "./grep.ts";
export { todowriteTool } from "./todowrite.ts";
export { webFetchTool } from "./web_fetch.ts";
export { webSearchTool } from "./web_search.ts";

export interface BuiltinToolsOptions {
  exclude?: string[];
  /**
   * Base directory for every filesystem tool in this set (per-sub-agent isolation):
   * relative paths resolve against it, escapes are rejected. Omit for ambient-cwd
   * behavior (the historical default for the lead agent).
   */
  workdir?: string;
}

/** The default coding-agent toolset, minus any excluded by name. */
export function builtinTools(opts: BuiltinToolsOptions = {}): AgentTool[] {
  const fs = { workdir: opts.workdir };
  const all: AgentTool[] = [
    readTool(fs),
    writeTool(fs),
    editTool(fs),
    applyPatchTool(fs),
    bashTool(fs),
    lsTool(fs),
    globTool(fs),
    grepTool(fs),
    todowriteTool(),
  ];
  // The Exa-backed web tools fail on every call without EXA_API_KEY, so a keyless
  // session doesn't offer them at all. Checked at call time (not module load) so
  // keys hydrated from the config store count; a key set mid-session via /config
  // takes effect on the next start.
  if (process.env.EXA_API_KEY) {
    all.push(webSearchTool(), webFetchTool());
  }
  const exclude = new Set(opts.exclude ?? []);
  return all.filter((t) => !exclude.has(t.name));
}
