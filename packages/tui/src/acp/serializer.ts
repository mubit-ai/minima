/**
 * The agent event stream, projected into ACP session update notifications.
 *
 * This is a NEW serializer over the full `AgentEvent` union, not an extension of the headless
 * JSON projection in run_modes.ts. That projection was considered and rejected: it collapses
 * every tool call to `{type, name}` and `{type, is_error}`, discarding the tool call id, the
 * arguments, the result and every thinking delta — which is to say, precisely the fields the
 * protocol carries. It also has no input channel, and it is a pinned contract with existing
 * script consumers. The two share exactly one thing, the agent's public `subscribe` call, and
 * that is where the sharing ends. The headless mode is untouched by this file.
 *
 * The projection is a small state machine rather than a pure per-event map, because two ACP
 * facts are stateful: chunks belonging to one assistant message must share a `messageId`, and a
 * tool call is announced once and then *updated*, so the end frame has to know the start frame
 * happened. Everything else is a direct translation.
 *
 * It emits, and never awaits: a serializer that could block would put backpressure from the
 * client's socket into the middle of the agent's tool dispatch.
 */

import { isAbsolute, resolve } from "node:path";
import type {
  ToolCallLocation,
  ToolCallContent as ToolContent,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "../agent/events.ts";
import type { ToolResult } from "../agent/tools.ts";
import type { ErrorEvent, StreamEvent } from "../ai/events.ts";
import { AssistantMessage, type ContentBlock } from "../ai/types.ts";
import { expand } from "../tools/_io.ts";
import { formatToolArgs } from "../tui/permissions.ts";

/** Where a projected update goes. Synchronous by contract — see the module note. */
export type SessionUpdateSink = (update: SessionUpdate) => void;

/**
 * Tool name → the protocol's tool category, which is how a client picks an icon and decides
 * whether to render a call inline or in a panel. Anything unmapped is `other`, which is the
 * honest answer for a tool whose shape the protocol has no word for.
 */
const TOOL_KINDS: Record<string, ToolKind> = {
  read: "read",
  ls: "read",
  glob: "search",
  grep: "search",
  write: "edit",
  edit: "edit",
  apply_patch: "edit",
  bash: "execute",
  bgjob: "execute",
  web_fetch: "fetch",
  web_search: "fetch",
  exit_plan: "switch_mode",
};

export function toolKindFor(toolName: string): ToolKind {
  return TOOL_KINDS[toolName] ?? "other";
}

/**
 * The files a call touches, so the client can follow along in the editor. Absolute paths only —
 * the protocol requires it, and a relative one would be resolved against whatever the client's
 * own working directory happens to be.
 *
 * Only the tools whose target is a single unambiguous path are mapped. `bash` is deliberately
 * absent: guessing which files a shell command touches from its argv is the kind of plausible
 * inference that is wrong often enough to make follow-along untrustworthy.
 */
export function toolCallLocations(
  toolName: string,
  args: Record<string, unknown> | null,
  cwd: string,
): ToolCallLocation[] {
  if (!args) return [];
  const raw =
    toolName === "read" || toolName === "ls" || toolName === "write"
      ? (args.path ?? args.file_path)
      : toolName === "edit" || toolName === "apply_patch"
        ? (args.filePath ?? args.path)
        : null;
  if (typeof raw !== "string" || !raw.trim()) return [];
  const full = expand(raw);
  return [{ path: isAbsolute(full) ? full : resolve(cwd, full) }];
}

/** A tool result's content blocks, in the protocol's tool-call content shape. */
function toolContent(result: ToolResult | null): ToolContent[] {
  if (!result) return [];
  const out: ToolContent[] = [];
  for (const block of result.content) {
    if (block.type === "text") {
      if (block.text) out.push({ type: "content", content: { type: "text", text: block.text } });
    } else if (block.type === "image") {
      out.push({
        type: "content",
        content: { type: "image", data: block.data, mimeType: block.mime_type ?? "image/png" },
      });
    }
    // thinking / nested toolCall blocks never appear in a tool result; dropping them keeps the
    // frame to what a client can actually render.
  }
  return out;
}

/** The provider error a streamed update carries, if it carries one. */
function streamedError(event: AgentEvent): ErrorEvent | null {
  if (event.type !== "message_update") return null;
  const stream = event.assistantMessageEvent as StreamEvent | null;
  return stream?.type === "error" ? stream : null;
}

export interface SerializerOptions {
  /** Resolves relative tool paths for `locations`. The session's working directory. */
  cwd: string;
}

/**
 * Projects one prompt turn's agent events onto the wire. One instance per session; call
 * {@link startTurn} at each prompt so message ids restart from a known point.
 */
export class AgentEventSerializer {
  /** Set when the turn's stream carried a provider error — the prompt handler reads it. */
  streamError: string | null = null;

  private messageIndex = 0;
  private messageId: string | null = null;
  /** Tool calls announced this turn, so an end frame knows an update is what it owes. */
  private readonly announced = new Set<string>();

  constructor(
    private readonly emit: SessionUpdateSink,
    private readonly opts: SerializerOptions,
  ) {}

  startTurn(): void {
    this.streamError = null;
    this.messageId = null;
    this.announced.clear();
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "message_start":
        // A new assistant message begins a new chunk group. The protocol identifies groups by a
        // changing `messageId`, so this is the only place one is minted.
        if (event.message instanceof AssistantMessage) {
          this.messageIndex += 1;
          this.messageId = `msg-${this.messageIndex}`;
        }
        return;
      case "message_update":
        this.handleStream(event.assistantMessageEvent);
        return;
      case "tool_execution_start":
        this.announced.add(event.toolCallId);
        this.emit({
          sessionUpdate: "tool_call",
          toolCallId: event.toolCallId,
          title: titleFor(event.toolName, event.args),
          name: event.toolName,
          kind: toolKindFor(event.toolName),
          // `in_progress`, not `pending`: the harness has decided to run this call, and the
          // permission request that may follow is its own protocol round-trip which the client
          // renders on its own. A status that waited for the grant would need a fourth event
          // the agent loop does not emit.
          status: "in_progress",
          ...(event.args ? { rawInput: event.args } : {}),
          locations: toolCallLocations(
            event.toolName,
            (event.args ?? null) as Record<string, unknown> | null,
            this.opts.cwd,
          ),
        });
        return;
      case "tool_execution_update":
        if (!this.announced.has(event.toolCallId)) return;
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          status: "in_progress",
          rawOutput: event.partial,
        });
        return;
      case "tool_execution_end": {
        if (!this.announced.has(event.toolCallId)) return;
        const content = toolContent(event.result);
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          status: event.isError ? "failed" : "completed",
          ...(content.length > 0 ? { content } : {}),
        });
        return;
      }
      default:
        // agent_start / agent_end / turn_start / turn_end / message_end carry no update a
        // client can use: the turn's boundaries are the prompt request and its response.
        return;
    }
  }

  private handleStream(stream: StreamEvent | null): void {
    if (!stream) return;
    if (stream.type === "text_delta") {
      if (stream.delta) this.chunk("agent_message_chunk", stream.delta);
      return;
    }
    if (stream.type === "thinking_delta") {
      if (stream.delta) this.chunk("agent_thought_chunk", stream.delta);
      return;
    }
    if (stream.type === "error") {
      // Recorded rather than emitted: a failed turn is reported by the prompt response, and a
      // chunk here would render the failure as if the model had said it.
      this.streamError = stream.error.error_message || "provider error";
    }
  }

  private chunk(kind: "agent_message_chunk" | "agent_thought_chunk", text: string): void {
    this.emit({
      sessionUpdate: kind,
      content: { type: "text", text },
      ...(this.messageId ? { messageId: this.messageId } : {}),
    });
  }
}

/**
 * The one-line title a client shows for a call. Reuses the terminal UI's argument formatter, so
 * an editor and a terminal describe the same call the same way — and so a tool that changes its
 * arguments only has to teach one formatter about it.
 */
export function titleFor(toolName: string, args: unknown): string {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const summary = formatToolArgs(toolName, args as Record<string, unknown>);
    if (summary) return `${toolName}: ${summary}`;
  }
  return toolName;
}

/** Assistant text blocks, joined — used to replay a message the stream never chunked. */
export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export { streamedError };
