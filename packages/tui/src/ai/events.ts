/**
 * Streaming events emitted during assistant message generation.
 *
 * Faithful port of the Python harness's ai/events.py (itself a port of PI's taxonomy).
 * `contentIndex` associates each delta/end event with its block — providers
 * interleave deltas across text/thinking/tools.
 */

import type { AssistantMessage, StopReason, ToolCall } from "./types.ts";

export type StreamEventReason = "error" | "aborted";

export interface StartEvent {
  type: "start";
  partial?: AssistantMessage;
}
export interface TextStartEvent {
  type: "text_start";
  contentIndex: number;
}
export interface TextDeltaEvent {
  type: "text_delta";
  delta: string;
  contentIndex: number;
}
export interface TextEndEvent {
  type: "text_end";
  content: string;
  contentIndex: number;
}
export interface ThinkingStartEvent {
  type: "thinking_start";
  contentIndex: number;
}
export interface ThinkingDeltaEvent {
  type: "thinking_delta";
  delta: string;
  contentIndex: number;
}
export interface ThinkingEndEvent {
  type: "thinking_end";
  content: string;
  contentIndex: number;
}
export interface ToolCallStartEvent {
  type: "toolcall_start";
  contentIndex: number;
}
export interface ToolCallDeltaEvent {
  type: "toolcall_delta";
  delta: string;
  contentIndex: number;
}
export interface ToolCallEndEvent {
  type: "toolcall_end";
  toolCall: ToolCall;
  contentIndex: number;
}
export interface DoneEvent {
  type: "done";
  reason: StopReason;
  message: AssistantMessage;
}
export interface ErrorEvent {
  type: "error";
  reason: StreamEventReason;
  error: AssistantMessage;
}

export type StreamEvent =
  | StartEvent
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ThinkingStartEvent
  | ThinkingDeltaEvent
  | ThinkingEndEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | DoneEvent
  | ErrorEvent;

// Factories.
export const start = (partial?: AssistantMessage): StartEvent => ({ type: "start", partial });
export const textStart = (contentIndex: number): TextStartEvent => ({
  type: "text_start",
  contentIndex,
});
export const textDelta = (delta: string, contentIndex: number): TextDeltaEvent => ({
  type: "text_delta",
  delta,
  contentIndex,
});
export const textEnd = (content: string, contentIndex: number): TextEndEvent => ({
  type: "text_end",
  content,
  contentIndex,
});
export const thinkingStart = (contentIndex: number): ThinkingStartEvent => ({
  type: "thinking_start",
  contentIndex,
});
export const thinkingDelta = (delta: string, contentIndex: number): ThinkingDeltaEvent => ({
  type: "thinking_delta",
  delta,
  contentIndex,
});
export const thinkingEnd = (content: string, contentIndex: number): ThinkingEndEvent => ({
  type: "thinking_end",
  content,
  contentIndex,
});
export const toolCallStart = (contentIndex: number): ToolCallStartEvent => ({
  type: "toolcall_start",
  contentIndex,
});
export const toolCallDelta = (delta: string, contentIndex: number): ToolCallDeltaEvent => ({
  type: "toolcall_delta",
  delta,
  contentIndex,
});
export const toolCallEnd = (toolCall: ToolCall, contentIndex: number): ToolCallEndEvent => ({
  type: "toolcall_end",
  toolCall,
  contentIndex,
});
export const done = (reason: StopReason, message: AssistantMessage): DoneEvent => ({
  type: "done",
  reason,
  message,
});
export const error = (
  reason: StreamEventReason,
  assistantMessage: AssistantMessage,
): ErrorEvent => ({ type: "error", reason, error: assistantMessage });
