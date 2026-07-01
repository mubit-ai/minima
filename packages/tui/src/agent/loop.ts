/**
 * The agent loop — a port of PI's agentLoop async generator.
 *
 * Runs turn after turn: stream the model -> emit message events -> if it requested
 * tools, execute them (parallel via Promise.all, with before/afterToolCall hooks)
 * -> append tool results -> continue. Steering/follow-up queues are drained between
 * turns. Emits the full PI event taxonomy so any subscriber can render the run.
 */

import { stream as defaultStream } from "../ai/stream.ts";
import { AssistantMessage, Message } from "../ai/types.ts";
import type { Context, Tool, ToolCall } from "../ai/types.ts";
import {
  type AgentEvent,
  agentEnd,
  agentStart,
  messageEnd,
  messageStart,
  messageUpdate,
  toolExecutionEnd,
  toolExecutionStart,
  toolExecutionUpdate,
  turnEnd,
  turnStart,
} from "./events.ts";
import type { AgentLoopConfig, AgentState, QueueMode } from "./state.ts";
import {
  type AfterToolCallContext,
  type BeforeToolCallContext,
  type ToolResult,
  errorResult,
  findAgentTool,
} from "./tools.ts";

interface PendingTool {
  tc: ToolCall;
  tool: NonNullable<ReturnType<typeof findAgentTool>>;
  params: Record<string, unknown>;
}

interface Completion {
  tc: ToolCall;
  updates: AgentEvent[];
  result: ToolResult;
  isError: boolean;
}

/**
 * Run the agent over `prompts` appended to `state`, yielding AgentEvents.
 */
export async function* agentLoop(
  prompts: Message[],
  state: AgentState,
  config: AgentLoopConfig,
): AsyncGenerator<AgentEvent> {
  if (!state.model) throw new Error("AgentState.model must be set before running the loop");

  yield agentStart();

  for (const prompt of prompts) {
    state.messages.push(prompt);
    yield messageStart(prompt);
    yield messageEnd(prompt);
  }

  const streamFn = config.streamFn ?? (defaultStream as NonNullable<AgentLoopConfig["streamFn"]>);
  let turns = 0;
  while (turns < config.maxTurns) {
    turns += 1;
    yield turnStart();

    const llmMessages = await prepareMessages(state, config);
    const ctx: Context = {
      system_prompt: state.systemPrompt ?? undefined,
      messages: llmMessages,
      tools: state.tools.map(
        (t): Tool => ({ name: t.name, description: t.description, parameters: t.parameters }),
      ),
    };
    const options = streamOptions(config);
    const s = streamFn(state.model, ctx, { options, signal: config.signal ?? undefined });
    yield messageStart(null);
    for await (const streamEvent of s) {
      yield messageUpdate(streamEvent as never);
    }
    const assistant = await s.result();
    state.streamingMessage = assistant;
    state.messages.push(assistant);
    yield messageEnd(assistant);

    if (assistant.stop_reason === "error") {
      state.errorMessage = assistant.error_message ?? "provider error";
      yield turnEnd(assistant, []);
      break;
    }

    const toolCalls = assistant.stop_reason === "toolUse" ? assistant.toolCalls : [];
    const results: { tc: ToolCall; result: ToolResult; isError: boolean }[] = [];
    if (toolCalls.length) {
      for await (const ev of executeToolCalls(toolCalls, config, state, results)) {
        yield ev;
      }
      for (const { tc, result, isError } of results) {
        const tr = new Message({
          role: "toolResult",
          tool_call_id: tc.id,
          tool_name: tc.name,
          content: result.content,
          is_error: isError,
        });
        state.messages.push(tr);
        yield messageStart(tr);
        yield messageEnd(tr);
      }
    }

    yield turnEnd(
      assistant,
      results.map((r) => r.result),
    );

    if (results.length && results.every((r) => r.result.terminate)) break;
    if (config.shouldStopAfterTurn) {
      const stop = await config.shouldStopAfterTurn(
        assistant,
        results.map((r) => r.result),
        state,
        state.messages,
      );
      if (stop) break;
    }

    const injected = popQueue(state.steering, state.steeringMode);
    if (injected.length) {
      for (const m of injected) {
        state.messages.push(m);
        yield messageStart(m);
        yield messageEnd(m);
      }
      continue;
    }

    if (!toolCalls.length) {
      const fu = popQueue(state.followUp, state.followUpMode);
      if (fu.length) {
        for (const m of fu) {
          state.messages.push(m);
          yield messageStart(m);
          yield messageEnd(m);
        }
        continue;
      }
      break;
    }
  }

  state.turnsTaken = turns;
  state.streamingMessage = null;
  yield agentEnd([...state.messages]);
}

