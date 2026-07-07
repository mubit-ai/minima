/**
 * The live "current action" indicator (GT-0.5): while the agent is running tools, the footer
 * shows what it is doing right now (`⚙ bash: git diff --stat`). Tools run in PARALLEL, so we
 * track the in-flight set keyed by toolCallId and clear each on its tool_execution_end — a
 * single string would be trampled when N tools start before any finishes.
 *
 * Pure so the TUI reducer is testable without rendering Ink: fold the real agent event stream
 * through `reduceActiveActions`, then `currentActionLine` renders the footer string.
 */

import type { AgentEvent } from "../agent/index.ts";
import { formatActionLabel } from "./permissions.ts";

export interface ActiveAction {
  id: string;
  label: string;
}

/** Fold one agent event into the active-tools list (newest last); non-tool events pass through. */
export function reduceActiveActions(actions: ActiveAction[], ev: AgentEvent): ActiveAction[] {
  if (ev.type === "tool_execution_start") {
    return [...actions, { id: ev.toolCallId, label: formatActionLabel(ev.toolName, ev.args) }];
  }
  if (ev.type === "tool_execution_end") {
    return actions.filter((a) => a.id !== ev.toolCallId);
  }
  return actions;
}

/** The footer line: newest running tool, with a `(+N more)` suffix when several run at once. */
export function currentActionLine(actions: ActiveAction[]): string {
  const last = actions[actions.length - 1];
  if (!last) return "";
  const extra = actions.length - 1;
  return `⚙ ${last.label}${extra > 0 ? `  (+${extra} more)` : ""}`;
}
