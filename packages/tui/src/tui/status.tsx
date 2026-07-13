/**
 * Status bar — the bottom line: current model, turn count, and any offline/reroute note.
 * Port of the Python harness's tui/widgets/footer.py.
 */

import { Box, Text } from "ink";
import React from "react";

import type { FooterBadge } from "./badge_slot.ts";

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
  statusText: "ready" | "reasoning" | "running";
  planMode?: boolean;
  readDirs?: string[];
  alwaysTools?: string[];
  /** "spent/limit (mode)" budget note; null hides the segment. */
  budget?: { spentUsd: number; limitUsd: number; fraction: number; mode: string } | null;
  /** Number of sub-agents currently in flight; 0 or undefined hides the badge. */
  activeChildren?: number;
  /** Phase-0 badge slot (MUB-129): right-anchored in row 1; null/undefined hides it. */
  badge?: FooterBadge | null;
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
  badge,
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
      {/* Each row is a single truncating line so a long status never wraps to extra rows and
          pushes itself (or the perms line) off the bottom past the frame clip — footerHeight
          in app.tsx assumes exactly two status rows. Row 1 is a flex pair (truncating text +
          fixed-width badge slot) — still exactly one row. */}
      <Box>
        <Box flexGrow={1}>
          <Text wrap="truncate">
            {/* B2: the [PLAN] indicator moved to the right-anchored badge slot (same row) —
                app.tsx sets it via setFooterBadge, so no duplicate segment here. */}
            <Text color="gray"> model: </Text>
            <Text color={modelStyle}>
              {model} ▸ {basis}
            </Text>

            <Text color="gray"> · route: </Text>
            <Text color={routeStyle}>{routeMode}</Text>

            <Text color="gray"> · reason: </Text>
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
          </Text>
        </Box>
        {badge && (
          <Box flexShrink={0}>
            <Text bold color={badge.color ?? "magenta"}>
              {" "}
              [{badge.text}]
            </Text>
          </Box>
        )}
      </Box>
      <Text wrap="truncate">
        <Text color="gray">perms: </Text>
        <Text color="green">{`r-x ${readDirs?.length ?? 0} dir${(readDirs?.length ?? 0) === 1 ? "" : "s"}`}</Text>
        {alwaysTools && alwaysTools.length > 0 ? (
          <Text color="yellow"> {`· --x ${alwaysTools.join(", ")}`}</Text>
        ) : (
          <Text color="gray"> · w/e/b: ask</Text>
        )}
        {planMode && <Text color="magenta"> · PLAN (ask)</Text>}
      </Text>
    </Box>
  );
}
