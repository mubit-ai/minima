/**
 * checkpoint / rewind — the model-callable context-pruning pair (P4).
 *
 * checkpoint's own persisted tool event IS the durable anchor record (no state
 * write); rewind stages a projection prune the loop applies at the turn boundary
 * and appends the `context_rewind` marker to the events spine. DISTINCT from the
 * user-facing /ckpt git-shadow snapshots (src/session/checkpoint.ts) and the B4
 * prompt rewind (src/session/rewind.ts, `rewind` event type). Guard failures
 * THROW so the loop stamps is_error=true on the toolResult — findRewindAnchor's
 * consume rule filters on is_error, and a RETURNED errorResult would read as a
 * successful rewind and wrongly consume the checkpoint.
 */

import { CONTEXT_REWIND_EVENT, findRewindAnchor } from "../agent/context_prune.ts";
import type { AgentState } from "../agent/state.ts";
import type { AgentTool, ToolResult } from "../agent/tools.ts";
import type { ParseResult, ToolSchema } from "../ai/types.ts";
import { text } from "../ai/types.ts";
import type { MinimaDb } from "../db/minima_db.ts";
import { boundText } from "./_bounds.ts";
import { objectSchema } from "./schema.ts";

export interface ContextRewindDeps {
  getState: () => AgentState;
  db: MinimaDb | null;
  getRunId: () => string | null;
}

const REPORT_MAX_CHARS = 16_000;

export function checkpointTool(_deps: ContextRewindDeps): AgentTool {
  return {
    name: "checkpoint",
    description:
      "Set a context checkpoint before an exploration burst (broad searching, reading, " +
      "trial-and-error). Later, call the rewind tool with a report of what you learned: " +
      "everything between this checkpoint and the rewind is pruned from your working " +
      "context, keeping only the report. The full transcript stays in the session ledger. " +
      "A rewind consumes its checkpoint; set a fresh one for each burst.",
    parameters: objectSchema(
      {
        label: {
          type: "string",
          description: "Optional short note on why this checkpoint exists.",
          default: "",
        },
      },
      [],
    ),
    executionMode: "sequential",
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const label = String(params.label ?? "");
      return {
        content: [text(label ? `Checkpoint set: ${label}` : "Checkpoint set")],
        details: { checkpoint: true, label },
      };
    },
  };
}

const rewindParameters: ToolSchema = (() => {
  const base = objectSchema(
    {
      report: {
        type: "string",
        description:
          "A complete summary of what you learned since the checkpoint (file paths, " +
          "findings, decisions). After the rewind this report is all you will remember " +
          "of the pruned work, so include everything you still need.",
      },
    },
    ["report"],
  );
  return {
    jsonSchema: base.jsonSchema,
    validate(value): ParseResult<Record<string, unknown>> {
      const parsed = base.validate(value);
      if (!parsed.ok) return parsed;
      if (!String(parsed.value.report ?? "").trim()) {
        return {
          ok: false,
          errors: ["report: required — a non-empty summary of what you learned"],
        };
      }
      return parsed;
    },
  };
})();

function rewindFailureHint(state: AgentState): string {
  const messages = state.messages;
  const last = messages[messages.length - 1];
  const batched =
    last?.role === "assistant" &&
    last.content.some((b) => b.type === "toolCall" && b.name === "checkpoint");
  if (batched) {
    return (
      "checkpoint has not committed yet — its result lands when this turn ends; " +
      "call rewind in a later turn than its checkpoint"
    );
  }
  const consumedIdx = messages.findLastIndex(
    (m) => m.role === "toolResult" && m.tool_name === "rewind" && !m.is_error,
  );
  const anyCheckpoint = messages.findLastIndex(
    (m) => m.role === "toolResult" && m.tool_name === "checkpoint" && !m.is_error,
  );
  if (anyCheckpoint >= 0 && anyCheckpoint <= consumedIdx) {
    return (
      "the last checkpoint was already consumed by a previous rewind — " +
      "set a fresh checkpoint before rewinding again"
    );
  }
  return (
    "no active checkpoint — call checkpoint before rewind (an earlier checkpoint " +
    "may have been removed by context compaction; set a fresh one)"
  );
}

export function rewindTool(deps: ContextRewindDeps): AgentTool {
  return {
    name: "rewind",
    description:
      "Prune your working context back to the most recent checkpoint, replacing the " +
      "exploration in between with your report. The report is REQUIRED and is all you " +
      "will remember of the pruned work afterwards. Pruned tool traffic is preserved in " +
      "the session ledger, never deleted. A rewind consumes its checkpoint — set a new " +
      "checkpoint before rewinding again — and the checkpoint must come from an earlier " +
      "turn, not this one.",
    parameters: rewindParameters,
    executionMode: "sequential",
    async execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> {
      const state = deps.getState();
      const report = String(params.report ?? "");
      const anchor = findRewindAnchor(state.messages);
      if (!anchor) throw new Error(rewindFailureHint(state));
      const bounded = boundText(report, { maxChars: REPORT_MAX_CHARS, keep: "headTail" });
      const runId = deps.getRunId();
      if (deps.db && runId) {
        try {
          deps.db.appendEvent({
            runId,
            type: CONTEXT_REWIND_EVENT,
            payload: {
              anchor_tool_call_id: anchor,
              rewind_tool_call_id: toolCallId,
              report: bounded.body,
              report_chars: report.length,
            },
          });
        } catch {
          // log-and-swallow: bookkeeping never breaks the hot path
        }
      }
      state.pendingContextRewind = { anchorToolCallId: anchor, rewindToolCallId: toolCallId };
      return {
        content: [
          text(
            `Context rewound to checkpoint. Pruned tool traffic is preserved in the session ledger.\n\nReport:\n${bounded.body}`,
          ),
        ],
        details: {
          context_rewind: true,
          anchor_tool_call_id: anchor,
          report_chars: report.length,
          truncated: bounded.truncated,
        },
      };
    },
  };
}

export function registerContextRewindTools(
  tools: AgentTool[],
  enabled: boolean,
  deps: ContextRewindDeps,
): void {
  if (!enabled) return;
  tools.push(checkpointTool(deps), rewindTool(deps));
}
