import { describe, expect, test } from "bun:test";
import type { QuestionParams } from "../src/tools/question.ts";
import { questionTool } from "../src/tools/question.ts";

describe("question tool", () => {
  test("description forbids the chat-channel misuse (2026-07-20: gemini greeted via the tool)", () => {
    const tool = questionTool({ current: null });
    expect(tool.description).toContain("NEVER use this tool to greet");
    expect(tool.description).toContain("plain reply, not this tool");
    expect(tool.description).toContain("genuinely blocked by ambiguity");
  });

  test("a degenerate greeting-shaped call still executes cleanly (never crash the turn)", async () => {
    const seen: QuestionParams[] = [];
    const tool = questionTool({
      current: async (p) => {
        seen.push(p);
        return null; // user dismisses the pointless overlay
      },
    });
    const parsed = tool.parameters.validate({
      question: "Hi! What can I help you with today?",
      header: "",
      options: [],
      allow_freetext: true,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = await tool.execute("q1", parsed.value);
    expect(seen.length).toBe(1);
    expect(seen[0]?.options).toEqual([]);
    expect(result.details?.answered).toBe(false);
  });
});
