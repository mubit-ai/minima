/**
 * Status bar — the bottom line: current model, turn count, and any offline/reroute note.
 * Port of the Python harness's tui/widgets/footer.py.
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
  /** Number of sub-agents currently in flight; 0 or undefined hides the badge. */
  activeChildren?: number;
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
  activeChildren,
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

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {planMode && (
          <Text color="yellow" bold>
            {" "}
            [PLAN]{" "}
          </Text>
        )}

        <Text color="gray"> model: </Text>
        <Text color={modelStyle}>
          {model} ▸ {basis}
        </Text>

        <Text color="gray"> · route: </Text>
        <Text color={routeStyle}>{routeMode}</Text>

        <Text color="gray"> · think: </Text>
        <Text color={thinkStyle}>{thinkingLevel}</Text>

        <Text color="gray"> │ ctx </Text>
        <Text color={ctxStyle}>{ctxPct.toFixed(0)}%</Text>

        <Text color="gray">
          {" "}
          · ↑{inputTokens} ↓{outputTokens}
        </Text>

        <Text color="gray"> · </Text>
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

        <Text color="gray"> · </Text>
        <Text color={statusColor}>{statusText}</Text>

        {activeChildren ? (
          <>
            <Text color="gray"> · </Text>
            <Text color="cyan">▸ {activeChildren} active</Text>
          </>
        ) : null}

        {routingOffline && (
          <Text color="red"> [offline: {(offlineReason ?? "unreachable").slice(0, 40)}]</Text>
        )}
      </Box>
      <Box>
        <Text color="gray">perms: </Text>
        <Text color="green">{`r-x ${readDirs?.length ?? 0} dir${(readDirs?.length ?? 0) === 1 ? "" : "s"}`}</Text>
        {alwaysTools && alwaysTools.length > 0 ? (
          <Text color="yellow"> {`· --x ${alwaysTools.join(", ")}`}</Text>
        ) : (
          <Text color="gray"> · w/e/b: ask</Text>
        )}
        {planMode && <Text color="magenta"> · PLAN (ro)</Text>}
      </Box>
    </Box>
  );
}
