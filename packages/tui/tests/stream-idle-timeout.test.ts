/**
 * Stream inactivity watchdog (memory-leak guardrail): a model stream that goes silent
 * mid-turn must abort the turn instead of pinning `busy` true forever (the overnight
 * 43 GB RSS incident). User Esc keeps its own `aborted` classification, 0 disables,
 * and the timer resets on every event. The error message deliberately classifies as
 * transient (failure_kind's TRANSIENT_RE) so the recovery ladder treats a stall as
 * infra, never as model quality.
 */

import { describe, expect, test } from "bun:test";
import { Agent, StreamIdleTimeoutError, withIdleTimeout } from "../src/agent/index.ts";
import type { StreamFnLike } from "../src/agent/index.ts";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  resetProviderRegistration,
  resetRegistry,
  text,
  textDelta,
} from "../src/ai/index.ts";
import { isTransientError } from "../src/minima/failure_kind.ts";

const FAUX_MODEL: Model = {
  id: "faux",
  provider: "faux",
  api: "faux",
  name: "Faux",
  cost: { input: 0, output: 0 },
  context_window: 8192,
  max_tokens: 4096,
};

function resetAll() {
  resetRegistry();
  resetProviderRegistration();
}

/** One delta, then a silent stall until the iterator is torn down. */
function stalledStreamFn(record: { returned: boolean; signal?: AbortSignal }): StreamFnLike {
  return (_model, _ctx, opts) => {
    record.signal = opts?.signal;
    let calls = 0;
    const iter = {
      async next(): Promise<IteratorResult<unknown>> {
        calls += 1;
        if (calls === 1) return { done: false, value: textDelta("hi", 0) };
        await new Promise<never>(() => {}); // silent mid-turn stall
        return { done: true, value: undefined };
      },
      async return(): Promise<IteratorResult<unknown>> {
        record.returned = true;
        return { done: true, value: undefined };
      },
    };
    return {
      result: async () => new AssistantMessage({ content: [text("unused")] }),
      [Symbol.asyncIterator]: () => iter,
    };
  };
}

describe("stream idle timeout watchdog", () => {
  test("a stalled stream aborts the turn: throw, iterator teardown, provider signal aborted", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    const record: { returned: boolean; signal?: AbortSignal } = { returned: false };

    const agent = new Agent({
      model: reg.getModel(),
      streamFn: stalledStreamFn(record),
      streamIdleTimeoutMs: 50,
    });

    await expect(agent.prompt("go")).rejects.toThrow(/stream stalled/);
    expect(record.returned).toBe(true); // provider iterator torn down (HTTP request killed)
    expect(record.signal?.aborted).toBe(true); // composed watchdog signal reached the provider
    reg.unregister();
  });

  test("user Esc is not a stall — still classifies as `aborted`, no throw", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    const record: { returned: boolean; signal?: AbortSignal } = { returned: false };

    let agent: Agent;
    agent = new Agent({
      model: reg.getModel(),
      streamFn: stalledStreamFn(record),
      streamIdleTimeoutMs: 10_000,
    });
    agent.subscribe((e) => {
      if (e.type === "message_update") agent.abort();
      return undefined;
    });

    // Resolves (no rejection): the pure user signal keeps its abort classification.
    await agent.prompt("go");
    expect(agent.agentState.errorMessage).toBe("aborted");
    reg.unregister();
  });

  test("0 disables the watchdog — a hanging stream stays pending", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    const record: { returned: boolean; signal?: AbortSignal } = { returned: false };

    const agent = new Agent({
      model: reg.getModel(),
      streamFn: stalledStreamFn(record),
      streamIdleTimeoutMs: 0,
    });

    const pending = agent.prompt("go");
    const sentinel = Symbol("still-pending");
    const winner = await Promise.race([
      pending.then(() => "settled" as const),
      new Promise<typeof sentinel>((r) => setTimeout(() => r(sentinel), 150)),
    ]);
    expect(winner).toBe(sentinel); // no idle timeout fired
    agent.abort(); // cleanup: resolve via the user-abort path
    await pending;
    expect(agent.agentState.errorMessage).toBe("aborted");
    reg.unregister();
  });

  test("the idle timer resets on every event (not cumulative)", async () => {
    // 5 events at 30 ms gaps = 150 ms total, but no single gap reaches idleMs 80.
    async function* slow(): AsyncGenerator<number> {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 30));
        yield i;
      }
    }
    const seen: number[] = [];
    for await (const v of withIdleTimeout(slow(), 80)) seen.push(v);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  test("the error message classifies as transient (infra, never charged to the model)", () => {
    const err = new StreamIdleTimeoutError(1000);
    expect(err.idleMs).toBe(1000);
    expect(err.message).toContain("idle timeout");
    expect(isTransientError(err.message)).toBe(true);
  });
});
