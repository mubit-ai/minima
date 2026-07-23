/**
 * QueueList (MUB-183 round 2) — the visual prompt queue, stacked directly above the
 * prompt box while items wait: one dim ›-prefixed row per queued prompt, newest last,
 * capped at the LAST 3 items under a "…+N more" header, with the held state announced
 * on the bottom row. Renders nothing when the queue is empty.
 *
 * Every row is single-height by construction (newlines collapse, wrap="truncate") so
 * queueListRowCount is exact — the anchor ledger books it in contentRows/streamReserved/
 * treeMaxRows, and an unbooked or wrapped row would top-clip the composer.
 */

import { Box, Text } from "ink";
import React from "react";
import type { PromptQueue } from "./prompt_queue.ts";

const MAX_ITEM_ROWS = 3;

export function queueListRowCount(q: PromptQueue): number {
  const n = q.items.length;
  if (n === 0) return 0;
  return Math.min(n, MAX_ITEM_ROWS) + (n > MAX_ITEM_ROWS ? 1 : 0);
}

export function queueListLines(q: PromptQueue): string[] {
  const n = q.items.length;
  if (n === 0) return [];
  const lines: string[] = [];
  if (n > MAX_ITEM_ROWS) lines.push(`  …+${n - MAX_ITEM_ROWS} more`);
  const shown = q.items.slice(-MAX_ITEM_ROWS);
  shown.forEach((item, i) => {
    const flat = item.replace(/\s+/g, " ").trim();
    const suffix = q.held && i === shown.length - 1 ? " (held — esc clears)" : "";
    lines.push(`› ${flat}${suffix}`);
  });
  return lines;
}

export function QueueList({ queue }: { queue: PromptQueue }) {
  const lines = queueListLines(queue);
  if (lines.length === 0) return null;
  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      {lines.map((line, i) => (
        <Text key={`${i}-${line}`} dimColor wrap="truncate">
          {line}
        </Text>
      ))}
    </Box>
  );
}
