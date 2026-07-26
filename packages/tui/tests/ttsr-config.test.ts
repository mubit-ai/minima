/**
 * W4.2 / MUB-204 — TTSR flag default, cap override, and off byte-identity (AC3).
 */

import { describe, expect, test } from "bun:test";
import { Agent, type Model, type StreamFnLike } from "../src/agent/index.ts";
import { AssistantMessage, text, textDelta } from "../src/ai/index.ts";
import { configFromEnv, harnessConfig } from "../src/minima/config.ts";
import { compileTtsr } from "../src/minima/ttsr.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const MODEL: Model = {
  id: "faux",
  provider: "faux",
  api: "faux",
  name: "Faux",
  cost: { input: 0, output: 0 },
  context_window: 8192,
  max_tokens: 4096,
};

function cleanStreamFn(): StreamFnLike {
  return () => {
    let done = false;
    const iter = {
      async next(): Promise<IteratorResult<unknown>> {
        if (done) return { done: true, value: undefined };
        done = true;
        return { done: false, value: textDelta("ok", 0) };
      },
      async return(): Promise<IteratorResult<unknown>> {
        return { done: true, value: undefined };
      },
    };
    return {
      result: async () => new AssistantMessage({ content: [text("ok")], model: "faux" }),
      [Symbol.asyncIterator]: () => iter,
    };
  };
}

describe("AC3 TTSR flag default + plumbing + off byte-identity", () => {
  test("ttsr defaults OFF (opt-in)", () => {
    expect(harnessConfig().ttsr).toBe(false);
    withEnv({ MINIMA_TUI_TTSR: undefined, MINIMA_TUI_EXPERIMENTAL: undefined }, () => {
      expect(configFromEnv().ttsr).toBe(false);
    });
  });

  test("MINIMA_TUI_TTSR=1 opts in; the umbrella opts in; an explicit =0 wins", () => {
    withEnv({ MINIMA_TUI_TTSR: "1", MINIMA_TUI_EXPERIMENTAL: undefined }, () => {
      expect(configFromEnv().ttsr).toBe(true);
    });
    withEnv({ MINIMA_TUI_TTSR: undefined, MINIMA_TUI_EXPERIMENTAL: "1" }, () => {
      expect(configFromEnv().ttsr).toBe(true);
    });
    withEnv({ MINIMA_TUI_TTSR: "0", MINIMA_TUI_EXPERIMENTAL: "1" }, () => {
      expect(configFromEnv().ttsr).toBe(false);
    });
  });

  test("MINIMA_TUI_TTSR_CAP parses a non-negative integer; unset leaves 0", () => {
    withEnv({ MINIMA_TUI_TTSR_CAP: undefined }, () => {
      expect(configFromEnv().ttsrCap).toBe(0);
    });
    withEnv({ MINIMA_TUI_TTSR_CAP: "3" }, () => {
      expect(configFromEnv().ttsrCap).toBe(3);
    });
    withEnv({ MINIMA_TUI_TTSR_CAP: "-1" }, () => {
      expect(configFromEnv().ttsrCap).toBe(0);
    });
  });

  test("ttsr:null produces the identical committed-message set as flag-off", async () => {
    const run = async (withNull: boolean) => {
      const agent = new Agent({
        model: MODEL,
        streamFn: cleanStreamFn(),
        ...(withNull ? { ttsr: null } : {}),
      });
      await agent.prompt("go");
      return agent.agentState.messages.map((m) => `${m.role}:${m.textContent}`);
    };
    expect(await run(true)).toEqual(await run(false));
  });

  test("compileTtsr(DEFAULT_TTSR_RULES) is installable and arms a fresh matcher", () => {
    const controller = compileTtsr([{ id: "x", pattern: /never/, reminder: "r" }]);
    const matcher = controller.arm();
    expect(matcher.test("nothing here")).toBeNull();
  });
});
