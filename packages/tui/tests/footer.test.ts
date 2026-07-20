import { describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  Message,
  type Model,
  Usage,
  registerModel,
  text,
} from "../src/ai/index.ts";
import type { RunRow } from "../src/db/minima_db.ts";
import type { RehydratedRun } from "../src/db/rehydrate.ts";
import { footerStatsFromMessages } from "../src/tui/footer.ts";
import { chatFromMessages, resumeNotice } from "../src/tui/resume.ts";

const WINDOW_MODEL: Model = {
  id: "footer-test-model",
  provider: "faux",
  api: "faux",
  name: "Footer Test",
  cost: { input: 1, output: 1 },
  context_window: 100_000,
  max_tokens: 4096,
};

const assistant = (input: number, output: number, model = WINDOW_MODEL.id) =>
  new AssistantMessage({ content: [text("ok")], model, usage: new Usage({ input, output }) });
const user = (t: string) => new Message({ role: "user", content: t });

describe("footerStatsFromMessages (B1.2)", () => {
  test("last assistant's tokens + ctx% from its model's registered window", () => {
    registerModel(WINDOW_MODEL);
    const stats = footerStatsFromMessages([
      user("q1"),
      assistant(10_000, 100),
      user("q2"),
      assistant(25_000, 500), // last one wins
    ]);
    expect(stats.inputTokens).toBe(25_000);
    expect(stats.outputTokens).toBe(500);
    expect(stats.ctxPct).toBeCloseTo(25, 6);
  });

  test("unregistered model falls back to the provided window", () => {
    const stats = footerStatsFromMessages([assistant(5_000, 50, "ghost-model")], 50_000);
    expect(stats.ctxPct).toBeCloseTo(10, 6);
    expect(stats.inputTokens).toBe(5_000);
  });

  test("zero-safety: no assistant / no window / zeroed usage → zeros, never NaN", () => {
    expect(footerStatsFromMessages([])).toEqual({ inputTokens: 0, outputTokens: 0, ctxPct: 0 });
    expect(footerStatsFromMessages([user("only a prompt")]).ctxPct).toBe(0);
    const noWindow = footerStatsFromMessages([assistant(5_000, 50, "ghost-model")]);
    expect(noWindow.ctxPct).toBe(0); // window unresolvable → 0, tokens still real
    expect(noWindow.inputTokens).toBe(5_000);
    const legacy = footerStatsFromMessages([new AssistantMessage({ content: [text("bare")] })]);
    expect(Number.isFinite(legacy.ctxPct)).toBe(true);
    expect(legacy.inputTokens).toBe(0);
  });
});

describe("resume helpers (B1)", () => {
  test("chatFromMessages maps user/assistant/toolResult incl. tool_name + is_error", () => {
    const chat = chatFromMessages([
      user("hello"),
      assistant(10, 10),
      new Message({ role: "toolResult", content: "boom", tool_name: "bash", is_error: true }),
    ]);
    expect(chat).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "ok" },
      { role: "tool", text: "boom", toolName: "bash", isError: true },
    ]);
  });

  test("resumeNotice prefers display_name, falls back to the id prefix", () => {
    const run = (display_name: string | null): RunRow => ({
      run_id: "0123456789abcdef",
      project_key: "p",
      provider_session_id: null,
      display_name,
      parent_run_id: null,
      git_base_sha: null,
      status: "done",
      created: 0,
      updated: 0,
    });
    const base: Omit<RehydratedRun, "run"> = {
      messages: [user("q"), assistant(1, 1)],
      meterRows: [],
      promptsRun: 1,
    };
    const named = resumeNotice({ ...base, run: run("demo") }, 0.1234);
    expect(named.text).toContain("Resumed run demo");
    expect(named.text).toContain("$0.1234");
    expect(named.text).toContain("2 msg(s)");
    const unnamed = resumeNotice({ ...base, run: run(null) }, 0);
    expect(unnamed.text).toContain("Resumed run 0123456789ab");
  });
});
