/**
 * Agent run state and loop config.
 *
 * Port of the Python harness's agent/state.py. AgentState is both observable state
 * (read via agent.state) and the mutable context threaded through agentLoop —
 * it carries messages, tools, and the steering/follow-up queues the Agent pushes
 * into. Loop config is split out so it can be rebuilt per run.
 */

import type { AssistantMessage, Message, Model } from "../ai/types.ts";
import type { PendingContextRewind } from "./context_prune.ts";
import type {
  AfterToolCall,
  AgentTool,
  BeforeToolCall,
  ThinkingLevel,
  ToolExecutionMode,
} from "./tools.ts";

/** Mutable run state shared between the Agent and the loop. */
export class AgentState {
  systemPrompt: string | null = null;
  model: Model | null = null;
  thinkingLevel: ThinkingLevel = "off";
  tools: AgentTool[] = [];
  messages: Message[] = [];
  isStreaming = false;
  streamingMessage: AssistantMessage | null = null;
  pendingToolCalls = new Set<string>();
  readonly toolAbortScopes = new Map<string, AbortController>();
  errorMessage: string | null = null;
  turnsTaken = 0;
  /** TTSR telemetry: how many turns were aborted-and-retried by a stream tripwire this run. */
  ttsrRetries = 0;
  // Queues the Agent pushes into mid-run; drained between turns by the loop.
  steering: Message[] = [];
  followUp: Message[] = [];
  steeringMode: QueueMode = "one-at-a-time";
  followUpMode: QueueMode = "one-at-a-time";
  // Staged by the rewind tool; applied and cleared by the loop at the turn boundary.
  pendingContextRewind: PendingContextRewind | null = null;

  constructor(
    init?: Partial<
      Pick<
        AgentState,
        | "systemPrompt"
        | "model"
        | "thinkingLevel"
        | "tools"
        | "messages"
        | "steeringMode"
        | "followUpMode"
      >
    >,
  ) {
    if (init) {
      this.systemPrompt = init.systemPrompt ?? null;
      this.model = init.model ?? null;
      this.thinkingLevel = init.thinkingLevel ?? "off";
      this.tools = init.tools ? [...init.tools] : [];
      this.messages = init.messages ? [...init.messages] : [];
      this.steeringMode = init.steeringMode ?? "one-at-a-time";
      this.followUpMode = init.followUpMode ?? "one-at-a-time";
    }
  }
}

export type QueueMode = "one-at-a-time" | "all";

// ---------------------------------------------------------------------------
// TTSR — stream tripwire interfaces (W4.2). Declared HERE so loop.ts depends only
// on its own layer; the concrete implementation lives in minima/ttsr.ts.
// ---------------------------------------------------------------------------

/** A match of a dormant harness tripwire rule against the live token stream. */
export interface TtsrHit {
  ruleId: string;
  reminder: string;
}
/** Per-turn matcher: tests the growing partial (bounded window), tracks per-rule fire counts,
 * and builds the harness-authored reminder for a hit. */
export interface TtsrTurnMatcher {
  /** First firing hit for the current partial text, or null. Cap-exhausted rules are skipped. */
  test(partialText: string): TtsrHit | null;
  /** Record that `hit` fired (per-rule cap bookkeeping). */
  onFired(hit: TtsrHit): void;
  /** The harness user-role reminder Message to inject before the retry. */
  reminder(hit: TtsrHit): Message;
}
/** Installed controller: arm() yields a fresh per-turn matcher. Null on AgentLoopConfig.ttsr
 * means TTSR is not installed (flag off / no rules) — the loop does zero regex work. */
export interface TtsrController {
  arm(): TtsrTurnMatcher;
}

/** (messages) -> messages to send to the LLM (filter custom types, prune, etc.) */
export type ConvertToLlm = (messages: Message[]) => Message[];
/** (messages, signal) -> messages (optional compaction/injection before convertToLlm) */
export type TransformContext = (
  messages: Message[],
  signal: AbortSignal | null,
) => Promise<Message[]>;
/** Run after a turn settles; return true to stop gracefully (e.g. before compaction). */
export type ShouldStopAfterTurn = (
  assistant: AssistantMessage,
  toolResults: ToolResultLike[],
  state: AgentState,
  messages: Message[],
) => Promise<boolean>;
export type StreamFnLike = (
  model: Model,
  context: unknown,
  opts?: { options?: Record<string, unknown>; signal?: AbortSignal },
) => { result(): Promise<AssistantMessage>; [Symbol.asyncIterator](): AsyncIterator<unknown> };

export interface ToolResultLike {
  terminate?: boolean;
  details?: Record<string, unknown>;
}

/** Snapshot of loop behaviour handed to agentLoop. */
export interface AgentLoopConfig {
  model: Model;
  convertToLlm: ConvertToLlm;
  toolExecution: ToolExecutionMode;
  beforeToolCall: BeforeToolCall | null;
  afterToolCall: AfterToolCall | null;
  transformContext: TransformContext | null;
  shouldStopAfterTurn: ShouldStopAfterTurn | null;
  thinkingBudgets: Record<string, number> | null;
  thinkingLevel: ThinkingLevel;
  maxTurns: number;
  sessionId: string | null;
  streamFn: StreamFnLike | null;
  streamOptions: Record<string, unknown> | null;
  signal: AbortSignal | null;
  /** Abort the turn when the model stream emits nothing for this many ms
   * (StreamIdleTimeoutError). 0/null/undefined disables the watchdog. */
  streamIdleTimeoutMs?: number | null;
  /** Stream tripwire controller (W4.2). null/undefined → not installed: the loop does zero
   * regex work and the retry loop runs exactly once (flag-off byte-identity). */
  ttsr?: TtsrController | null;
}

/** Drop anything the LLM can't ingest (keeps user/assistant/toolResult). */
export function defaultConvertToLlm(messages: Message[]): Message[] {
  return messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  );
}
