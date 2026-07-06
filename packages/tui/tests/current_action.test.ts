import { describe, expect, test } from "bun:test";
import { Agent, type AgentEvent, type AgentTool } from "../src/agent/index.ts";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  resetProviderRegistration,
  resetRegistry,
  text,
  toolCall,
} from "../src/ai/index.ts";
import {
  type ActiveAction,
  currentActionLine,
  reduceActiveActions,
} from "../src/tui/current_action.ts";

const FAUX_MODEL: Model = {
  id: "faux",
  provider: "faux",
  api: "faux",
  name: "Faux",
  cost: { input: 0, output: 0 },
  context_window: 8192,
  max_tokens: 4096,
};

// A no-op tool whose single arg maps to a clean action label (e.g. "ls: .").
function pathTool(name: string): AgentTool {
  return {
    name,
    description: `${name} a path`,
    parameters: {
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: [] },
      validate: (v) => ({ ok: true, value: (v ?? {}) as Record<string, unknown> }),
    },
    async execute() {
      return { content: [text(`${name} ran`)] };
    },
  };
}

// ---------------------------------------------------------------- pure reducer

describe("reduceActiveActions / currentActionLine", () => {
  const start = (id: string, toolName: string, args: unknown): AgentEvent =>
    ({ type: "tool_execution_start", toolCallId: id, toolName, args }) as AgentEvent;
  const end = (id: string): AgentEvent =>
    ({ type: "tool_execution_end", toolCallId: id, result: null, isError: false }) as AgentEvent;

  test("start adds a labelled action; end removes it by id", () => {
    let a: ActiveAction[] = [];
    a = reduceActiveActions(a, start("c1", "bash", { command: "git diff --stat" }));
    expect(currentActionLine(a)).toBe("⚙ bash: git diff --stat");
    a = reduceActiveActions(a, end("c1"));
    expect(currentActionLine(a)).toBe("");
  });

  test("parallel tools: newest is shown with a (+N more) suffix, cleared independently", () => {
    let a: ActiveAction[] = [];
    a = reduceActiveActions(a, start("c1", "ls", { path: "." }));
    a = reduceActiveActions(a, start("c2", "grep", { pattern: "TODO" }));
    expect(currentActionLine(a)).toBe("⚙ grep: TODO  (+1 more)");
    a = reduceActiveActions(a, end("c2")); // newest finishes first
    expect(currentActionLine(a)).toBe("⚙ ls: .");
    a = reduceActiveActions(a, end("c1"));
    expect(currentActionLine(a)).toBe("");
  });

  test("null args (unknown/invalid tool) fall back to the bare tool name", () => {
    const a = reduceActiveActions([], start("c1", "mystery", null));
    expect(currentActionLine(a)).toBe("⚙ mystery");
  });

  test("non-tool events pass through unchanged", () => {
    const a: ActiveAction[] = [{ id: "c1", label: "ls: ." }];
    expect(reduceActiveActions(a, { type: "turn_end" } as AgentEvent)).toEqual(a);
  });
});

// ---------------------------- end-to-end: real agent event stream -> footer line

describe("current-action line over a real Agent run (faux provider)", () => {
  function resetAll() {
    resetRegistry();
    resetProviderRegistration();
  }

  // Fold the live event stream exactly as app.tsx does, recording the footer line after each
  // event so we can prove it was shown DURING the tool call and cleared AFTER it.
  async function runAndTrace(
    responses: AssistantMessage[],
    tools: AgentTool[],
  ): Promise<{ lines: string[]; finalLine: string }> {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses(responses);
    const agent = new Agent({ model: reg.getModel(), tools });

    let actions: ActiveAction[] = [];
    const lines: string[] = [];
    agent.subscribe((e) => {
      actions = reduceActiveActions(actions, e);
      lines.push(currentActionLine(actions));
      return undefined;
    });
    await agent.prompt("go");
    reg.unregister();
    return { lines, finalLine: currentActionLine(actions) };
  }

  test("single tool: line shows while running, empty once the run ends", async () => {
    const { lines, finalLine } = await runAndTrace(
      [
        new AssistantMessage({
          content: [toolCall("c1", "ls", { path: "." })],
          stop_reason: "toolUse",
        }),
        new AssistantMessage({ content: [text("done")] }),
      ],
      [pathTool("ls")],
    );
    // It was visible at some point during the run...
    expect(lines).toContain("⚙ ls: .");
    // ...and the transcript-final state has cleared it.
    expect(finalLine).toBe("");
  });

  test("parallel tools in one turn: a (+N more) line appears, then clears", async () => {
    const { lines, finalLine } = await runAndTrace(
      [
        new AssistantMessage({
          content: [toolCall("c1", "ls", { path: "." }), toolCall("c2", "grep", { pattern: "x" })],
          stop_reason: "toolUse",
        }),
        new AssistantMessage({ content: [text("done")] }),
      ],
      [pathTool("ls"), pathTool("grep")],
    );
    expect(lines.some((l) => l.includes("(+1 more)"))).toBe(true);
    expect(finalLine).toBe("");
  });
});
