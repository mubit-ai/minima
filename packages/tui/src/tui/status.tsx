/**
 * Status bar — the bottom line: current model, turn count, and any offline/reroute note.
 * Port of the Python harness's tui/widgets/footer.py.
 */

import { Box, Text } from "ink";
import React from "react";

import type { AgentMode } from "../agent/modes.ts";
import { type EffortModel, effectiveEffort } from "../ai/provider_quirks.ts";
import type { FooterBadge } from "./badge_slot.ts";
import { AUTO_COMPACT_PCT, type ContextUsage, fmtCtxTokens } from "./context_meter.ts";

/** Below this the row already truncates near the token counts, so the `(used/window)`
 * parenthetical would push the `$cost` segment off-screen rather than add information. */
const CTX_DETAIL_MIN_COLS = 100;

/**
 * The perms row's write/exec segments, mode-aware (the old fixed "w/e/b: ask" read as
 * broken in accept-edits, where write/edit ARE auto). `effective` states what the ACTIVE
 * mode does with write/edit/bash; `grants` lists the user's always-allows — whole tools
 * plus persisted bash command families as `bash[pip,git]` (a whole-tool bash grant
 * supersedes its family list) — or null when none.
 */
export function permsSummary(
  mode: AgentMode,
  alwaysTools: string[],
  bashGrants: string[],
): { effective: string; grants: string | null } {
  const effective =
    mode === "acceptEdits"
      ? "w/e: auto (cwd) · b: ask"
      : mode === "bypass"
        ? "w/e/b: auto"
        : mode === "plan"
          ? "PLAN (deny)"
          : "w/e/b: ask";
  const list = [...alwaysTools];
  if (bashGrants.length > 0 && !alwaysTools.includes("bash")) {
    list.push(`bash[${bashGrants.join(",")}]`);
  }
  return { effective, grants: list.length > 0 ? `--x ${list.join(", ")}` : null };
}

/**
 * What the `reason:` segment says about the effort this turn will actually carry (MUB-229).
 *
 * It calls the same `effectiveEffort` the provider builds its payload from, so the indicator
 * cannot drift from the wire: there is one answer and two readers. Before it, cycling the
 * thinking level recoloured a word here while five openai-compat hosts received nothing.
 *
 * `requested→effective` whenever the two differ — a silent clamp plus a one-time note would
 * scroll away and leave this segment claiming the requested level all session.
 */
export function effortIndicator(
  requested: string,
  model: EffortModel | null,
  hasTools: boolean,
): { label: string; color: string; show: boolean } {
  const level = requested === "off" ? null : requested;
  // No model resolved yet: nothing has been sent to anything, so report the request alone.
  if (!model) {
    return { label: level ?? "off", color: level ? "cyan" : "gray", show: level !== null };
  }
  const { send, state } = effectiveEffort(model, hasTools, requested);
  const effective = state === "pinned-none" ? "none" : (send ?? state);
  const diverged = level !== null && effective !== level;
  const overriding = state === "pinned-none" || state === "off";
  return {
    label: diverged ? `${level}→${effective}` : effective,
    color: diverged ? "yellow" : state === "honoured" ? "cyan" : "gray",
    // At rest (thinking off, nothing overridden) the segment stays hidden, as it shipped —
    // a permanent `reason: default` would cost the row a cell to say nothing.
    show: level !== null || overriding,
  };
}

export interface StatusBarProps {
  model: string;
  basis: string;
  routeMode: "auto" | "confirm";
  /** The level the user asked for; what is SENT comes from effortIndicator below. */
  thinkingLevel: string;
  /** Model the next turn runs on, and whether it carries tools — the two other inputs to the
   *  effort ladder. Null (no model resolved yet) falls back to reporting the request. */
  effortModel?: EffortModel | null;
  hasTools?: boolean;
  ctx: ContextUsage;
  /** MINIMA_TUI_CONTEXT_METER: false renders the pre-fix segment (bare `ctx NN%`) and keeps
   * the route/reason segments unconditional, so the row is byte-identical to what shipped. */
  contextMeter?: boolean;
  /** Terminal width, for the responsive `(used/window)` parenthetical. */
  columns?: number;
  inputTokens: number;
  outputTokens: number;
  actualCostUsd?: number;
  sessionId: string;
  routingOffline: boolean;
  offlineReason?: string | null;
  statusText: "ready" | "reasoning" | "running";
  mode?: AgentMode;
  readDirs?: string[];
  alwaysTools?: string[];
  /** Persisted bash command-family grants (perm_grants.ts), shown as bash[pip,git]. */
  bashGrants?: string[];
  /** "spent/limit (mode)" budget note; null hides the segment. */
  budget?: { spentUsd: number; limitUsd: number; fraction: number; mode: string } | null;
  /** Number of sub-agents currently in flight; 0 or undefined hides the badge. */
  activeChildren?: number;
  /** MUB-183 prompt-queue note ("2 queued" / "1 queued · held (esc clears)"); null hides it. */
  queueNote?: string | null;
  /** Phase-0 badge slot (MUB-129): right-anchored in row 1; null/undefined hides it. */
  badge?: FooterBadge | null;
}

