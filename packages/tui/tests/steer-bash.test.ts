import { describe, expect, test } from "bun:test";
import { Agent, type AgentEvent, AgentState, type AgentTool } from "../src/agent/index.ts";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  resetProviderRegistration,
  resetRegistry,
  text,
  toolCall,
} from "../src/ai/index.ts";
import { bashSteerDecision, makeBashSteerHook } from "../src/minima/bash_steer.ts";
import { configFromEnv, harnessConfig } from "../src/minima/index.ts";
import { bashTool } from "../src/tools/bash.ts";

const FAUX_MODEL: Model = {
  id: "faux",
  provider: "faux",
  api: "faux",
  name: "Faux",
  cost: { input: 0, output: 0 },
  context_window: 8192,
  max_tokens: 4096,
};

function resetAll() {
  resetRegistry();
  resetProviderRegistration();
}

function bashTurn(id: string, command: string): AssistantMessage {
  return new AssistantMessage({
    content: [toolCall(id, "bash", { command })],
    stop_reason: "toolUse",
  });
}

function doneTurn(): AssistantMessage {
  return new AssistantMessage({ content: [text("done")] });
}

function collect(agent: Agent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((e) => {
    events.push(e);
    return undefined;
  });
  return events;
}

function toolEnds(events: AgentEvent[]) {
  return events.filter(
    (e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
      e.type === "tool_execution_end",
  );
}

function spiedBash(): { tool: AgentTool; spawned: () => boolean } {
  const tool = bashTool();
  const inner = tool.execute;
  let spawned = false;
  tool.execute = async (...args) => {
    spawned = true;
    return inner(...args);
  };
  return { tool, spawned: () => spawned };
}

const GREP_STEER =
  "bash steer: `grep` was blocked before executing — use the native `grep` tool instead of " +
  "shelling out. It returns file:line matches, respects .gitignore, and bounds output. " +
  "Re-issue this as a `grep` tool call. Ordinary shell commands (builds, tests, git, " +
  "pipelines) are never blocked. (Opt out: MINIMA_TUI_STEER=0.)";

const CD_CAT_STEER =
  "bash steer: `cat` was blocked before executing — use the native `read` tool instead of " +
  "shelling out. read(offset, limit) pages any window with numbered, bounded output. " +
  "Re-issue this as a `read` tool call, resolving relative paths against `/x` (the `cd` " +
  "target). Ordinary shell commands (builds, tests, git, pipelines) are never blocked. " +
  "(Opt out: MINIMA_TUI_STEER=0.)";

describe("bashSteerDecision — blocking matrix", () => {
  const blocked: [string, string][] = [
    ["grep foo src/", "grep"],
    ["grep -r foo src/", "grep"],
    ["grep -e foo -e bar src/ lib/", "grep"],
    ["cat file.txt", "read"],
    ["cat -n file.txt", "read"],
    ["head -n 50 file.txt", "read"],
    ["head file.txt", "read"],
    ["tail app.log", "read"],
    ["tail -n 100 app.log", "read"],
    ["find . -name '*.ts'", "glob"],
    ["find . -type f -maxdepth 2 -iname '*.md'", "glob"],
    ["find src", "glob"],
    ["sed -i 's/a/b/' f.txt", "edit"],
    ["sed -i.bak 's/a/b/' f.txt", "edit"],
    ["sed --in-place 's/a/b/' f.txt", "edit"],
  ];
  for (const [cmd, tool] of blocked) {
    test(`blocks: ${JSON.stringify(cmd)} -> ${tool}`, () => {
      const d = bashSteerDecision(cmd);
      expect(d).not.toBeNull();
      expect(d!.block).toBe(true);
      expect(d!.nativeTool).toBe(tool);
      expect(d!.reason.startsWith("bash steer:")).toBe(true);
      expect(d!.reason).toContain(`\`${tool}\` tool`);
      expect(d!.reason).toContain("(Opt out: MINIMA_TUI_STEER=0.)");
    });
  }

  test("blocks: the grep steer message is pinned verbatim", () => {
    expect(bashSteerDecision("grep foo src/")!.reason).toBe(GREP_STEER);
  });
});

describe("bashSteerDecision — pass-through (negative matrix)", () => {
  const passThrough: string[] = [
    "make test",
    "git status",
    "git grep foo",
    "bun test tests/steer-bash.test.ts",
    "grep foo",
    "grep foo src/ | wc -l",
    'grep "a|b" src/',
    "grep foo src/ > out.txt",
    "grep foo src/\nmake test",
    "make build && make test",
    "echo done; grep foo src/",
    "echo `grep foo src/`",
    "echo $(grep foo src/)",
    "cat a.txt b.txt",
    "cat",
    "cat <<EOF",
    "cat f > g",
    "head",
    "tail -f server.log",
    "tail --follow server.log",
    "find . -name '*.o' -delete",
    "find . -name x -exec cat {} +",
    "find /tmp -newer ref",
    "sed 's/a/b/' f.txt",
    "sed -n 5p f",
    "FOO=1 grep foo src/",
    "/usr/bin/grep foo src/",
    "bash scripts/dev.sh grep foo",
    "",
    "   ",
  ];
  for (const cmd of passThrough) {
    test(`pass-through: ${JSON.stringify(cmd)}`, () => {
      expect(bashSteerDecision(cmd)).toBeNull();
    });
  }
});

describe("bashSteerDecision — cd-extraction (cd <path> && <simple command>)", () => {
  const blocked: [string, string, string][] = [
    ["cd /x && cat f", "read", "/x"],
    ["cd src && grep foo lib/", "grep", "src"],
    ["cd /tmp/logs && tail -n 100 app.log", "read", "/tmp/logs"],
    ["cd a/b.c && head -n 5 f.txt", "read", "a/b.c"],
    ["cd pkg && find . -name '*.ts'", "glob", "pkg"],
    ["cd pkg && sed -i 's/a/b/' f.txt", "edit", "pkg"],
    ["cd /x&&cat f", "read", "/x"],
  ];
  for (const [cmd, tool, path] of blocked) {
    test(`blocks: ${JSON.stringify(cmd)} -> ${tool} @ ${path}`, () => {
      const d = bashSteerDecision(cmd);
      expect(d).not.toBeNull();
      expect(d!.block).toBe(true);
      expect(d!.nativeTool).toBe(tool);
      expect(d!.reason).toContain(`resolving relative paths against \`${path}\``);
      expect(d!.reason).toContain("(the `cd` target)");
      expect(d!.reason).toContain("(Opt out: MINIMA_TUI_STEER=0.)");
    });
  }

  test("blocks: the cd+cat steer message is pinned verbatim", () => {
    expect(bashSteerDecision("cd /x && cat f")!.reason).toBe(CD_CAT_STEER);
  });

  const passThrough: string[] = [
    "cd /x && make build",
    "cd /x && git status",
    "cd /x && bun test",
    "cd /x && cat f && make test",
    "cd /x && cat f | wc -l",
    "cd /x && cat f > g",
    "cd /x && cat a.txt b.txt",
    "cd /x && grep foo",
    "cd /x && FOO=1 cat f",
    "cd /x && /usr/bin/cat f",
    'cd "$DIR" && cat f',
    "cd $HOME && cat f",
    "cd ~/proj && cat f",
    "cd 'my dir' && cat f",
    "cd my dir && cat f",
    "cd -P /x && cat f",
    "cd - && cat f",
    "cd && cat f",
    "cd /x &&",
    "cd /x & cat f",
    "cd /x &&& cat f",
    "cd /x || cat f",
    "cd /x; cat f",
    "cd /x\ncat f",
    "cd\n/x && cat f",
    "pushd /x && cat f",
    "cd /x && cd /y && cat f",
    "echo hi && cat f",
  ];
  for (const cmd of passThrough) {
    test(`pass-through: ${JSON.stringify(cmd)}`, () => {
      expect(bashSteerDecision(cmd)).toBeNull();
    });
  }
});

describe("bash-steer hook — dispatcher enforcement", () => {
  test("blocks: bash('grep foo src/') never spawns and returns the steer as a tool error", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([bashTurn("b1", "grep foo src/"), doneTurn()]);
    const { tool, spawned } = spiedBash();
    const agent = new Agent({ model: reg.getModel(), tools: [tool] });
    agent.addBeforeToolCall(makeBashSteerHook(harnessConfig()));

    const events = collect(agent);
    await agent.prompt("go");

    const ends = toolEnds(events);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.isError).toBe(true);
    const body = (ends[0]!.result?.content[0] as { text: string }).text;
    expect(body).toBe(GREP_STEER);
    expect(spawned()).toBe(false);
    reg.unregister();
  });

  test("blocks: bash('cd /x && cat f') never spawns and the steer carries the cd path", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([bashTurn("b1", "cd /x && cat f"), doneTurn()]);
    const { tool, spawned } = spiedBash();
    const agent = new Agent({ model: reg.getModel(), tools: [tool] });
    agent.addBeforeToolCall(makeBashSteerHook(harnessConfig()));

    const events = collect(agent);
    await agent.prompt("go");

    const ends = toolEnds(events);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.isError).toBe(true);
    const body = (ends[0]!.result?.content[0] as { text: string }).text;
    expect(body).toBe(CD_CAT_STEER);
    expect(spawned()).toBe(false);
    reg.unregister();
  });

  test("pass-through: an ordinary command executes to [exit 0]", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([bashTurn("b1", "echo untouched"), doneTurn()]);
    const { tool, spawned } = spiedBash();
    const agent = new Agent({ model: reg.getModel(), tools: [tool] });
    agent.addBeforeToolCall(makeBashSteerHook(harnessConfig()));

    const events = collect(agent);
    await agent.prompt("go");

    const ends = toolEnds(events);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.isError).toBe(false);
    const body = (ends[0]!.result?.content[0] as { text: string }).text;
    expect(body).toContain("untouched");
    expect(body).toContain("[exit 0]");
    expect(spawned()).toBe(true);
    reg.unregister();
  });

  test("pass-through: the hook keys on the bash tool name, never on other tools' args", async () => {
    const hook = makeBashSteerHook(harnessConfig());
    const decision = await hook({
      toolCall: { type: "toolCall", id: "x1", name: "grep", arguments: {} },
      args: { command: "grep foo src/" },
      context: new AgentState(),
    });
    expect(decision).toBeNull();
  });

  test("pass-through: a non-string command is never analyzed", async () => {
    const hook = makeBashSteerHook(harnessConfig());
    const decision = await hook({
      toolCall: { type: "toolCall", id: "x1", name: "bash", arguments: {} },
      args: { command: 42 },
      context: new AgentState(),
    });
    expect(decision).toBeNull();
  });
});

