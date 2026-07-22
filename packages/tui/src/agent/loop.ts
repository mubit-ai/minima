/**
 * The agent loop — a port of PI's agentLoop async generator.
 *
 * Runs turn after turn: stream the model -> emit message events -> if it requested
 * tools, execute them (parallel via Promise.all, with before/afterToolCall hooks)
 * -> append tool results -> continue. Steering/follow-up queues are drained between
 * turns. Emits the full PI event taxonomy so any subscriber can render the run.
 */

import { stream as defaultStream } from "../ai/stream.ts";
import { AssistantMessage, Message, text } from "../ai/types.ts";
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
    if (config.signal?.aborted) break;
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
    // Watchdog: a silent stream must never pin the turn open forever. The provider
    // gets a composed signal so an idle timeout also tears down its HTTP request;
    // config.signal stays the pure user signal so the catch below still classifies
    // Esc as `aborted` while StreamIdleTimeoutError propagates as an error.
    const idleMs = config.streamIdleTimeoutMs ?? 0;
    const watchdog = idleMs > 0 ? new AbortController() : null;
    const streamSignal = watchdog
      ? config.signal
        ? AbortSignal.any([config.signal, watchdog.signal])
        : watchdog.signal
      : (config.signal ?? undefined);
    const s = streamFn(state.model, ctx, { options, signal: streamSignal });
    yield messageStart(null);
    let aborted = false;
    let partialText = "";
    const source = watchdog ? withIdleTimeout(s, idleMs, () => watchdog.abort()) : s;
    try {
      // Race each stream step against the abort signal so Esc stops the run
      // instantly — without this, `for await` only checks between chunks and a
      // mid-token or slow-first-token stream keeps going after abort.
      for await (const streamEvent of raceAbort(source, config.signal ?? undefined)) {
        if ((streamEvent as { type?: string }).type === "text_delta") {
          partialText += (streamEvent as { delta?: string }).delta ?? "";
        }
        yield messageUpdate(streamEvent as never);
      }
    } catch (err) {
      if (config.signal?.aborted) aborted = true;
      else throw err;
    }
    if (aborted) {
      // Commit a well-formed assistant turn so history stays user→assistant→user.
      // Without this the aborted turn leaves a dangling user message; the NEXT
      // prompt then appends a second user message, the provider merges the two,
      // and the model answers both. Text-only (never partial tool calls, which
      // would dangle without a tool_result and 400 the provider).
      const marker = partialText ? `${partialText}\n\n[aborted by user]` : "[aborted by user]";
      const stub = new AssistantMessage({
        content: [text(marker)],
        model: state.model.id,
        stop_reason: "aborted",
      });
      state.messages.push(stub);
      state.streamingMessage = null;
      state.errorMessage = "aborted";
      yield messageEnd(stub);
      break;
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

const abortError = (): DOMException => new DOMException("Aborted", "AbortError");

/**
 * Yield from an async iterable, but reject the instant `signal` aborts — even if
 * the underlying stream is blocked awaiting its next chunk. Each `.next()` races
 * an abort promise, so Esc interrupts a mid-token or slow-first-token stream
 * immediately instead of waiting for the next chunk to arrive.
 */
async function* raceAbort<T>(
  iterable: AsyncIterable<T>,
  signal: AbortSignal | undefined,
): AsyncGenerator<T> {
  if (signal?.aborted) throw abortError();
  const it = iterable[Symbol.asyncIterator]();
  try {
    for (;;) {
      // Re-check every iteration: the signal may have aborted while we were
      // suspended at a `yield` (e.g. a listener called abort() during dispatch),
      // in which case addEventListener('abort') below would never fire again.
      if (signal?.aborted) throw abortError();
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<never>((_, reject) => {
        if (!signal) return;
        onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
      });
      let res: IteratorResult<T>;
      try {
        res = await Promise.race([it.next(), abortPromise]);
      } finally {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      }
      if (res.done) return;
      yield res.value;
    }
  } finally {
    // Best-effort: close the source iterator so the provider generator's
    // finally-block (and any open HTTP request) is torn down.
    if (typeof it.return === "function") {
      try {
        await it.return();
      } catch {
        // ignore teardown errors
      }
    }
  }
}

/**
 * Thrown when the model stream emits nothing for `idleMs` — the stall that once pinned
 * `busy` true all night (spinner pumping frames into a sleeping terminal, 43 GB RSS).
 * The "idle timeout" wording deliberately matches failure_kind's TRANSIENT_RE: a stall
 * is an infra fault, so feedback is suppressed — never charged to the model — and the
 * recovery ladder may retry, bounding worst-case surface time to (1+recoveryRungs)×idleMs.
 */
export class StreamIdleTimeoutError extends Error {
  readonly idleMs: number;
  constructor(idleMs: number) {
    super(
      `stream stalled — no data for ${Math.round(idleMs / 1000)}s (idle timeout); turn aborted`,
    );
    this.name = "StreamIdleTimeoutError";
    this.idleMs = idleMs;
  }
}

const IDLE = Symbol("idle-timeout");

/**
 * Yield from an async iterable, but throw {@link StreamIdleTimeoutError} if `idleMs`
 * passes with no event — each `.next()` races a fresh timer, so the clock resets on
 * every event. `onTimeout` runs first on the timeout path: abort the provider's
 * composed signal there so the underlying HTTP request is torn down.
 */
export async function* withIdleTimeout<T>(
  iterable: AsyncIterable<T>,
  idleMs: number,
  onTimeout?: () => void,
): AsyncGenerator<T> {
  const it = iterable[Symbol.asyncIterator]();
  let timedOut = false;
  try {
    for (;;) {
      const next = it.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<typeof IDLE>((resolve) => {
        timer = setTimeout(() => resolve(IDLE), idleMs);
      });
      let winner: IteratorResult<T> | typeof IDLE;
      try {
        winner = await Promise.race([next, idle]);
      } finally {
        clearTimeout(timer);
      }
      if (winner === IDLE) {
        timedOut = true;
        // The losing next() may still reject once the provider signal aborts below;
        // swallow it so the late rejection never surfaces as unhandled.
        next.catch(() => {});
        onTimeout?.();
        // Fire-and-forget teardown — NEVER await it here: a native async generator's
        // return() queues behind the pending next(), so awaiting would re-pin the
        // turn on the stalled stream — the very bug this watchdog removes.
        void Promise.resolve(it.return?.()).catch(() => {});
        throw new StreamIdleTimeoutError(idleMs);
      }
      if (winner.done) return;
      yield winner.value;
    }
  } finally {
    // Normal completion / user abort: awaited best-effort close, mirroring raceAbort.
    // The timeout path already closed fire-and-forget above (awaiting would hang).
    if (!timedOut && typeof it.return === "function") {
      try {
        await it.return();
      } catch {
        // ignore teardown errors
      }
    }
  }
}

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
    opts.thinking_level = config.thinkingLevel;
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
    // A throwing after-hook must not unwind the batch: with Promise.all a single throw
    // rejected the whole executeToolCalls pass BEFORE any completion entry ran its
    // pendingToolCalls.delete, leaking the ids for the rest of the session (hooks are
    // bookkeeping; enforcement lives in beforeToolCall).
    try {
      const ar = await config.afterToolCall({
        toolCall: p.tc,
        result,
        isError,
        context: state,
      } satisfies AfterToolCallContext);
      if (ar) {
        if (ar.terminate) result = { ...result, terminate: true };
        if (ar.details)
          result = { ...result, details: { ...(result.details ?? {}), ...ar.details } };
        if (ar.content) result = { ...result, content: ar.content };
      }
    } catch {
      // degrade to the raw tool result
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
