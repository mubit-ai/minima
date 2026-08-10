/**
 * The agent event → UI state translation, lifted out of app.tsx.
 *
 * Extraction only — the switch body is the one that used to live inline in HarnessApp,
 * unchanged. The six stream-accumulator refs had no reader outside it, so they are private
 * here now; everything still read during render stays owned by the component and arrives
 * through `cb`.
 */

import { useEffect, useRef } from "react";
import type { AgentEvent } from "../agent/events.ts";
import type { AssistantMessage } from "../ai/types.ts";
import type { MinimaAgent } from "../minima/runtime.ts";
import { isHarnessSteerText } from "../minima/stop_gate.ts";
import { type ActiveAction, reduceActiveActions } from "./current_action.ts";
import type { ChatMessage } from "./messages.tsx";
import { isGuardDenyReason } from "./permissions.ts";
import { actionableError } from "./provider_hints.ts";

export interface AgentEventCallbacks {
  pushMessage: (m: ChatMessage) => void;
  setStreaming: (s: string) => void;
  setStreamingThoughts: (s: string) => void;
  setBusyState: (s: "ready" | "reasoning" | "running") => void;
  setActiveActions: (f: (a: ActiveAction[]) => ActiveAction[]) => void;
  bumpTodoGen: () => void;
  refreshPlanStrip: () => void;
}

/**
 * Subscribe to the agent event stream once (per `agent` identity).
 *
 * `pendingEchoRef` and `showThinkingRef` stay owned by the component — onSubmit sets the
 * former, and the render tree reads the latter.
 */
