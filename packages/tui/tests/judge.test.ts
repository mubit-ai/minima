import { describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
} from "../src/ai/index.ts";
import { LLMJudge, parseScore } from "../src/minima/judge.ts";

const JUDGE_MODEL: Model = {
  id: "judge-faux",
  provider: "faux",
  api: "faux",
  name: "Judge Faux",
  cost: { input: 1, output: 1 },
  context_window: 8192,
  max_tokens: 512,
};

function setup() {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(JUDGE_MODEL);
  return registerFauxProvider([JUDGE_MODEL]);
}

describe("LLMJudge hardening (live-E2E finding: one transient flake dropped the signal)", () => {
  test("retries a transient provider error once and scores on the second attempt", async () => {
    const reg = setup();
    reg.setResponses([
      new AssistantMessage({
        content: [text("")],
        stop_reason: "error",
        error_message: "Request timed out.",
      }),
      new AssistantMessage({ content: [text("8")] }),
    ]);
    const judge = new LLMJudge(JUDGE_MODEL);
    const score = await judge.grade("task", "output");
    expect(score).toBeCloseTo(0.8, 5);
    expect(judge.lastAbstainReason).toBeNull();
    expect(reg.state.callCount).toBe(2); // used the retry
    reg.unregister();
  });

  test("a well-formed non-score reply is a legitimate abstention — NO retry", async () => {
    const reg = setup();
    reg.setResponses([
      new AssistantMessage({ content: [text("I cannot responsibly grade this response.")] }),
      new AssistantMessage({ content: [text("9")] }), // must never be consumed
    ]);
    const judge = new LLMJudge(JUDGE_MODEL);
    expect(await judge.grade("task", "output")).toBeNull();
    expect(judge.lastAbstainReason).toContain("unparseable");
    expect(reg.state.callCount).toBe(1); // no retry on legitimate abstention
    reg.unregister();
  });

  test("abstains with the reason kept when every attempt fails", async () => {
    const reg = setup();
    reg.setResponses([
      new AssistantMessage({ content: [text("")], stop_reason: "error", error_message: "boom 1" }),
      new AssistantMessage({ content: [text("")], stop_reason: "error", error_message: "boom 2" }),
    ]);
    const judge = new LLMJudge(JUDGE_MODEL);
    expect(await judge.grade("task", "output")).toBeNull();
    expect(judge.lastAbstainReason).toBe("boom 2");
    expect(reg.state.callCount).toBe(2);
    reg.unregister();
  });

  test("retries=0 disables the retry", async () => {
    const reg = setup();
    reg.setResponses([
      new AssistantMessage({ content: [text("")], stop_reason: "error", error_message: "boom" }),
    ]);
    const judge = new LLMJudge(JUDGE_MODEL, { retries: 0 });
    expect(await judge.grade("task", "output")).toBeNull();
    expect(reg.state.callCount).toBe(1);
    reg.unregister();
  });
});

describe("parseScore", () => {
  test("parses bare integers and clamps range upstream", () => {
    expect(parseScore("8")).toBe(8);
    expect(parseScore(" 10 ")).toBe(10);
    expect(parseScore("no score here")).toBeNull();
  });
});
