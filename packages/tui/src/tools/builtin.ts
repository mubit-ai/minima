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
import { type TodoTask, todowriteTool } from "./todowrite.ts";
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
  /**
   * Ground-truth mode (MINIMA_TUI_GROUND_TRUTH=1): todowrite advertises + enforces per-task
   * `verify` commands and runs sequentially. Leave unset for the plain task list — sub-agents
   * always get the plain tool because the ground-truth hooks only exist on the lead agent.
   */
  groundTruth?: boolean;
  /**
   * Observable todo list (D3a task panel): todowrite mutates this array in place. The LEAD
   * agent's main.ts passes one and hands the same array to the TUI; sub-agents (spawn.ts)
   * never pass it, so their todos can't leak into the lead panel.
   */
  todoState?: TodoTask[];
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
    todowriteTool(opts.todoState ?? [], { groundTruth: opts.groundTruth === true }),
    webSearchTool(),
    webFetchTool(),
  ];
  const exclude = new Set(opts.exclude ?? []);
  return all.filter((t) => !exclude.has(t.name));
}
