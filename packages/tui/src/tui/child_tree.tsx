/**
 * ChildTree — live sub-agent tree panel.
 *
 * Shown via `/tree` toggle while a multi-step task is in flight. Each row is one
 * child agent: step ID, current status, and accumulated spend. Collapses cleanly
 * when no children are active.
 */

import { Box, Text } from "ink";
import React from "react";
import { isAssistant } from "../ai/types.ts";
import type { ChildEvent } from "../minima/spawn.ts";

export interface ChildRow {
  stepId: string;
  depth: number;
  status: "running" | "done" | "aborted" | "failure";
  costUsd: number;
}

/**
 * Reduce one forwarded child AgentEvent into the row's next state (pure — app.tsx wires it).
 * Realized cost accumulates from each assistant message_end (usage.cost.total, attached by
 * the provider); the terminal status comes from stop_reason (aborted/error) and agent_end.
 */
export function applyChildEvent(prev: ChildRow | undefined, e: ChildEvent): ChildRow {
  let status = prev?.status ?? "running";
  let costUsd = prev?.costUsd ?? 0;
  const ev = e.event;
  if (ev.type === "message_end" && ev.message && isAssistant(ev.message)) {
    costUsd += ev.message.usage.cost.total || 0;
    if (ev.message.stop_reason === "aborted") status = "aborted";
    else if (ev.message.stop_reason === "error") status = "failure";
  } else if (ev.type === "agent_end" && status === "running") {
    const last = [...ev.messages].reverse().find(isAssistant);
    status =
      last?.stop_reason === "aborted"
        ? "aborted"
        : last?.stop_reason === "error"
          ? "failure"
          : "done";
  }
  return { stepId: e.stepId, depth: e.depth, status, costUsd };
}

export interface ChildTreeProps {
  nodes: Map<string, ChildRow>;
  /**
   * Cap on rendered child rows; overflow collapses to a "+k more" line. Must match the
   * childTreeHeight() reservation in app.tsx — an uncapped wide DAG would grow the panel
   * past the reserved rows and overflow the fixed-height frame.
   */
  maxRows?: number;
}

const STATUS_COLOR: Record<ChildRow["status"], string> = {
  running: "cyan",
  done: "green",
  aborted: "yellow",
  failure: "red",
};

const STATUS_GLYPH: Record<ChildRow["status"], string> = {
  running: "⟳",
  done: "✓",
  aborted: "↩",
  failure: "✗",
};

export function ChildTree({ nodes, maxRows }: ChildTreeProps) {
  if (nodes.size === 0) return null;

  const all = [...nodes.values()].sort((a, b) => a.stepId.localeCompare(b.stepId));
  const cap = Math.max(1, maxRows ?? all.length);
  const rows = all.slice(0, cap);
  const hidden = all.length - rows.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginBottom={1}
    >
      <Text color="gray" bold>
        sub-agents ({nodes.size})
      </Text>
      {rows.map((row) => {
        const indent = "  ".repeat(row.depth);
        const color = STATUS_COLOR[row.status];
        const glyph = STATUS_GLYPH[row.status];
        // One <Text wrap="truncate"> per row: a fixed-width row (indent + 36 cols)
        // would word-wrap to 2 rows on narrow terminals, breaking childTreeHeight()'s
        // one-row-per-child reservation — truncation makes the math width-independent.
        return (
          <Text key={row.stepId} wrap="truncate">
            <Text color="gray">{indent}▸ </Text>
            <Text color={color}>{glyph} </Text>
            <Text>{row.stepId.slice(0, 24).padEnd(24)}</Text>
            <Text color="gray"> ${row.costUsd.toFixed(4)}</Text>
          </Text>
        );
      })}
      {hidden > 0 && <Text color="gray"> …+{hidden} more</Text>}
    </Box>
  );
}