export function StatusBar({
  model,
  basis,
  routeMode,
  thinkingLevel,
  effortModel = null,
  hasTools = true,
  ctx,
  contextMeter = true,
  columns = 80,
  inputTokens,
  outputTokens,
  actualCostUsd = 0,
  sessionId,
  routingOffline,
  offlineReason,
  statusText,
  mode = "build",
  readDirs,
  alwaysTools,
  bashGrants,
  budget,
  activeChildren,
  queueNote,
  badge,
}: StatusBarProps) {
  const perms = permsSummary(mode, alwaysTools ?? [], bashGrants ?? []);
  const budgetColor = budget
    ? budget.fraction >= 0.9
      ? "red"
      : budget.fraction >= 0.75
        ? "yellow"
        : "green"
    : "gray";
  const modelStyle = basis === "offline" ? "yellow" : "cyan";
  const routeStyle = routeMode === "confirm" ? "yellow" : "gray";
  const effort = effortIndicator(thinkingLevel, effortModel, hasTools);
  // Red is the same constant the auto-compaction trigger reads, on the same quantity — so
  // red now genuinely means "compaction is imminent" rather than agreeing with it by
  // coincidence, as two unrelated 80s did before.
  const ctxStyle = ctx.pct !== null && ctx.pct > AUTO_COMPACT_PCT ? "red" : "gray";
  // An unresolvable window is yellow ("attention, degraded" everywhere else in this row) and
  // never red: red reads as "nearly full", the opposite of what UNKNOWN means. An empty
  // context is not unknown — there is simply nothing in it, so it stays a plain 0%.
  const ctxUnknown = contextMeter && ctx.pct === null && ctx.usedTokens > 0;
  // A tilde marks a number carrying a chars/4 estimate: no reply has reported usage yet, or
  // messages were appended after the one that did. An empty context has nothing to estimate.
  const ctxTilde = contextMeter && ctx.basis !== "exact" && ctx.usedTokens > 0 ? "~" : "";
  const ctxLabel = ctxUnknown ? "?%" : `${ctxTilde}${(ctx.pct ?? 0).toFixed(0)}%`;
  const ctxDetail =
    contextMeter && columns >= CTX_DETAIL_MIN_COLS && (ctx.usedTokens > 0 || ctx.pct !== null)
      ? ` (${fmtCtxTokens(ctx.usedTokens)}/${ctx.windowTokens === null ? "?" : fmtCtxTokens(ctx.windowTokens)})`
      : null;
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

            {/* Both segments are noise in their shipped default — the code already says so by
                greying them out — and the cells they cost are what pays for the ctx
                parenthetical. Under the rollback flag they render unconditionally again. */}
            {(!contextMeter || routeMode !== "auto") && (
              <>
                <Text color="gray"> · route: </Text>
                <Text color={routeStyle}>{routeMode}</Text>
              </>
            )}

            {(!contextMeter || effort.show) && (
              <>
                <Text color="gray"> · reason: </Text>
                <Text color={effort.color}>{effort.label}</Text>
              </>
            )}

            <Text color="gray"> │ ctx </Text>
            <Text color={ctxUnknown ? "yellow" : ctxStyle}>{ctxLabel}</Text>
            {ctxDetail && <Text color="gray">{ctxDetail}</Text>}

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

            {queueNote ? (
              <>
                <Text color="gray"> · </Text>
                <Text color="yellow">{queueNote}</Text>
              </>
            ) : null}

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
        <Text color={mode === "plan" ? "magenta" : "gray"}> {`· ${perms.effective}`}</Text>
        {perms.grants && <Text color="yellow"> {`· ${perms.grants}`}</Text>}
      </Text>
    </Box>
  );
}
