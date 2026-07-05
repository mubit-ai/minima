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
import {
  JUDGE_SYSTEM,
  LLMJudge,
  buildJudgeUser,
  midTruncate,
  parseScore,
} from "../src/minima/judge.ts";

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

  test("'X out of 10' yields X, not 10 (last-number fallback bug)", () => {
    expect(parseScore("I'd give it a 7 out of 10.")).toBe(7);
    expect(parseScore("2 out of 10 — mostly wrong")).toBe(2);
    expect(parseScore("10/10")).toBe(10); // slash form still works
    expect(parseScore("Score: 8")).toBe(8);
  });
});

describe("judge prompt hardening (live prompt-bench findings)", () => {
  test("empty/whitespace output scores 0 without spending a judge call", async () => {
    // Live finding: grading "" made the judge score the TASK text (an 8 was observed).
    const reg = setup();
    reg.setResponses([new AssistantMessage({ content: [text("9")] })]); // must never be consumed
    const judge = new LLMJudge(JUDGE_MODEL);
    expect(await judge.grade("list the primes", "")).toBe(0);
    expect(await judge.grade("list the primes", "   \n\t ")).toBe(0);
    expect(judge.lastAbstainReason).toBeNull(); // a real score, not an abstention
    expect(reg.state.callCount).toBe(0);
    reg.unregister();
  });

  test("midTruncate keeps both ends and marks the cut", () => {
    expect(midTruncate("short", 4000)).toBe("short");
    const long = `HEAD-MARKER ${"x".repeat(10_000)} TAIL-MARKER`;
    const cut = midTruncate(long, 4000);
    expect(cut).toContain("HEAD-MARKER");
    expect(cut).toContain("TAIL-MARKER");
    expect(cut).toMatch(/\[\.\.\. \d+ chars truncated \.\.\.\]/);
    expect(cut.length).toBeLessThan(4100); // cap + marker line only
  });

  test("buildJudgeUser delimits the response and preserves tail-of-task requirements", () => {
    const task = `${"filler ".repeat(1000)}\nCRITICAL: the answer must be 'blue'.`;
    const user = buildJudgeUser(task, "red", { rubric: "exactness matters" });
    expect(user).toContain("<response>\nred\n</response>");
    expect(user).toContain("CRITICAL: the answer must be 'blue'."); // tail survives the cap
    expect(user).toContain("RUBRIC:\nexactness matters");
  });

  test("JUDGE_SYSTEM declares the response untrusted", () => {
    expect(JUDGE_SYSTEM).toContain("UNTRUSTED");
    expect(JUDGE_SYSTEM).toContain("<response>");
  });
});