export function useAgentEvents(
  agent: MinimaAgent,
  pendingEchoRef: React.MutableRefObject<boolean>,
  showThinkingRef: React.RefObject<boolean>,
  cb: AgentEventCallbacks,
): void {
  // Stream accumulators: deltas land here and flush to state on an 80ms timer, so a fast
  // token stream costs one render per flush rather than one per delta.
  const streamingBufRef = useRef("");
  const streamingThoughtsBufRef = useRef("");
  const streamFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thoughtsFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thoughtsRef = useRef("");
  const thinkingStartRef = useRef<number | null>(null);
  // The callbacks are recreated every render; the subscription must not be. Mirror them so
  // the effect can keep `[agent]` as its only dependency, exactly as it did inline.
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useEffect(() => {
    const unsub = agent.subscribe((ev: AgentEvent) => {
      const {
        pushMessage,
        setStreaming,
        setStreamingThoughts,
        setBusyState,
        setActiveActions,
        bumpTodoGen,
        refreshPlanStrip,
      } = cbRef.current;
      switch (ev.type) {
        case "message_start":
          if (ev.message?.role === "user") {
            // LB-21: a recovery-ladder rung >= 1 re-issues the SAME task — the flagged
            // re-prompt must never re-echo (the original already printed at submit).
            if (ev.message.ladder_reprompt) break;
            if (pendingEchoRef.current) {
              pendingEchoRef.current = false;
              break;
            }
            // R3b: harness steers render as a dim line (guardKind); the model saw the full text.
            const utext = ev.message!.textContent;
            const echo: ChatMessage = { role: "user", text: utext };
            if (isHarnessSteerText(utext)) echo.guardKind = "harness";
            pushMessage(echo);
          }
          break;
        case "message_update": {
          const s = ev.assistantMessageEvent;
          if (s?.type === "thinking_start") {
            thinkingStartRef.current = Date.now();
            setBusyState("reasoning");
            streamingThoughtsBufRef.current = "";
          } else if (s?.type === "thinking_delta") {
            thoughtsRef.current += s.delta;
            streamingThoughtsBufRef.current += s.delta;
            if (!thoughtsFlushRef.current) {
              thoughtsFlushRef.current = setTimeout(() => {
                setStreamingThoughts(streamingThoughtsBufRef.current);
                thoughtsFlushRef.current = null;
              }, 80);
            }
          } else if (s?.type === "text_delta") {
            setBusyState("running");
            streamingBufRef.current += s.delta;
            if (!streamFlushRef.current) {
              streamFlushRef.current = setTimeout(() => {
                setStreaming(streamingBufRef.current);
                streamFlushRef.current = null;
              }, 80);
            }
          }
          break;
        }
        case "message_end":
          if (ev.message && ev.message.role === "assistant") {
            const assistantMsg = ev.message as AssistantMessage;
            const text = assistantMsg.textContent.trim();
            const isErr = assistantMsg.stop_reason === "error";
            const errMsg = assistantMsg.error_message;
            const elapsed = thinkingStartRef.current
              ? (Date.now() - thinkingStartRef.current) / 1000
              : 0;
            const accumulatedThoughts = thoughtsRef.current.trim();
            // MP20 (MUB-165): tear the live stream DOWN before committing to <Static>.
            // Under the anchor ledger this ordering is UX, not correctness (either order
            // stays bottom-anchored — the floor absorbs the shrink as padding): teardown-
            // first still minimizes the transient padding gap and keeps the reply tail
            // adjacent to the composer on the settled screen (the fence-verbatim gates).
            // These setStates flush as separate Ink renders; with the old order (commit
            // first) render A printed the static reply while the live frame was still
            // stream-tall, and render B's erase then walked that tall height back UP from
            // the bottom, repainting the shrunken composer mid-screen with dead rows below
            // — the stranded-prompt class (once the static estimate saturates, no minHeight
            // refills the shrink). Clearing first flips the order: the shrink is erased in
            // place, then the static commit scrolls the reply in ABOVE the short frame,
            // landing the composer on the bottom rows with the reply tail visible — CC's
            // post-reply look. The stream tail is disposable live content; the full reply
            // commits in the very next flush, so no frame can lose transcript rows.
            setStreaming("");
            setStreamingThoughts("");
            streamingBufRef.current = "";
            streamingThoughtsBufRef.current = "";
            if (streamFlushRef.current) {
              clearTimeout(streamFlushRef.current);
              streamFlushRef.current = null;
            }
            if (thoughtsFlushRef.current) {
              clearTimeout(thoughtsFlushRef.current);
              thoughtsFlushRef.current = null;
            }
            thoughtsRef.current = "";
            thinkingStartRef.current = null;
            if (showThinkingRef.current && accumulatedThoughts) {
              pushMessage({
                role: "thinking",
                text: accumulatedThoughts,
                thoughtDurationSecs: elapsed,
              });
            }
            if (isErr) {
              // A hard provider failure — render RED (role tool + isError) and, when it's an
              // auth error, append actionable guidance naming the provider key to set.
              const provider = agent.agentState.model?.provider;
              pushMessage({
                role: "tool",
                toolName: "error",
                text: `⚠ ${actionableError(errMsg || "provider error (no response)", provider)}`,
                isError: true,
              });
            } else if (text) {
              pushMessage({ role: "assistant", text });
            }
          } else if (ev.message?.role === "toolResult") {
            // R3b: guard/mode denials (stable prefixes owned by permissions.ts) are the
            // harness working as designed — tag them so the renderer's calm dim branch,
            // never the red error path, picks them up. Wire content is untouched.
            pushMessage({
              role: "tool",
              text: ev.message!.textContent,
              toolName: ev.message!.tool_name,
              isError: ev.message!.is_error,
              ...(ev.message!.is_error && isGuardDenyReason(ev.message!.textContent)
                ? { guardKind: "deny" as const }
                : {}),
            });
          }
          break;
        case "tool_execution_start":
          setBusyState("running");
          setActiveActions((a) => reduceActiveActions(a, ev));
          break;
        case "tool_execution_end":
          setActiveActions((a) => reduceActiveActions(a, ev));
          // D3a: todowrite mutates the `todos` array in place — bump the gen so the memo
          // re-reads it (the event carries no toolName; an unconditional bump is the
          // established pattern, same as the plan refresh below).
          bumpTodoGen();
          // Keep the plan footer strip in step with the ledger the afterToolCall sink just wrote:
          // todowrite advances the active step; write/edit/apply_patch may add off-plan drift.
          refreshPlanStrip();
          break;
      }
    });
    return unsub;
  }, [agent, pendingEchoRef, showThinkingRef]);
}
