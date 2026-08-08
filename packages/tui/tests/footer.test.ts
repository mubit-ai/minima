import { describe, expect, test } from "bun:test";
import { AssistantMessage, Message, Usage, text } from "../src/ai/index.ts";
import type { RunRow } from "../src/db/minima_db.ts";
import type { RehydratedRun } from "../src/db/rehydrate.ts";
import { chatFromMessages, resumeNotice } from "../src/tui/resume.ts";

// The footerStatsFromMessages describe moved to tests/context-meter.test.ts along with the
// module it covered: src/tui/footer.ts is gone, and its "one source of truth for the status
// bar's numbers" claim is now true of src/tui/context_meter.ts, which the auto-compaction
// trigger reads too.

const assistant = (input: number, output: number, model = "footer-test-model") =>
  new AssistantMessage({ content: [text("ok")], model, usage: new Usage({ input, output }) });
const user = (t: string) => new Message({ role: "user", content: t });

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
