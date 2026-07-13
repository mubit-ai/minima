import { describe, expect, test } from "bun:test";
import { AssistantMessage, Message, type Model, Usage, attachCost, text } from "../src/ai/index.ts";
import { SESSION_START_TITLE, computeSections, sectionTitle } from "../src/session/sections.ts";

// Real per-Mtok price math via attachCost, like the live providers do.
const PRICED_MODEL: Model = {
  id: "priced",
  provider: "faux",
  api: "faux",
  name: "Priced",
  cost: { input: 3, output: 15 },
  context_window: 200_000,
  max_tokens: 8192,
};

function turn(input: number, output: number, content = "ok"): AssistantMessage {
  const usage = new Usage({ input, output });
  attachCost(PRICED_MODEL, usage);
  return new AssistantMessage({ content: [text(content)], model: PRICED_MODEL.id, usage });
}
const user = (t: string) => new Message({ role: "user", content: t });
const toolRes = (t: string, name = "bash") =>
  new Message({ role: "toolResult", content: t, tool_name: name });

describe("computeSections (U1.2)", () => {
  test("empty message list → no sections, zero totals", () => {
    const ledger = computeSections([]);
    expect(ledger.sections).toHaveLength(0);
    expect(ledger.totals).toEqual({ inputTokens: 0, outputTokens: 0, costUSD: 0 });
  });

  test("single section: multi-turn assistant usage sums until the next user prompt", () => {
    const ledger = computeSections([
      user("fix the bug"),
      turn(1000, 200),
      toolRes("exit 0"),
      turn(1500, 300),
    ]);
    expect(ledger.sections).toHaveLength(1);
    const s = ledger.sections[0]!;
    expect(s.title).toBe("fix the bug");
    expect(s.startMsgIdx).toBe(0);
    expect(s.endMsgIdx).toBe(3);
    expect(s.usage.inputTokens).toBe(2500);
    expect(s.usage.outputTokens).toBe(500);
    // (2500 × $3 + 500 × $15) / 1e6 — the same arithmetic attachCost/costFor uses.
    expect(s.usage.costUSD).toBeCloseTo(0.015, 12);
  });

  test("boundaries: every message index belongs to exactly one section; endMsgIdx inclusive", () => {
    const msgs = [user("one"), turn(10, 10), user("two"), toolRes("x"), turn(20, 20)];
    const { sections } = computeSections(msgs);
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => [s.startMsgIdx, s.endMsgIdx])).toEqual([
      [0, 1],
      [2, 4],
    ]);
    const covered = sections.flatMap((s) =>
      Array.from({ length: s.endMsgIdx - s.startMsgIdx + 1 }, (_, k) => s.startMsgIdx + k),
    );
    expect(covered).toEqual([0, 1, 2, 3, 4]);
  });

  test("cumulative is a running sum; ledger totals equal the last cumulative", () => {
    const { sections, totals } = computeSections([
      user("a"),
      turn(100, 10),
      user("b"),
      turn(200, 20),
      user("c"),
      turn(300, 30),
    ]);
    expect(sections[1]!.cumulative.inputTokens).toBe(300);
    expect(sections[2]!.cumulative.inputTokens).toBe(600);
    expect(sections[2]!.cumulative.costUSD).toBeCloseTo(
      sections.reduce((n, s) => n + s.usage.costUSD, 0),
      12,
    );
    expect(totals).toEqual(sections[2]!.cumulative);
  });

  test("consecutive user prompts (aborted turn) → zero-usage section, indices intact", () => {
    const { sections } = computeSections([user("first — aborted"), user("second"), turn(50, 5)]);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUSD: 0 });
    expect(sections[0]!.endMsgIdx).toBe(0);
    expect(sections[1]!.usage.inputTokens).toBe(50);
  });

  test("leading non-user messages form the '(session start)' section", () => {
    const { sections } = computeSections([turn(10, 1, "stray"), toolRes("y"), user("real start")]);
    expect(sections[0]!.title).toBe(SESSION_START_TITLE);
    expect(sections[0]!.startMsgIdx).toBe(0);
    expect(sections[0]!.endMsgIdx).toBe(1);
    expect(sections[0]!.usage.inputTokens).toBe(10);
    expect(sections[1]!.title).toBe("real start");
  });

  test("zero-usage assistant rows (legacy rehydrated) contribute 0, never NaN", () => {
    const bare = new AssistantMessage({ content: [text("no usage")] });
    const { sections, totals } = computeSections([user("q"), bare]);
    expect(sections[0]!.usage.costUSD).toBe(0);
    expect(Number.isFinite(totals.costUSD)).toBe(true);
    expect(Number.isFinite(totals.inputTokens)).toBe(true);
  });

  test("task toolResult text (child-agent $ report) never leaks into section sums", () => {
    const childReport = toolRes("subagent done. total_cost_usd: 0.42, tokens: 99999", "task");
    const { sections } = computeSections([user("delegate"), childReport, turn(100, 10)]);
    expect(sections[0]!.usage.inputTokens).toBe(100);
    expect(sections[0]!.usage.costUSD).toBeCloseTo((100 * 3 + 10 * 15) / 1e6, 12);
  });
});

describe("sectionTitle", () => {
  test("first line only, whitespace collapsed", () => {
    expect(sectionTitle("  fix   the\tbug\nsecond line ignored")).toBe("fix the bug");
  });

  test("ellipsized at titleMax, no trailing space before the ellipsis", () => {
    const long = "abcdefgh ".repeat(20);
    const t = sectionTitle(long, 10);
    expect(t.length).toBeLessThanOrEqual(10);
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toContain(" …");
  });

  test("short titles pass through untouched; titleMax opt respected by computeSections", () => {
    expect(sectionTitle("short")).toBe("short");
    const { sections } = computeSections([user("a very long prompt title indeed")], {
      titleMax: 12,
    });
    expect(sections[0]!.title.length).toBeLessThanOrEqual(12);
  });
});
