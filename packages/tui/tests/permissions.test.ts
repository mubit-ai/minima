import { describe, expect, test } from "bun:test";
import { checkPermission, createPermissionState } from "../src/tui/permissions.ts";

describe("checkPermission gating", () => {
  test("question is never gated — asking the user is not a side effect (no prompt)", async () => {
    const state = createPermissionState("/repo");
    let prompted = false;
    const res = await checkPermission("question", { question: "?" }, state, () => {
      prompted = true;
    });
    expect(res).toBeNull();
    expect(prompted).toBe(false);
  });

  test("glob/grep use the directory-scoped read prompt (like read/ls), not 'run <tool>'", async () => {
    for (const tool of ["glob", "grep"]) {
      const state = createPermissionState("/repo");
      let promptText = "";
      const res = await checkPermission(tool, { pattern: "*.ts", path: "src" }, state, (p) => {
        promptText = p.promptText;
        p.resolve("always");
      });
      expect(res).toBeNull();
      expect(promptText).toStartWith("read from");
      // once the directory is approved, a second scan of it is silent
      let prompted2 = false;
      const res2 = await checkPermission(tool, { pattern: "*.md", path: "src" }, state, () => {
        prompted2 = true;
      });
      expect(res2).toBeNull();
      expect(prompted2).toBe(false);
    }
  });

  test("a sensitive tool (bash) still prompts 'run <tool>' and can be denied", async () => {
    const state = createPermissionState("/repo");
    let promptText = "";
    const res = await checkPermission("bash", { command: "ls" }, state, (p) => {
      promptText = p.promptText;
      p.resolve("deny");
    });
    expect(promptText).toBe("run bash");
    expect(res?.block).toBe(true);
  });
});
