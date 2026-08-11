/**
 * Non-interactive run modes — port of the Python harness's tui/run_modes.py.
 *
 *   --print       one-shot: run the prompt, print the final assistant text, exit.
 *   --mode json   stream every AgentEvent as a JSON line, then exit.
 *
 * A provider failure produces empty output; we report the reason on stderr and exit
 * non-zero instead of silently printing a blank line.
 *
 * This module is also one of the three implementations of the front-end contract
 * (frontend.ts) — see `nonInteractiveFrontEnd` for what this path fills, what it deliberately
 * leaves empty, and why none of it is being fixed here.
 */

import type { Listener } from "./agent/agent.ts";
import type { AgentEvent } from "./agent/events.ts";
import type { ErrorEvent, TextDeltaEvent } from "./ai/events.ts";
import { AssistantMessage } from "./ai/types.ts";
import { type FrontEnd, subscribeAgentEvents } from "./frontend.ts";
import { headlessVerifyConsent } from "./minima/big_plan.ts";
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

/** The provider error a streamed update carries, if it carries one. One shape, two readers:
 *  the JSON projection below and runJson's exit code. */
function streamedError(event: AgentEvent): ErrorEvent | null {
  if (event.type !== "message_update") return null;
  const stream = event.assistantMessageEvent as TextDeltaEvent | ErrorEvent | null;
  return stream?.type === "error" ? stream : null;
}

/** Serialize an AgentEvent into a JSON-friendly dict (PI-style JSON mode). */
export function eventToDict(event: AgentEvent): Record<string, unknown> {
  if (event.type === "message_update") {
    const stream = event.assistantMessageEvent as TextDeltaEvent | ErrorEvent | null;
    if (stream?.type === "text_delta") return { type: "text_delta", delta: stream.delta };
    const failure = streamedError(event);
    if (failure) {
      return {
        type: "error",
        message: failure.error.error_message || "provider error",
        model: failure.error.model,
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

/** `--mode json`'s event seam: one JSON object per line on stdout, as the run happens. */
function jsonLineListener(): Listener {
  return (event: AgentEvent) => {
    process.stdout.write(`${JSON.stringify(eventToDict(event))}\n`);
  };
}

/**
 * The non-interactive path's half of the front-end contract — `--print` and `--mode json`.
 *
 * These bindings are today's behaviour written down, not today's behaviour improved: what a
 * piped run does is a shipped surface, and changing it belongs on its own ticket rather than
 * riding along inside the one that names the seams. Seam by seam, and why:
 *
 *   permission — null, so no hook is registered and every tool call runs unprompted. That is
 *     deliberate for a mode with nobody to ask: a prompt no one can answer is a hang, and a
 *     blanket deny would leave `minima --print` unable to do the work it was just handed. It is
 *     also a real hole — anyone piping a prompt in gets unrestricted shell with no gate — and
 *     it is frozen here, in the open, rather than quietly. Whether to close it, and how, is a
 *     breaking change to a shipped surface and is decided on its own merits (MUB-249).
 *   askUser — null. The `question` tool falls back to telling the model to proceed on its best
 *     assumption, which is the honest answer when there is no user in the loop.
 *   verifyConsent — the fail-CLOSED checker: a plan's verify commands are model-authored
 *     shell, so an unattended run executes none of them unless MINIMA_TUI_ALLOW_VERIFY=1 opts
 *     in. Note the asymmetry against permission above — consent for shell the MODEL wrote
 *     defaults to no, while the tools the user's own prompt asked for run. Both are frozen.
 *   childEvents — null. There is no live tree to render sub-agent progress into; the child's
 *     result still comes back through the task tool.
 *   agentEvents — the JSON-line writer under `--mode json`; empty under `--print`, which reads
 *     the final assistant message off the agent once the run is over.
 *   io — null: this path reads and writes the working tree directly.
 */
export function nonInteractiveFrontEnd(mode: "print" | "json"): FrontEnd {
  return {
    name: "non-interactive",
    permission: null,
    askUser: { current: null },
    verifyConsent: { current: headlessVerifyConsent() },
    childEvents: { handler: null },
    agentEvents: { listener: mode === "json" ? jsonLineListener() : null },
    io: { current: null },
  };
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

/**
 * Stream every AgentEvent as a JSON line, then exit (non-zero on failure).
 *
 * `frontEnd` is the run's own front-end, so the lines on stdout come out of the contract's
 * event seam rather than a subscription only this function knows about; the default builds
 * the same one, for a caller that has no bootstrap behind it.
 */
export async function runJson(
  agent: MinimaAgent,
  prompt: string,
  frontEnd: FrontEnd = nonInteractiveFrontEnd("json"),
): Promise<number> {
  // The seam owns what reaches stdout; the exit code is this run mode's own business, so
  // failure detection watches the stream beside it rather than reaching into its closure.
  let sawError = false;
  agent.subscribe((event) => {
    if (streamedError(event)) sawError = true;
  });
  subscribeAgentEvents(agent, frontEnd.agentEvents);
  await agent.promptRouted(prompt);
  // Learning-loop rejections (HTTP-200 accepted=false, e.g. memory_write_failed) never
  // appear as agent events — emit one line so scripts/CI can detect a starving loop.
  // Not counted as run failure: the turn succeeded, only the learning write-back failed.
  if (agent.lastFeedbackError) {
    process.stdout.write(
      `${JSON.stringify({ type: "feedback_error", message: agent.lastFeedbackError })}\n`,
    );
  }
  const last = lastAssistant(agent);
  // Reflect failure in the exit code so scripts/CI can gate on it: a streamed error event,
  // a hard-error final message, or offline-with-no-output all count as failure.
  const failed =
    sawError ||
    last?.stop_reason === "error" ||
    (agent.offlineReason !== null && !(last?.textContent ?? "").trim());
  return failed ? 1 : 0;
}
