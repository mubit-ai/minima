/**
 * Agent tools and execution hooks — port of minima_harness/agent/tools.py
 * (itself a port of PI's AgentTool + before/afterToolCall).
 *
 * Tools declare parameters as a ToolSchema; execute() is an async callable
 * (toolCallId, params, signal, onUpdate) -> ToolResult. Validation errors and
 * thrown exceptions become tool-error results fed back to the model so it can
 * retry (matching PI).
 */

import type { ContentBlock, ToolCall, ToolSchema } from "../ai/types.ts";
import { text } from "../ai/types.ts";
import type { AgentState } from "./state.ts";

export type ToolExecutionMode = "parallel" | "sequential";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** on_update(partial_result) -> void; called mid-execution for streaming progress. */
export type ToolUpdate = (partial: unknown) => void;
export type ToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | null,
  onUpdate: ToolUpdate | null,
) => Promise<ToolResult>;

/** What a tool returns. `content` goes to the model; `details` are app-facing. */
export interface ToolResult {
  content: ContentBlock[];
  details?: Record<string, unknown>;
  /** Hint to skip the automatic follow-up LLM call. Honoured only when every
   * finalized tool result in the batch also sets terminate=true. */
  terminate?: boolean;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: ToolSchema;
  execute: ToolExecute;
  executionMode?: ToolExecutionMode;
  label?: string;
}

// ---------------------------------------------------------------------------
// Hook types
// ---------------------------------------------------------------------------

export interface BeforeToolCallContext {
  toolCall: ToolCall;
  args: Record<string, unknown>; // validated params
  context: AgentState;
}
export interface BeforeToolCallResult {
  block: boolean;
  reason: string;
}
export interface AfterToolCallContext {
  toolCall: ToolCall;
  result: ToolResult;
  isError: boolean;
  context: AgentState;
}
export interface AfterToolCallResult {
  terminate?: boolean;
  details?: Record<string, unknown>;
  content?: ContentBlock[];
}

export type BeforeToolCall = (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | null>;
export type AfterToolCall = (ctx: AfterToolCallContext) => Promise<AfterToolCallResult | null>;

export function findAgentTool(tools: AgentTool[], name: string): AgentTool | undefined {
  return tools.find((t) => t.name === name);
}

export function errorResult(message: string): ToolResult {
  return { content: [text(message)] };
}