/** Resume from existing context (last message must be user or toolResult). */
export async function* agentLoopContinue(
  state: AgentState,
  config: AgentLoopConfig,
): AsyncGenerator<AgentEvent> {
  if (state.messages.length) {
    const last = state.messages[state.messages.length - 1]!;
    if (last.role === "assistant") {
      throw new Error("agentLoopContinue requires the last message to be user or toolResult");
    }
  }
  yield* agentLoop([], state, config);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Never send a failed call's assistant to a provider (empty text blocks 400). */
function dropFailedCalls(messages: Message[]): Message[] {
  return messages.filter((m) => !(m instanceof AssistantMessage && m.stop_reason === "error"));
}

async function prepareMessages(state: AgentState, config: AgentLoopConfig): Promise<Message[]> {
  let messages = dropFailedCalls(state.messages);
  if (config.transformContext) {
    messages = await config.transformContext(messages, config.signal);
  }
  return config.convertToLlm(messages);
}

function streamOptions(config: AgentLoopConfig): Record<string, unknown> {
  const opts: Record<string, unknown> = { ...(config.streamOptions ?? {}) };
  opts.thinking = config.thinkingLevel !== "off";
  if (config.thinkingLevel !== "off") {
    const budget = config.thinkingBudgets?.[config.thinkingLevel];
    if (budget !== undefined) opts.thinking_budget = budget;
  }
  if (config.sessionId) opts.session_id = config.sessionId;
  return opts;
}

async function* executeToolCalls(
  toolCalls: ToolCall[],
  config: AgentLoopConfig,
  state: AgentState,
  outResults: { tc: ToolCall; result: ToolResult; isError: boolean }[],
): AsyncGenerator<AgentEvent> {
  const plan: PendingTool[] = [];
  for (const tc of toolCalls) {
    state.pendingToolCalls.add(tc.id);
    const tool = findAgentTool(state.tools, tc.name);
    if (!tool) {
      yield toolExecutionStart(tc.id, tc.name, null);
      const res = errorResult(`Unknown tool: ${tc.name}`);
      yield toolExecutionEnd(tc.id, res, true);
      outResults.push({ tc, result: res, isError: true });
      state.pendingToolCalls.delete(tc.id);
      continue;
    }
    const parsed = tool.parameters.validate(tc.arguments);
    if (!parsed.ok) {
      yield toolExecutionStart(tc.id, tc.name, null);
      const res = errorResult(parsed.errors.join("; "));
      yield toolExecutionEnd(tc.id, res, true);
      outResults.push({ tc, result: res, isError: true });
      state.pendingToolCalls.delete(tc.id);
      continue;
    }
    yield toolExecutionStart(tc.id, tc.name, parsed.value);
    if (config.beforeToolCall) {
      const decision = await config.beforeToolCall({
        toolCall: tc,
        args: parsed.value,
        context: state,
      } satisfies BeforeToolCallContext);
      if (decision?.block) {
        const res = errorResult(decision.reason || "blocked by beforeToolCall");
        yield toolExecutionEnd(tc.id, res, true);
        outResults.push({ tc, result: res, isError: true });
        state.pendingToolCalls.delete(tc.id);
        continue;
      }
    }
    plan.push({ tc, tool, params: parsed.value });
  }

  const sequential =
    config.toolExecution === "sequential" ||
    plan.some((p) => p.tool.executionMode === "sequential");

  const completion: Completion[] = [];
  const runOne = (p: PendingTool) => runOneTool(p, config, state, completion);

  if (sequential) {
    for (const p of plan) await runOne(p);
  } else {
    await Promise.all(plan.map(runOne));
  }

  const byId = new Map<string, { tc: ToolCall; result: ToolResult; isError: boolean }>();
  for (const c of completion) {
    for (const upd of c.updates) yield upd;
    yield toolExecutionEnd(c.tc.id, c.result, c.isError);
    state.pendingToolCalls.delete(c.tc.id);
    byId.set(c.tc.id, { tc: c.tc, result: c.result, isError: c.isError });
  }
  for (const { tc } of plan) {
    const entry = byId.get(tc.id);
    if (entry) outResults.push(entry);
  }
}

async function runOneTool(
  p: PendingTool,
  config: AgentLoopConfig,
  state: AgentState,
  completion: Completion[],
): Promise<void> {
  const updates: AgentEvent[] = [];
  const onUpdate = (partial: unknown) => {
    updates.push(toolExecutionUpdate(p.tc.id, partial));
  };

  let result: ToolResult;
  let isError: boolean;
  try {
    result = await p.tool.execute(p.tc.id, p.params, config.signal, onUpdate);
    isError = false;
  } catch (exc) {
    result = errorResult(String(exc));
    isError = true;
  }

  if (config.afterToolCall) {
    const ar = await config.afterToolCall({
      toolCall: p.tc,
      result,
      isError,
      context: state,
    } satisfies AfterToolCallContext);
    if (ar) {
      if (ar.terminate) result = { ...result, terminate: true };
      if (ar.details) result = { ...result, details: { ...(result.details ?? {}), ...ar.details } };
      if (ar.content) result = { ...result, content: ar.content };
    }
  }

  // Append in completion order (Promise.all preserves resolution order per-runner).
  completion.push({ tc: p.tc, updates, result, isError });
}

function popQueue(queue: Message[], mode: QueueMode): Message[] {
  if (!queue.length) return [];
  if (mode === "one-at-a-time") {
    const first = queue.shift();
    return first ? [first] : [];
  }
  const drained = [...queue];
  queue.length = 0;
  return drained;
}
