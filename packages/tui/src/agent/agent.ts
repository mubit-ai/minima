/**
 * The stateful Agent — a port of PI's pi-agent-core Agent class.
 *
 * Wraps agentLoop with: persistent state across prompts, ordered awaited
 * subscribers, abort via an AbortController, and steering/follow-up queues
 * injected between turns. prompt() awaits the full run inline (matching PI);
 * for background use launch it in a task and await waitForIdle().
 */

import type { ContentBlock, Message, Model } from "../ai/types.ts";
import { Message as Msg } from "../ai/types.ts";
import type { AgentEvent } from "./events.ts";
import { agentLoop } from "./loop.ts";
import {
  type AgentLoopConfig,
  AgentState,
  type ConvertToLlm,
  type QueueMode,
  type StreamFnLike,
  type TransformContext,
  defaultConvertToLlm,
} from "./state.ts";
import type {
  AfterToolCall,
  AfterToolCallResult,
  AgentTool,
  BeforeToolCall,
  ThinkingLevel,
  ToolExecutionMode,
} from "./tools.ts";

export type Listener = (event: AgentEvent) => unknown | Promise<unknown>;

export interface AgentOptions {
  model: Model;
  systemPrompt?: string;
  tools?: AgentTool[];
  messages?: Message[];
  thinkingLevel?: ThinkingLevel;
  convertToLlm?: ConvertToLlm;
  transformContext?: TransformContext;
  toolExecution?: ToolExecutionMode;
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  thinkingBudgets?: Record<string, number>;
  maxTurns?: number;
  sessionId?: string;
  streamOptions?: Record<string, unknown>;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  shouldStopAfterTurn?: AgentLoopConfig["shouldStopAfterTurn"];
  streamFn?: StreamFnLike;
  /** Abort a turn whose model stream goes silent for this many ms. Undefined/0 disables. */
  streamIdleTimeoutMs?: number;
}

export class Agent {
  protected readonly state: AgentState;
  private readonly convertToLlm: ConvertToLlm;
  private readonly transformContext: TransformContext | null;
  private toolExecution: ToolExecutionMode;
  private readonly beforeToolCallHooks: { fn: BeforeToolCall }[] = [];
  private readonly afterToolCallHooks: { fn: AfterToolCall }[] = [];
  private readonly thinkingBudgets: Record<string, number> | null;
  private readonly maxTurns: number;
  public sessionId: string | null;
  private readonly streamOptions: Record<string, unknown> | null;
  private shouldStopAfterTurn: AgentLoopConfig["shouldStopAfterTurn"] | null;
  private readonly streamFn: StreamFnLike | null;
  private readonly streamIdleTimeoutMs: number | null;
  private readonly listeners: Listener[] = [];
  private controller: AbortController | null = null;
  private idleResolvers: (() => void)[] = [];
  private idle = true;

  constructor(opts: AgentOptions) {
    this.state = new AgentState({
      model: opts.model,
      systemPrompt: opts.systemPrompt ?? null,
      thinkingLevel: opts.thinkingLevel,
      tools: opts.tools,
      messages: opts.messages,
      steeringMode: opts.steeringMode,
      followUpMode: opts.followUpMode,
    });
    this.convertToLlm = opts.convertToLlm ?? defaultConvertToLlm;
    this.transformContext = opts.transformContext ?? null;
    this.toolExecution = opts.toolExecution ?? "parallel";
    if (opts.beforeToolCall) this.beforeToolCallHooks.push({ fn: opts.beforeToolCall });
    if (opts.afterToolCall) this.afterToolCallHooks.push({ fn: opts.afterToolCall });
    this.thinkingBudgets = opts.thinkingBudgets ?? null;
    this.maxTurns = opts.maxTurns ?? 50;
    this.sessionId = opts.sessionId ?? null;
    this.streamOptions = opts.streamOptions ?? null;
    this.shouldStopAfterTurn = opts.shouldStopAfterTurn ?? null;
    this.streamFn = opts.streamFn ?? null;
    this.streamIdleTimeoutMs = opts.streamIdleTimeoutMs ?? null;
  }

  get agentState(): AgentState {
    return this.state;
  }

  /** Clear the conversation + error; keep model, tools, system prompt. */
  reset(): void {
    this.state.messages = [];
    this.state.streamingMessage = null;
    this.state.errorMessage = null;
    this.state.pendingToolCalls.clear();
  }

  // --- PI-style mutators ---
  setToolExecution(mode: ToolExecutionMode): void {
    this.toolExecution = mode;
  }
  /** Append a before-hook to the ordered stack; returns a disposer that removes
   * exactly this registration (idempotent — safe to call twice, and safe when the
   * same fn is registered more than once). First hook returning block:true wins. */
  addBeforeToolCall(fn: BeforeToolCall): () => void {
    const entry = { fn };
    this.beforeToolCallHooks.push(entry);
    return () => {
      const i = this.beforeToolCallHooks.indexOf(entry);
      if (i >= 0) this.beforeToolCallHooks.splice(i, 1);
    };
  }
  /** Append an after-hook to the ordered stack; returns a disposer (same semantics
   * as addBeforeToolCall). Hooks fold: each sees the result as modified by the
   * previous hooks' returns; the composed return accumulates all modifications. */
  addAfterToolCall(fn: AfterToolCall): () => void {
    const entry = { fn };
    this.afterToolCallHooks.push(entry);
    return () => {
      const i = this.afterToolCallHooks.indexOf(entry);
      if (i >= 0) this.afterToolCallHooks.splice(i, 1);
    };
  }
  setSessionId(id: string | null): void {
    this.sessionId = id;
  }
  /** Install/replace the per-turn stop gate (e.g. a budget's running-sum closure). */
  setShouldStopAfterTurn(fn: AgentLoopConfig["shouldStopAfterTurn"] | null): void {
    this.shouldStopAfterTurn = fn;
  }

