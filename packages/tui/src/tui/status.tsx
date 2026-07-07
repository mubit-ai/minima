/**
 * Status bar — the bottom line: current model, turn count, and any offline/reroute note.
 * Port of minima_harness/tui/widgets/footer.py.
 */

import { Box, Text } from "ink";
import React from "react";

export interface StatusBarProps {
  model: string;
  basis: string;
  routeMode: "auto" | "confirm";
  thinkingLevel: string;
  ctxPct: number;
  inputTokens: number;
  outputTokens: number;
  actualCostUsd?: number;
  sessionId: string;
  routingOffline: boolean;
  offlineReason?: string | null;
  statusText: "ready" | "thinking" | "working";
  planMode?: boolean;
  readDirs?: string[];
  alwaysTools?: string[];
  /** "spent/limit (mode)" budget note; null hides the segment. */
  budget?: { spentUsd: number; limitUsd: number; fraction: number; mode: string } | null;
}

export function StatusBar({
  model,
  basis,
  routeMode,
  thinkingLevel,
  ctxPct,
  inputTokens,
  outputTokens,
  actualCostUsd = 0,
  sessionId,
  routingOffline,
  offlineReason,
  statusText,
  planMode,
  readDirs,
  alwaysTools,
  budget,
}: StatusBarProps) {
  const budgetColor = budget
    ? budget.fraction >= 0.9
      ? "red"
      : budget.fraction >= 0.75
        ? "yellow"
        : "green"
    : "gray";
  const modelStyle = basis === "offline" ? "yellow" : "cyan";
  const routeStyle = routeMode === "confirm" ? "yellow" : "gray";
  const thinkStyle =
    thinkingLevel === "high" ? "yellow" : thinkingLevel === "off" ? "gray" : "cyan";
  const ctxStyle = ctxPct > 80 ? "red" : "gray";
  const statusColor = statusText === "ready" ? "green" : "yellow";
  const dirCount = readDirs?.length ?? 0;

  // Each row is a SINGLE `<Text wrap="truncate-end">` with nested colour spans. Ink wraps every
  // child <Text> independently, so a row built from sibling <Text> boxes garbles into interleaved
  // lines once the content outgrows the terminal width. Nesting under one wrap-controlled parent
  // keeps the row on one line and truncates cleanly at the right edge instead. Segments are ordered
  // most-important-first so the low-value tail (session id) is what gets dropped when narrow.
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text wrap="truncate-end">
        {planMode && (
          <Text color="yellow" bold>
            [PLAN]{" "}
          </Text>
        )}
        <Text color={statusColor}>● </Text>
        <Text color={modelStyle}>
          {model} ▸ {basis}
        </Text>
        {routingOffline && (
          <Text color="red"> [offline: {(offlineReason ?? "unreachable").slice(0, 40)}]</Text>
        )}
        <Text color="gray"> · </Text>
        <Text color={routeStyle}>{routeMode}</Text>
        <Text color="gray"> · think:</Text>
        <Text color={thinkStyle}>{thinkingLevel}</Text>
        <Text color="gray"> │ ctx </Text>
        <Text color={ctxStyle}>{ctxPct.toFixed(0)}%</Text>
        <Text color="gray">
          {" "}
          · ↑{inputTokens} ↓{outputTokens} ·{" "}
        </Text>
        <Text color="yellow">${actualCostUsd.toFixed(4)}</Text>
        {budget && (
          <>
            <Text color="gray"> / </Text>
            <Text color={budgetColor}>
              ${budget.limitUsd.toFixed(2)} ({Math.round(budget.fraction * 100)}%
              {budget.mode === "enforce" ? "⛔" : ""})
            </Text>
          </>
        )}
        <Text color="gray"> · sess {sessionId.slice(0, 12)}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color="gray">perms: </Text>
        <Text color="green">{`r-x ${dirCount} dir${dirCount === 1 ? "" : "s"}`}</Text>
        {alwaysTools && alwaysTools.length > 0 ? (
          <Text color="yellow"> {`· --x ${alwaysTools.join(", ")}`}</Text>
        ) : (
          <Text color="gray"> · w/e/b: ask</Text>
        )}
        {planMode && <Text color="magenta"> · PLAN (ro)</Text>}
      </Text>
    </Box>
  );
}
