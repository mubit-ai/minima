import { describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  Message,
  type Model,
  Usage,
  attachCost,
  text,
} from "../src/ai/index.ts";
import { computeSections } from "../src/session/sections.ts";
import type { ChatMessage } from "../src/tui/layout.ts";
import {
  TOC_SESSION_START,
  type TocUsage,
  buildSections,
  renderTocText,
  tocRows,
} from "../src/tui/toc.ts";

const user = (text: string): ChatMessage => ({ role: "user", text });
const assistant = (text: string): ChatMessage => ({ role: "assistant", text });
const tool = (toolName: string, text = "ok", isError = false): ChatMessage => ({
  role: "tool",
  text,
  toolName,
  isError,
});
const todo = (x: number, y: number): ChatMessage =>
  tool("todowrite", `Todo list updated (${x}/${y} done):\n1. [ ]   step`);

const LEDGER: TocUsage[] = [
  { tokens: 1000, costUSD: 0.01 },
  { tokens: 2000, costUSD: 0.02 },
];

describe("buildSections (U2 content)", () => {
  test("one section per real user prompt, anchored at its ChatMessage index", () => {
    const msgs = [user("first"), assistant("a1"), user("second"), assistant("a2")];
    const sections = buildSections(msgs, LEDGER);
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.startMsgIdx)).toEqual([0, 2]);
    expect(sections[0]!.title).toBe("first");
  });

  test("slash-command echoes never open sections; their output joins the previous one", () => {
    const msgs = [user("real prompt"), assistant("a"), user("/plan"), tool("plan", "Plan mode ON")];
    const sections = buildSections(msgs, LEDGER);
    expect(sections).toHaveLength(1);
    const toolsChild = sections[0]!.milestones.find((m) => m.kind === "tools");
    expect(toolsChild?.label).toContain("plan×1");
  });

  test("leading non-user content forms the '(session start)' section with zero usage", () => {
    const msgs = [tool("resume", "Resumed run demo"), user("go"), assistant("done")];
    const sections = buildSections(msgs, LEDGER);
    expect(sections[0]!.title).toBe(TOC_SESSION_START);
    expect(sections[0]!.usage).toEqual({ tokens: 0, costUSD: 0 });
    expect(sections[1]!.usage).toEqual(LEDGER[0]!); // prompt ordinals unaffected by the synthetic section
  });

  test("milestone ladder: first todowrite → created, x<y → updated, N/N → finalized", () => {
    const msgs = [user("plan it"), todo(0, 3), todo(1, 3), todo(3, 3)];
    const kinds = buildSections(msgs, LEDGER)[0]!.milestones.map((m) => m.kind);
    expect(kinds).toEqual(["plan-created", "plan-updated", "plan-finalized"]);
  });

  test("tools aggregate with counts + error flag; last assistant becomes the result child", () => {
    const msgs = [
      user("do it"),
      tool("bash"),
      tool("bash"),
      tool("edit", "boom", true),
      assistant("intermediate"),
      assistant("final answer"),
    ];
    const ms = buildSections(msgs, LEDGER)[0]!.milestones;
    const tools = ms.find((m) => m.kind === "tools")!;
    expect(tools.label).toContain("3 tools");
    expect(tools.label).toContain("bash×2");
    expect(tools.label).toContain("edit×1");
    expect(tools.isError).toBe(true);
    const result = ms.find((m) => m.kind === "result")!;
    expect(result.label).toBe("final answer");
    expect(ms.filter((m) => m.kind === "result")).toHaveLength(1);
  });

  test("usage joins by prompt ordinal; missing ledger rows → zeros; cumulative is a prefix sum", () => {
    const msgs = [user("p1"), assistant("a"), user("p2"), assistant("b"), user("p3")];
    const sections = buildSections(msgs, LEDGER); // only 2 ledger rows for 3 prompts
    expect(sections[0]!.usage).toEqual({ tokens: 1000, costUSD: 0.01 });
    expect(sections[1]!.usage).toEqual({ tokens: 2000, costUSD: 0.02 });
    expect(sections[2]!.usage).toEqual({ tokens: 0, costUSD: 0 });
    expect(sections[2]!.cumulative.tokens).toBe(3000);
    expect(sections[2]!.cumulative.costUSD).toBeCloseTo(0.03, 12);
  });
});