  // --- subscribe ---
  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private async dispatch(event: AgentEvent): Promise<void> {
    for (const listener of [...this.listeners]) {
      const result = listener(event);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        await result;
      }
    }
  }

  // --- prompting ---
  /** Run the loop with `content` appended as a user turn. Awaits completion. */
  async prompt(content: string | ContentBlock[] | Msg | Message[]): Promise<void> {
    await this.run(this.coercePrompts(content));
  }

  /** Resume from current context without a new user message. */
  async continueRun(): Promise<void> {
    if (this.state.messages.length) {
      const last = this.state.messages[this.state.messages.length - 1]!;
      if (last.role === "assistant") {
        throw new Error("continueRun() requires the last message to be user or toolResult");
      }
    }
    await this.run([]);
  }

  private async run(prompts: Message[]): Promise<void> {
    if (this.state.isStreaming) throw new Error("agent is already running");
    this.setIdle(false);
    this.state.isStreaming = true;
    this.state.errorMessage = null;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const config = this.buildConfig(controller.signal);
      for await (const event of agentLoop(prompts, this.state, config)) {
        await this.dispatch(event);
      }
      if (controller.signal.aborted && this.state.errorMessage === null) {
        this.state.errorMessage = "aborted";
      }
    } finally {
      this.controller = null;
      this.state.isStreaming = false;
      this.state.streamingMessage = null;
      this.setIdle(true);
    }
  }

  /** Cancel the in-flight run (if any). No-op when idle. */
  abort(): void {
    this.controller?.abort();
  }

  /** The in-flight run's AbortSignal (null when idle). Lets hooks (e.g. the plan
   * done-gate) make their own child processes cancellable by the same abort() that stops
   * the run — BeforeToolCallContext carries AgentState, not the loop config's signal. */
  get runSignal(): AbortSignal | null {
    return this.controller?.signal ?? null;
  }

  /** Await the current run's completion (for background-task usage). */
  async waitForIdle(): Promise<void> {
    if (this.idle) return;
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  // --- steering / follow-up ---
  steer(message: Msg | string): void {
    this.state.steering.push(this.asMessage(message));
  }
  followUp(message: Msg | string): void {
    this.state.followUp.push(this.asMessage(message));
  }
  clearSteeringQueue(): void {
    this.state.steering.length = 0;
  }
  clearFollowUpQueue(): void {
    this.state.followUp.length = 0;
  }
  clearAllQueues(): void {
    this.clearSteeringQueue();
    this.clearFollowUpQueue();
  }

  // --- internals ---
  // The loop accepts a single before/after closure; the Agent composes its ordered
  // stacks into one of each. Reads the live arrays at invocation time so hooks
  // registered or disposed mid-run take effect on the next tool call.
  private readonly composedBeforeToolCall: BeforeToolCall = async (ctx) => {
    for (const { fn } of [...this.beforeToolCallHooks]) {
      const decision = await fn(ctx);
      if (decision?.block) return decision;
    }
    return null;
  };

  private readonly composedAfterToolCall: AfterToolCall = async (ctx) => {
    let result = ctx.result;
    const acc: AfterToolCallResult = {};
    let any = false;
    for (const { fn } of [...this.afterToolCallHooks]) {
      const ar = await fn({ ...ctx, result });
      if (!ar) continue;
      any = true;
      if (ar.terminate) {
        acc.terminate = true;
        result = { ...result, terminate: true };
      }
      if (ar.details) {
        acc.details = { ...(acc.details ?? {}), ...ar.details };
        result = { ...result, details: { ...(result.details ?? {}), ...ar.details } };
      }
      if (ar.content) {
        acc.content = ar.content;
        result = { ...result, content: ar.content };
      }
    }
    return any ? acc : null;
  };

  private buildConfig(signal: AbortSignal): AgentLoopConfig {
    if (!this.state.model) throw new Error("model is required");
    return {
      model: this.state.model,
      convertToLlm: this.convertToLlm,
      toolExecution: this.toolExecution,
      beforeToolCall: this.composedBeforeToolCall,
      afterToolCall: this.composedAfterToolCall,
      transformContext: this.transformContext,
      shouldStopAfterTurn: this.shouldStopAfterTurn,
      thinkingBudgets: this.thinkingBudgets,
      thinkingLevel: this.state.thinkingLevel,
      maxTurns: this.maxTurns,
      sessionId: this.sessionId,
      streamFn: this.streamFn,
      streamOptions: this.streamOptions,
      signal,
      streamIdleTimeoutMs: this.streamIdleTimeoutMs,
    };
  }

  private asMessage(message: Msg | string): Msg {
    return typeof message === "string" ? new Msg({ role: "user", content: message }) : message;
  }

  private coercePrompts(content: string | ContentBlock[] | Msg | Message[]): Message[] {
    if (content instanceof Msg) return [content];
    if (typeof content === "string") return [new Msg({ role: "user", content })];
    if (Array.isArray(content)) {
      return content.map((item) =>
        item instanceof Msg ? item : new Msg({ role: "user", content: [item as ContentBlock] }),
      );
    }
    return [new Msg({ role: "user", content: content as ContentBlock[] })];
  }

  private setIdle(idle: boolean): void {
    this.idle = idle;
    if (idle) {
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const r of resolvers) r();
    }
  }
}
