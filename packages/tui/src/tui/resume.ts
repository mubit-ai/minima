/**
 * Resume helpers (B1, MUB-134) — pure mapping shared by the interactive `/resume` path
 * (app.tsx loadRun) and the `--resume` CLI startup path (main.ts → initialResume prop),
 * so both restores stay one source of truth.
 */

import type { Message } from "../ai/types.ts";
import type { RehydratedRun } from "../db/rehydrate.ts";
import type { ChatMessage } from "./layout.ts";

/** Map rehydrated agent messages to transcript rows. */
export function chatFromMessages(messages: Message[]): ChatMessage[] {
  const chat: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") chat.push({ role: "user", text: m.textContent });
    else if (m.role === "assistant") chat.push({ role: "assistant", text: m.textContent });
    else if (m.role === "toolResult")
      chat.push({
        role: "tool",
        text: m.textContent,
        toolName: m.tool_name ?? "tool",
        isError: m.is_error ?? false,
      });
  }
  return chat;
}

/** The "Resumed run …" tool notice appended after the restored transcript. */
export function resumeNotice(r: RehydratedRun, actualCostUsd: number): ChatMessage {
  const label = r.run.display_name || r.run.run_id.slice(0, 12);
  return {
    role: "tool",
    text: `Resumed run ${label} (${r.messages.length} msg(s), ${r.meterRows.length} routed prompt(s), $${actualCostUsd.toFixed(4)} recorded)`,
    toolName: "resume",
  };
}