describe("bash-steer flag", () => {
  test("flag: steer=false lets the same grep call execute; flipping it back re-blocks (call-time)", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      bashTurn("b1", "grep foo src/"),
      doneTurn(),
      bashTurn("b2", "grep foo src/"),
      doneTurn(),
    ]);
    const { tool, spawned } = spiedBash();
    const cfg = harnessConfig({ steer: false });
    const agent = new Agent({ model: reg.getModel(), tools: [tool] });
    agent.addBeforeToolCall(makeBashSteerHook(cfg));
    const events = collect(agent);

    await agent.prompt("go");
    expect(spawned()).toBe(true);
    expect(toolEnds(events)[0]!.isError).toBe(false);

    cfg.steer = true;
    await agent.prompt("again");
    const ends = toolEnds(events);
    expect(ends).toHaveLength(2);
    expect(ends[1]!.isError).toBe(true);
    expect((ends[1]!.result?.content[0] as { text: string }).text).toBe(GREP_STEER);
    reg.unregister();
  });

  test("flag: configFromEnv respects MINIMA_TUI_STEER (default ON, =0 opts out)", () => {
    const prev = process.env.MINIMA_TUI_STEER;
    try {
      delete process.env.MINIMA_TUI_STEER;
      expect(configFromEnv().steer).toBe(true);
      process.env.MINIMA_TUI_STEER = "0";
      expect(configFromEnv().steer).toBe(false);
      process.env.MINIMA_TUI_STEER = "1";
      expect(configFromEnv().steer).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MINIMA_TUI_STEER;
      else process.env.MINIMA_TUI_STEER = prev;
    }
  });

  test("flag: harnessConfig defaults steer to true", () => {
    expect(harnessConfig().steer).toBe(true);
  });
});
