import { describe, expect, test } from "bun:test";

import { normalizeForTarget } from "../src/ai/compat.ts";
import { Message, image, text } from "../src/ai/types.ts";

function toolResult(id: string, body: string, withImage = false): Message {
  return new Message({
    role: "toolResult",
    content: withImage ? [text(body), image("AAAA", "image/png")] : [text(body)],
    tool_call_id: id,
    tool_name: "read",
  });
}

const user = (t: string) => new Message({ role: "user", content: [text(t)] });
const assistant = (t: string) => new Message({ role: "assistant", content: [text(t)] });

const isHoisted = (m: Message) =>
  m.role === "user" && m.textContent.includes("[image output from the preceding tool result");

describe("normalizeForTarget — tool-result image hoisting", () => {
  test("anthropic is the identity: it can nest an image in tool_result", () => {
    const msgs = [user("look"), assistant("ok"), toolResult("t1", "[image] x.png", true)];
    const out = normalizeForTarget(msgs, "anthropic-messages");
    expect(out).toBe(msgs);
    expect(out[2]?.content.some((b) => b.type === "image")).toBe(true);
  });

  test("a list with no tool-result images is returned by reference", () => {
    const msgs = [user("hi"), assistant("hello"), toolResult("t1", "plain")];
    expect(normalizeForTarget(msgs, "openai-completions")).toBe(msgs);
    expect(normalizeForTarget(msgs, "google-generative-ai")).toBe(msgs);
  });

  test("an image in a USER message is untouched — no double hoist", () => {
    const msgs = [new Message({ role: "user", content: [text("see"), image("BBBB")] })];
    expect(normalizeForTarget(msgs, "openai-completions")).toBe(msgs);
  });

  // The transcript array is shared live with the DB sink, the TUI and compaction. A rewrite
  // that mutated it would corrupt all three.
  test("hoisting never mutates the input", () => {
    const msgs = [assistant("calling"), toolResult("t1", "[image] x.png", true)];
    const before = JSON.parse(JSON.stringify(msgs));
    normalizeForTarget(msgs, "openai-completions");
    expect(JSON.parse(JSON.stringify(msgs))).toEqual(before);
    expect(msgs[1]?.content.some((b) => b.type === "image")).toBe(true);
  });

  test("the image moves into ONE synthetic user message after the tool result", () => {
    const msgs = [assistant("calling"), toolResult("t1", "[image] x.png", true)];
    const out = normalizeForTarget(msgs, "openai-completions");
    expect(out).toHaveLength(3);
    expect(out[1]?.role).toBe("toolResult");
    expect(out[1]?.content.some((b) => b.type === "image")).toBe(false);
    expect(out[1]?.textContent).toBe("[image] x.png");
    expect(isHoisted(out[2] as Message)).toBe(true);
    expect(out[2]?.content.filter((b) => b.type === "image")).toHaveLength(1);
  });

  // OpenAI requires every role:"tool" message to sit in an unbroken run right after the
  // assistant message that carried the tool_calls. A synthetic user message inserted
  // BETWEEN two tool results would break the association for the later one.
  test("a run of tool results yields exactly one synthetic message, after the whole run", () => {
    const msgs = [
      assistant("calling two"),
      toolResult("t1", "[image] a.png", true),
      toolResult("t2", "[image] b.png", true),
    ];
    const out = normalizeForTarget(msgs, "openai-completions");
    expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult", "user"]);
    expect(out.filter(isHoisted)).toHaveLength(1);
    expect(out[3]?.content.filter((b) => b.type === "image")).toHaveLength(2);
  });

  test("a plain tool result inside a run passes through by reference", () => {
    const plain = toolResult("t2", "just text");
    const msgs = [assistant("x"), toolResult("t1", "[image] a.png", true), plain];
    const out = normalizeForTarget(msgs, "google-generative-ai");
    expect(out[2]).toBe(plain);
    expect(out).toHaveLength(4);
  });

  test("runs are maximal, not global: an assistant between them splits the hoist", () => {
    const msgs = [
      assistant("one"),
      toolResult("t1", "[image] a.png", true),
      assistant("two"),
      toolResult("t2", "[image] b.png", true),
    ];
    const out = normalizeForTarget(msgs, "openai-completions");
    expect(out.filter(isHoisted)).toHaveLength(2);
    expect(out.map((m) => m.role)).toEqual([
      "assistant",
      "toolResult",
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);
  });

  test("a tool result left empty after stripping gets a placeholder body", () => {
    const bare = new Message({
      role: "toolResult",
      content: [image("CCCC", "image/webp")],
      tool_call_id: "t1",
    });
    const out = normalizeForTarget([assistant("x"), bare], "openai-completions");
    expect(out[1]?.content).toHaveLength(1);
    expect(out[1]?.textContent).toBe("[image]");
  });

  test("the rewritten tool result keeps its identity fields", () => {
    const src = new Message({
      role: "toolResult",
      content: [text("body"), image("DDDD", "image/jpeg")],
      tool_call_id: "call_42",
      tool_name: "read",
      is_error: true,
    });
    const out = normalizeForTarget([assistant("x"), src], "openai-completions");
    expect(out[1]?.tool_call_id).toBe("call_42");
    expect(out[1]?.tool_name).toBe("read");
    expect(out[1]?.is_error).toBe(true);
  });
});
