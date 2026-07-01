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
}

export class Agent {
  protected readonly state: AgentState;
  private readonly convertToLlm: ConvertToLlm;
  private readonly transformContext: TransformContext | null;
  private toolExecution: ToolExecutionMode;
  private beforeToolCallHook: BeforeToolCall | null;
  private afterToolCallHook: AfterToolCall | null;
  private readonly thinkingBudgets: Record<string, number> | null;
  private readonly maxTurns: number;
  public sessionId: string | null;
  private readonly streamOptions: Record<string, unknown> | null;
  private readonly shouldStopAfterTurn: AgentLoopConfig["shouldStopAfterTurn"] | null;
  private readonly streamFn: StreamFnLike | null;
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
    this.beforeToolCallHook = opts.beforeToolCall ?? null;
    this.afterToolCallHook = opts.afterToolCall ?? null;
    this.thinkingBudgets = opts.thinkingBudgets ?? null;
    this.maxTurns = opts.maxTurns ?? 50;
    this.sessionId = opts.sessionId ?? null;
    this.streamOptions = opts.streamOptions ?? null;
    this.shouldStopAfterTurn = opts.shouldStopAfterTurn ?? null;
    this.streamFn = opts.streamFn ?? null;
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
  setBeforeToolCall(fn: BeforeToolCall | null): void {
    this.beforeToolCallHook = fn;
  }
  setAfterToolCall(fn: AfterToolCall | null): void {
    this.afterToolCallHook = fn;
  }
  setSessionId(id: string | null): void {
    this.sessionId = id;
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
  private buildConfig(signal: AbortSignal): AgentLoopConfig {
    if (!this.state.model) throw new Error("model is required");
    return {
      model: this.state.model,
      convertToLlm: this.convertToLlm,
      toolExecution: this.toolExecution,
      beforeToolCall: this.beforeToolCallHook,
      afterToolCall: this.afterToolCallHook,
      transformContext: this.transformContext,
      shouldStopAfterTurn: this.shouldStopAfterTurn,
      thinkingBudgets: this.thinkingBudgets,
      thinkingLevel: this.state.thinkingLevel,
      maxTurns: this.maxTurns,
      sessionId: this.sessionId,
      streamFn: this.streamFn,
      streamOptions: this.streamOptions,
      signal,
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