describe("tocRows / renderTocText (U2 render)", () => {
  const msgs = [user("first prompt"), assistant("answer one"), user("second prompt")];

  test("rows: titles are cursor stops; every row fits innerWidth; Σ footer totals the ledger", () => {
    const narrow = tocRows(buildSections(msgs, LEDGER), 30);
    const titles = narrow.filter((r) => r.isTitle);
    expect(titles).toHaveLength(2);
    expect(titles[0]!.text).toBe("▸ first prompt");
    for (const r of narrow) expect([...r.text].length).toBeLessThanOrEqual(30);
    expect(narrow[narrow.length - 1]!.text).toEndWith("…"); // Σ row clipped at 30 — never overflows
    const wide = tocRows(buildSections(msgs, LEDGER), 40);
    expect(wide[wide.length - 1]!.text).toContain("Σ $0.0300");
    expect(wide[wide.length - 1]!.text).toContain("(lead agent)");
  });

  test("text block: numbered sections with $ · tok, milestones indented, Σ line last", () => {
    const text = renderTocText(buildSections(msgs, LEDGER), 80);
    expect(text).toContain("1. first prompt — $0.0100 · 1000 tok");
    expect(text).toContain("2. second prompt — $0.0200 · 2000 tok");
    expect(text.trimEnd().split("\n").at(-1)).toContain("Σ $0.0300 · 3000 tok (lead agent)");
    expect(renderTocText([], 80)).toContain("(empty session)");
  });
});

// MUB-172: end-to-end through the app.tsx buildUsageLedger adapter — a booked web_search
// fee must show in that section's price line AND the Σ footer, not just token cost.
describe("web_search fees in the ToC (MUB-172)", () => {
  const PRICED: Model = {
    id: "priced",
    provider: "faux",
    api: "faux",
    name: "Priced",
    cost: { input: 3, output: 15 },
    context_window: 200_000,
    max_tokens: 8192,
  };

  test("a booked fee reaches the section price line and the Σ footer", () => {
    const usage = new Usage({ input: 1000, output: 200 });
    attachCost(PRICED, usage); // $0.0060 in tokens
    const agentMsgs = [
      new Message({ role: "user", content: "find docs" }),
      new AssistantMessage({ content: [text("searching")], model: PRICED.id, usage }),
      new Message({
        role: "toolResult",
        content: "[1] result",
        tool_name: "web_search",
        tool_call_id: "ws-1",
      }),
    ];
    // The exact adapter app.tsx uses: sections over the agent Message[] (+ the meter's
    // fee map), synthetic sections dropped, mapped to TocUsage by prompt ordinal.
    const ledger: TocUsage[] = computeSections(agentMsgs, {
      toolFees: new Map([["ws-1", 0.005]]),
    })
      .sections.filter((s) => agentMsgs[s.startMsgIdx]?.role === "user")
      .map((s) => ({
        tokens: s.usage.inputTokens + s.usage.outputTokens,
        costUSD: s.usage.costUSD,
      }));

    const chat: ChatMessage[] = [user("find docs"), tool("web_search"), assistant("done")];
    const rows = tocRows(buildSections(chat, ledger), 60);
    expect(rows.some((r) => r.text.includes("$0.0110"))).toBe(true); // section price line
    expect(rows[rows.length - 1]!.text).toContain("Σ $0.0110"); // footer
    expect(renderTocText(buildSections(chat, ledger), 80)).toContain("$0.0110");
  });
});

describe("failed-then-fixed section marker (MP19)", () => {
  test("an error milestone + a clean result marks the section title ⚠→✓", () => {
    const msgs = [
      user("build the step"),
      tool("todowrite", "blocked: Step not verified", true),
      tool("write"),
      tool("todowrite", "Todo list updated (1/1 done):\n1. [x] step"),
      assistant("done and verified"),
    ];
    const sections = buildSections(msgs, LEDGER);
    const title = tocRows(sections, 80).find((r) => r.isTitle)!;
    expect(title.text).toContain("⚠→✓");
    expect(renderTocText(sections, 80)).toContain("⚠→✓");
  });

  test("a still-failing section (errored result / no clean result) keeps only the ⚠", () => {
    const failing = buildSections(
      [user("try it"), tool("bash", "boom", true), assistant("could not finish")],
      LEDGER,
    );
    const cleanTitle = (msgs: ChatMessage[]) =>
      tocRows(buildSections(msgs, LEDGER), 80).find((r) => r.isTitle)!.text;
    expect(cleanTitle([user("ok run"), tool("bash"), assistant("fine")])).not.toContain("⚠→✓");
    const failingRows = tocRows(failing, 80);
    expect(failingRows.find((r) => r.isTitle)!.text).not.toContain("⚠→✓");
    expect(failingRows.some((r) => r.text.includes("⚠"))).toBe(true);
  });
});
