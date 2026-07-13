import { describe, expect, test } from "bun:test";
import {
  type PermissionPrompt,
  checkPermission,
  createPermissionState,
  denialReason,
  formatActionLabel,
  formatToolArgs,
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
        "restriction or sandbox limit. Do not retry the call and do not attempt the same action through other tools; continue without it or ask the user how to proceed.",
    );
  });

  test("carries the same framing for a read-access decline", () => {
    const reason = denialReason("read access to /repo/src");
    expect(reason).toContain("The user declined read access to /repo/src");
    expect(reason).toContain("not an environment restriction or sandbox limit");
    expect(reason).toContain("do not attempt the same action through other tools");
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
    expect(result?.reason).toContain("do not attempt the same action through other tools");
  });
});

describe("formatToolArgs", () => {
  test("summarizes each builtin tool by its primary arg", () => {
    expect(formatToolArgs("bash", { command: "git diff --stat" })).toBe("git diff --stat");
    expect(formatToolArgs("read", { path: "src/app.tsx" })).toBe("src/app.tsx");
    expect(formatToolArgs("ls", {})).toBe(".");
    expect(formatToolArgs("write", { path: "out.txt" })).toBe("out.txt");
    expect(formatToolArgs("edit", { path: "a.ts" })).toBe("a.ts");
  });

  test("covers grep and glob via their pattern arg", () => {
    expect(formatToolArgs("grep", { pattern: "TODO", path: "src" })).toBe("TODO in src");
    expect(formatToolArgs("glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  test("falls back to JSON for unknown tools", () => {
    expect(formatToolArgs("mystery", { a: 1 })).toBe('{"a":1}');
  });
});

describe("formatActionLabel", () => {
  test("prefixes the tool name and a compact arg summary", () => {
    expect(formatActionLabel("bash", { command: "git diff --stat" })).toBe("bash: git diff --stat");
    expect(formatActionLabel("grep", { pattern: "needle" })).toBe("grep: needle");
  });

  test("falls back to the bare tool name when args are null (unknown/invalid tool)", () => {
    expect(formatActionLabel("bash", null)).toBe("bash");
    expect(formatActionLabel("whatever", undefined)).toBe("whatever");
  });

  test("uses the bare tool name when the arg summary is empty", () => {
    expect(formatActionLabel("bash", { command: "" })).toBe("bash");
  });
});

// ---------------------------------------------------------------- B2: plan-mode force-prompt

import { BUILD_BUNDLE, PLAN_BUNDLE } from "../src/agent/modes.ts";
import { type GuardEvent, onGuardEvent } from "../src/agent/policy.ts";
import type { AgentState } from "../src/agent/state.ts";
import type { BeforeToolCallContext } from "../src/agent/tools.ts";
import { makeModeGatedBeforeToolCall } from "../src/tui/permissions.ts";

function editCtx(): BeforeToolCallContext {
  return {
    toolCall: { type: "toolCall", id: "tc-1", name: "edit", arguments: {} },
    args: { filePath: "src/x.ts", old_string: "a", new_string: "b" },
    context: {} as AgentState, // the factory never reads it
  };
}

describe("checkPermission forcePrompt (B2 plan-mode ask)", () => {
  test("prompts even when allowAlways contains the tool", async () => {
    const state = createPermissionState("/repo");
    state.allowAlways.add("bash");
    let prompt: PermissionPrompt | null = null;
    const res = checkPermission(
      "bash",
      { command: "ls" },
      state,
      (p) => {
        prompt = p;
        p.resolve("allow");
      },
      { forcePrompt: true, promptTextPrefix: "plan mode — asks every time: " },
    );
    expect(await res).toBeNull();
    expect(prompt!.promptText).toBe("plan mode — asks every time: run bash");
  });

  test("'always' records the grant, but the next forced call still prompts", async () => {
    const state = createPermissionState("/repo");
    let prompts = 0;
    const ask = () =>
      checkPermission(
        "edit",
        { filePath: "x" },
        state,
        (p) => {
          prompts += 1;
          p.resolve("always");
        },
        { forcePrompt: true },
      );
    await ask();
    expect(state.allowAlways.has("edit")).toBe(true); // pays off in build mode…
    await ask();
    expect(prompts).toBe(2); // …but the mode rule keeps outranking it
  });

  test("deny under forcePrompt blocks with the anti-spiral copy", async () => {
    const state = createPermissionState("/repo");
    const res = await checkPermission("write", { path: "x" }, state, (p) => p.resolve("deny"), {
      forcePrompt: true,
    });
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("user choice");
  });
});

describe("makeModeGatedBeforeToolCall (B2)", () => {
  test("edit in plan mode → forced prompt + mode-ask GuardEvent", async () => {
    const state = createPermissionState("/repo");
    state.allowAlways.add("edit"); // must NOT short-circuit in plan mode
    const events: GuardEvent[] = [];
    const offGuard = onGuardEvent((e) => events.push(e));
    let promptText = "";
    const hook = makeModeGatedBeforeToolCall({
      state,
      promptFn: (p) => {
        promptText = p.promptText;
        p.resolve("allow");
      },
      getBundle: () => PLAN_BUNDLE,
    });
    expect(await hook(editCtx())).toBeNull();
    expect(promptText).toBe("plan mode — asks every time: run edit");
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("mode-ask");
    expect(events[0]!.detail).toContain("edit");
    offGuard();
  });

  test("edit in build mode with an 'always' grant → silent allow, promptFn never called", async () => {
    const state = createPermissionState("/repo");
    state.allowAlways.add("edit");
    let prompted = false;
    const hook = makeModeGatedBeforeToolCall({
      state,
      promptFn: () => {
        prompted = true;
      },
      getBundle: () => BUILD_BUNDLE,
    });
    expect(await hook(editCtx())).toBeNull();
    expect(prompted).toBe(false);
  });

  test("an explicit deny rule blocks with the policy reason — no prompt, no guard event", async () => {
    const state = createPermissionState("/repo");
    const events: GuardEvent[] = [];
    const offGuard = onGuardEvent((e) => events.push(e));
    let prompted = false;
    const hook = makeModeGatedBeforeToolCall({
      state,
      promptFn: () => {
        prompted = true;
      },
      getBundle: () => ({
        name: "locked",
        rules: [{ tool: "edit", pattern: "*", action: "deny" }],
      }),
    });
    const res = await hook(editCtx());
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("locked mode policy");
    expect(prompted).toBe(false);
    expect(events).toHaveLength(0);
    offGuard();
  });
});

describe("makeModeGatedBeforeToolCall — auto (accept-edits / bypass)", () => {
  test("edit in acceptEdits mode → runs with NO prompt + mode-auto GuardEvent", async () => {
    const { ACCEPT_EDITS_BUNDLE } = await import("../src/agent/modes.ts");
    const state = createPermissionState("/repo");
    const events: GuardEvent[] = [];
    const offGuard = onGuardEvent((e) => events.push(e));
    let prompted = false;
    const hook = makeModeGatedBeforeToolCall({
      state,
      promptFn: () => {
        prompted = true;
      },
      getBundle: () => ACCEPT_EDITS_BUNDLE,
    });
    expect(await hook(editCtx())).toBeNull();
    expect(prompted).toBe(false); // no "always" grant needed — the mode pre-approved it
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("mode-auto");
    offGuard();
  });

  test("bash in acceptEdits mode keeps the NORMAL flow (prompts without a grant)", async () => {
    const { ACCEPT_EDITS_BUNDLE } = await import("../src/agent/modes.ts");
    const state = createPermissionState("/repo");
    let prompted = false;
    const hook = makeModeGatedBeforeToolCall({
      state,
      promptFn: (p) => {
        prompted = true;
        p.resolve("deny");
      },
      getBundle: () => ACCEPT_EDITS_BUNDLE,
    });
    const res = await hook({
      toolCall: { name: "bash" },
      args: { command: "rm -rf /tmp/x" },
    } as never);
    expect(prompted).toBe(true);
    expect(res?.block).toBe(true);
  });

  test("bash in bypass mode runs with no prompt", async () => {
    const { BYPASS_BUNDLE } = await import("../src/agent/modes.ts");
    const state = createPermissionState("/repo");
    let prompted = false;
    const hook = makeModeGatedBeforeToolCall({
      state,
      promptFn: () => {
        prompted = true;
      },
      getBundle: () => BYPASS_BUNDLE,
    });
    const res = await hook({
      toolCall: { name: "bash" },
      args: { command: "echo hi" },
    } as never);
    expect(res).toBeNull();
    expect(prompted).toBe(false);
  });
});
