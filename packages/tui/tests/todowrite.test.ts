import { describe, expect, test } from "bun:test";
import { todowriteTool } from "../src/tools/todowrite.ts";

const resultText = (res: { content: { type: string; text?: string }[] }): string =>
  res.content.map((c) => c.text ?? "").join("\n");

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
});
