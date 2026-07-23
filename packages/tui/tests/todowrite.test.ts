import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agent/index.ts";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  resetProviderRegistration,
  resetRegistry,
  text,
  toolCall,
} from "../src/ai/index.ts";
import { todowriteTool } from "../src/tools/todowrite.ts";

const resultText = (res: { content: { type: string; text?: string }[] }): string =>
  res.content.map((c) => c.text ?? "").join("\n");

const FAUX_MODEL: Model = {
  id: "faux",
  provider: "faux",
  api: "faux",
  name: "Faux",
  cost: { input: 0, output: 0 },
  context_window: 8192,
  max_tokens: 4096,
};

describe("todowrite tasks argument tolerance", () => {
  test("tasks as an actual array (model skipped the string encoding) is accepted", async () => {
    const tool = todowriteTool();
    const res = await tool.execute("t1", {
      tasks: [
        { content: "create line_counter.py", status: "completed", priority: "high" },
        { content: "add unit tests", status: "pending", priority: "medium" },
      ],
    });
    expect(resultText(res)).toContain("Todo list updated (1/2 done)");
    expect(resultText(res)).toContain("1. [x] ! create line_counter.py");
  });

  test("tasks as a JSON string keeps working", async () => {
    const tool = todowriteTool();
    const res = await tool.execute("t1", {
      tasks: JSON.stringify([{ content: "a", status: "pending", priority: "low" }]),
    });
    expect(resultText(res)).toContain("Todo list updated (0/1 done)");
  });

  test("a malformed JSON string still errors (the model retries)", async () => {
    const tool = todowriteTool();
    const res = await tool.execute("t1", { tasks: '[{"content":"a","status":"pending"' });
    expect(resultText(res)).toContain("Invalid JSON");
  });

  test("the malformed-JSON echo is a short labeled one-liner (R3a)", async () => {
    const tool = todowriteTool();
    const res = await tool.execute("t1", { tasks: `[{"content":\n${'"x",'.repeat(200)}` });
    const txt = resultText(res);
    expect(txt.startsWith("todowrite:")).toBe(true);
    expect(txt).not.toContain("\n");
    expect(txt.length).toBeLessThanOrEqual(160);
  });

  test("schema validation accepts an actual array for tasks (R3a)", () => {
    const parsed = todowriteTool().parameters.validate({
      tasks: [{ content: "a", status: "pending", priority: "low" }],
    });
    expect(parsed.ok).toBe(true);
  });
});

// R3a: the execute-level array tolerance was DEAD in production — the loop runs
// tool.parameters.validate BEFORE execute, and the schema said tasks:string, so an
// unencoded array errored "tasks: expected string" without ever reaching execute.
// Drive the REAL dispatch path (agentLoop → validate → execute) with array args.
describe("todowrite through the loop's validate+execute dispatch (R3a)", () => {
  test("array args survive schema validation and reach execute", async () => {
    resetRegistry();
    resetProviderRegistration();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [
          toolCall("c1", "todowrite", {
            tasks: [
              { content: "create line_counter.py", status: "completed", priority: "high" },
              { content: "add unit tests", status: "pending", priority: "medium" },
            ],
          }),
        ],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("done")] }),
    ]);
    const agent = new Agent({ model: reg.getModel(), tools: [todowriteTool()] });
    await agent.prompt("track it");
    const tr = agent.agentState.messages.find((m) => m.role === "toolResult")!;
    expect(tr.textContent).toContain("Todo list updated (1/2 done)");
    expect(tr.textContent).not.toContain("expected string");
    reg.unregister();
  });
});
