/**
 * Non-interactive run modes — port of minima_harness/tui/run_modes.py.
 *
 *   --print       one-shot: run the prompt, print the final assistant text, exit.
 *   --mode json   stream every AgentEvent as a JSON line, then exit.
 *
 * A provider failure produces empty output; we report the reason on stderr and exit
 * non-zero instead of silently printing a blank line.
 */

import type { AgentEvent } from "./agent/events.ts";
import type { ErrorEvent, TextDeltaEvent } from "./ai/events.ts";
import { AssistantMessage } from "./ai/types.ts";
import type { MinimaAgent } from "./minima/runtime.ts";

/** Last assistant message, if any (holds stop_reason/error_message/textContent). */
function lastAssistant(agent: MinimaAgent): AssistantMessage | null {
  const messages = agent.agentState.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m instanceof AssistantMessage) return m;
  }
  return null;
}

/** Serialize an AgentEvent into a JSON-friendly dict (PI-style JSON mode). */
export function eventToDict(event: AgentEvent): Record<string, unknown> {
  if (event.type === "message_update") {
    const stream = event.assistantMessageEvent as TextDeltaEvent | ErrorEvent | null;
    if (stream?.type === "text_delta") return { type: "text_delta", delta: stream.delta };
    if (stream?.type === "error") {
      return {
        type: "error",
        message: stream.error.error_message || "provider error",
        model: stream.error.model,
      };
    }
    return { type: "message_update" };
  }
  if (event.type === "tool_execution_start") return { type: "tool_start", name: event.toolName };
  if (event.type === "tool_execution_end") return { type: "tool_end", is_error: event.isError };
  if (event.type === "turn_end") return { type: "turn_end" };
  if (event.type === "agent_end") return { type: "done" };
  if (event.type === "agent_start") return { type: "start" };
  return { type: event.type };
}

/** One-shot: run the prompt, print the final assistant text, exit. */
export async function runPrint(agent: MinimaAgent, prompt: string): Promise<number> {
  await agent.promptRouted(prompt);
  const last = lastAssistant(agent);
  // A hard provider failure (bad/missing key, HTTP 401, SDK auth error) sets stop_reason
  // "error" — report it on stderr and exit non-zero instead of printing a blank line + exit 0.
  if (last?.stop_reason === "error") {
    process.stderr.write(`${last.error_message || "provider error"}\n`);
    return 1;
  }
  const text = last?.textContent ?? "";
  if (agent.offlineReason && !text.trim()) {
    process.stderr.write(`${agent.offlineReason}\n`);
    return 1;
  }
  process.stdout.write(`${text}\n`);
  return 0;
}

/** Stream every AgentEvent as a JSON line, then exit (non-zero on failure). */
export async function runJson(agent: MinimaAgent, prompt: string): Promise<number> {
  let sawError = false;
  agent.subscribe((event) => {
    const dict = eventToDict(event);
    if (dict.type === "error") sawError = true;
    process.stdout.write(`${JSON.stringify(dict)}\n`);
  });
  await agent.promptRouted(prompt);
  const last = lastAssistant(agent);
  // Reflect failure in the exit code so scripts/CI can gate on it: a streamed error event,
  // a hard-error final message, or offline-with-no-output all count as failure.
  const failed =
    sawError ||
    last?.stop_reason === "error" ||
    (agent.offlineReason !== null && !(last?.textContent ?? "").trim());
  return failed ? 1 : 0;
}
