import { describe, expect, test } from "bun:test";
import {
  checkPermission,
  createPermissionState,
  denialReason,
  type PermissionPrompt,
} from "../src/tui/permissions.ts";

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

describe("denialReason (anti-sandbox-spiral copy)", () => {
  test("frames a decline as a user choice, not an environment restriction", () => {
    expect(denialReason("the bash call")).toBe(
      "The user declined the bash call — this is a user choice, not an environment " +
        "restriction or sandbox limit. Other tools remain available; do not retry the identical call.",
    );
  });

  test("carries the same framing for a read-access decline", () => {
    const reason = denialReason("read access to /repo/src");
    expect(reason).toContain("The user declined read access to /repo/src");
    expect(reason).toContain("not an environment restriction or sandbox limit");
    expect(reason).toContain("do not retry the identical call");
  });
});

describe("checkPermission denial reason reaches the block result", () => {
  // The block reason is what the agent loop feeds back to the model as the tool result
  // (agent/loop.ts errorResult), so drive a real decline through checkPermission and assert
  // the exact string the model receives.
  const decline = (prompt: PermissionPrompt) => prompt.resolve("deny");

  test("write/edit/bash decline yields the anti-spiral copy", async () => {
    const state = createPermissionState("/repo");
    const result = await checkPermission("bash", { command: "rm -rf /" }, state, decline);
    expect(result).toEqual({ block: true, reason: denialReason("the bash call") });
  });

  test("read/ls decline names the target dir with the same framing", async () => {
    const state = createPermissionState("/repo");
    const result = await checkPermission("ls", { path: "/repo/secrets" }, state, decline);
    expect(result).toEqual({
      block: true,
      reason: denialReason("read access to /repo/secrets"),
    });
    expect(result?.reason).toContain("do not retry the identical call");
  });
});
