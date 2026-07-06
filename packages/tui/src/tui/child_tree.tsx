/**
 * ChildTree — live sub-agent tree panel.
 *
 * Shown via `/tree` toggle while a multi-step task is in flight. Each row is one
 * child agent: step ID, current status, and accumulated spend. Collapses cleanly
 * when no children are active.
 */

import { Box, Text } from "ink";
import React from "react";

export interface ChildRow {
  stepId: string;
  depth: number;
  status: "running" | "done" | "aborted" | "failure";
  costUsd: number;
}

export interface ChildTreeProps {
  nodes: Map<string, ChildRow>;
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

export function ChildTree({ nodes }: ChildTreeProps) {
  if (nodes.size === 0) return null;

  const rows = [...nodes.values()].sort((a, b) => a.stepId.localeCompare(b.stepId));

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
        return (
          <Box key={row.stepId}>
            <Text color="gray">{indent}▸ </Text>
            <Text color={color}>{glyph} </Text>
            <Text>{row.stepId.slice(0, 24).padEnd(24)}</Text>
            <Text color="gray"> ${row.costUsd.toFixed(4)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
