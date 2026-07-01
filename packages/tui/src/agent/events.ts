/**
 * Agent runtime events — a port of PI's pi-agent-core event taxonomy.
 *
 * Emitted by agentLoop() in a strict order per turn:
 *
 *   agent_start
 *     (per turn)
 *       turn_start
 *       message_start  {user or toolResult}
 *       message_end    {...}
 *       message_start  {assistant}
 *       message_update {assistantMessageEvent: a provider StreamEvent}
 *       message_end    {assistant}
 *       tool_execution_start / tool_execution_update / tool_execution_end  (if toolUse)
 *       message_start  {toolResult} / message_end
 *       turn_end
 *   agent_end
 */

import type { StreamEvent } from "../ai/events.ts";
import type { AssistantMessage, Message } from "../ai/types.ts";
import type { ToolResult } from "./tools.ts";

export interface AgentStartEvent {
  type: "agent_start";
}
export interface AgentEndEvent {
  type: "agent_end";
  messages: Message[];
}
export interface TurnStartEvent {
  type: "turn_start";
}
export interface TurnEndEvent {
  type: "turn_end";
  message: AssistantMessage | null;
  toolResults: ToolResult[];
}
export interface MessageStartEvent {
  type: "message_start";
  message: Message | null;
}
export interface MessageUpdateEvent {
  /** Assistant-only. Wraps a provider streaming event (text/thinking/toolcall delta). */
  type: "message_update";
  assistantMessageEvent: StreamEvent | null;
}
export interface MessageEndEvent {
  type: "message_end";
  message: Message | null;
}
export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown | null; // validated params | null when blocked/invalid
}
export interface ToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId: string;
  partial: unknown;
}
export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  result: ToolResult | null;
  isError: boolean;
}

export type AgentEvent =
  | AgentStartEvent
  | AgentEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent;

// Factories.
export const agentStart = (): AgentStartEvent => ({ type: "agent_start" });
export const agentEnd = (messages: Message[]): AgentEndEvent => ({ type: "agent_end", messages });
export const turnStart = (): TurnStartEvent => ({ type: "turn_start" });
export const turnEnd = (
  message: AssistantMessage | null,
  toolResults: ToolResult[],
): TurnEndEvent => ({ type: "turn_end", message, toolResults });
export const messageStart = (message: Message | null): MessageStartEvent => ({
  type: "message_start",
  message,
});
export const messageUpdate = (ev: StreamEvent | null): MessageUpdateEvent => ({
  type: "message_update",
  assistantMessageEvent: ev,
});
export const messageEnd = (message: Message | null): MessageEndEvent => ({
  type: "message_end",
  message,
});
export const toolExecutionStart = (
  toolCallId: string,
  toolName: string,
  args: unknown | null,
): ToolExecutionStartEvent => ({ type: "tool_execution_start", toolCallId, toolName, args });
export const toolExecutionUpdate = (
  toolCallId: string,
  partial: unknown,
): ToolExecutionUpdateEvent => ({
  type: "tool_execution_update",
  toolCallId,
  partial,
});
export const toolExecutionEnd = (
  toolCallId: string,
  result: ToolResult | null,
  isError: boolean,
): ToolExecutionEndEvent => ({ type: "tool_execution_end", toolCallId, result, isError });
