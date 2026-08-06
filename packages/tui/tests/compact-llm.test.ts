import { describe, expect, test } from "bun:test";
import { AssistantMessage, Message, type Model, text } from "../src/ai/index.ts";
import type { MinimaAgent } from "../src/minima/runtime.ts";
import { TTSR_REMINDER_PREFIX } from "../src/minima/ttsr.ts";
import type { ToolArtifacts } from "../src/tools/types.ts";
import { compactMessages, compactMessagesLLM } from "../src/tui/compact.ts";

// /compact's summarizer: one completion fed the FULL pruned window instead of the
// 200-char-per-message clipping the sync path summarizes from. Every failure mode must
// fall back to that clipping — /compact can never come out worse than it was.

const META: Model = {
  id: "meta",
  provider: "faux",
  api: "faux",
  name: "Meta",
  cost: { input: 1, output: 1 },
  context_window: 8192,
  max_tokens: 1024,
};

const reply = (t: string, stop: "endTurn" | "error" = "endTurn") =>
  (async () =>
    new AssistantMessage({
      content: [text(t)],
      stop_reason: stop,
      usage: { cost: { total: 0.004 } },
    })) as never;

function msg(role: "user" | "assistant", content: string): Message {
  return new Message({ role, content });
}

function toolMsg(tool: string, content: string, isError = false): Message {
  return new Message({ role: "toolResult", content, tool_name: tool, is_error: isError });
}

/** Run a compaction and hand back what the summarizer was actually shown. */
async function capturePrompt(
  messages: Message[],
  agent: MinimaAgent = fakeAgent(),
): Promise<{ system: string; user: string }> {
  let system = "";
  let user = "";
  await compactMessagesLLM(agent, messages, {
    model: META,
    completeFn: (async (_m: Model, ctx: { system_prompt: string; messages: Message[] }) => {
      system = ctx.system_prompt;
      user = ctx.messages[0]!.textContent;
      return new AssistantMessage({ content: [text("s")], stop_reason: "endTurn" });
    }) as never,
  });
  return { system, user };
}

/** 12 turns, each body long enough that the 200-char clip is visibly lossy. */
function convo(n = 12): Message[] {
  return Array.from({ length: n }, (_, i) =>
    msg(i % 2 === 0 ? "user" : "assistant", `turn ${i} ${"x".repeat(400)} END${i}`),
  );
}

function fakeAgent(artifacts: ToolArtifacts | null = null): MinimaAgent {
  return {
    agentState: { messages: [], model: META },
    config: {},
    artifacts,
  } as unknown as MinimaAgent;
}

const REF = "/artifacts/ab/cdef";
const stubArtifacts = {
  sink: () => () => ({ ref: REF }),
} as unknown as ToolArtifacts;

describe("compactMessagesLLM — the summary body", () => {
  test("the model's summary replaces the clipped bullets, tail and count intact", async () => {
    const messages = convo();
    const out = await compactMessagesLLM(fakeAgent(), messages, {
      model: META,
      completeFn: reply("Refactored the router; tests green; open: the retry path."),
    });

    expect(out).toHaveLength(7);
    expect(out[0]!.textContent).toBe(
      "[Compacted 6 messages]\nRefactored the router; tests green; open: the retry path.",
    );
    expect(out.slice(1)).toEqual(messages.slice(-6));
  });

  test("the model receives the window VERBATIM, not the 200-char clip", async () => {
    let prompt = "";
    await compactMessagesLLM(fakeAgent(), convo(), {
      model: META,
      completeFn: (async (_m: Model, ctx: { messages: Message[] }) => {
        prompt = ctx.messages[0]!.textContent;
        return new AssistantMessage({ content: [text("ok")], stop_reason: "endTurn" });
      }) as never,
    });

    // Every summarized message reaches the model whole — the clip would have cut at 200
    // chars, well before the terminal marker on a 400-char body.
    for (let i = 0; i < 6; i++) expect(prompt).toContain(`END${i}`);
    expect(prompt).toContain("compact/v1 messages=6");
  });

  test("the artifact ref line is identical on both paths — the escape hatch survives", async () => {
    const messages = convo();
    const agent = fakeAgent(stubArtifacts);
    const llm = await compactMessagesLLM(agent, messages, {
      model: META,
      completeFn: reply("a summary"),
    });
    const offline = compactMessages(agent, messages);

    const head = (m: Message) => m.textContent.split("\n")[0];
    expect(head(llm[0]!)).toBe(head(offline[0]!));
    expect(head(llm[0]!)).toContain(REF);
    expect(head(llm[0]!)).toContain("recover any message verbatim");
  });

  test("TTSR reminders are preserved verbatim, never fed into the summary", async () => {
    const reminder = `${TTSR_REMINDER_PREFIX} stop editing that file`;
    const messages = [...convo(6), msg("user", reminder), ...convo(6)];
    let prompt = "";
    const out = await compactMessagesLLM(fakeAgent(), messages, {
      model: META,
      completeFn: (async (_m: Model, ctx: { messages: Message[] }) => {
        prompt = ctx.messages[0]!.textContent;
        return new AssistantMessage({ content: [text("s")], stop_reason: "endTurn" });
      }) as never,
    });

    expect(out.some((m) => m.textContent === reminder)).toBe(true);
    expect(prompt).not.toContain("stop editing that file");
  });

  test("realized spend is booked once", async () => {
    const booked: number[] = [];
    await compactMessagesLLM(fakeAgent(), convo(), {
      model: META,
      completeFn: reply("s"),
      onCostUsd: (usd) => booked.push(usd),
    });
    expect(booked).toEqual([0.004]);
  });
});

describe("structural reduction of the summarizer input (no model, no tokens)", () => {
  test("an identical earlier tool result is superseded; the last copy keeps its body", async () => {
    const dump = `file contents ${"y".repeat(300)}`;
    const { user } = await capturePrompt([
      msg("user", "read it"),
      toolMsg("read", dump),
      msg("assistant", "again"),
      toolMsg("read", dump),
      ...convo(8),
    ]);

    expect(user).toContain("[superseded: identical read output repeated later in this window]");
    // Exactly one surviving copy of the payload.
    expect(user.split(dump).length - 1).toBe(1);
  });

  test("an error a later call from the same tool resolved is purged to a marker", async () => {
    const { user } = await capturePrompt([
      msg("user", "build"),
      toolMsg("bash", "error: ENOENT no such file blah blah", true),
      msg("assistant", "retrying"),
      toolMsg("bash", "build ok"),
      ...convo(8),
    ]);

    expect(user).toContain("[resolved: bash failed here; a later bash call succeeded]");
    expect(user).not.toContain("ENOENT");
    expect(user).toContain("build ok");
  });

  test("an oversized payload keeps a head and a tail around an elision marker", async () => {
    const huge = `HEAD_MARK${"z".repeat(50_000)}TAIL_MARK`;
    const { user } = await capturePrompt([msg("user", "grep"), toolMsg("grep", huge), ...convo(8)]);

    expect(user).toContain("HEAD_MARK");
    expect(user).toContain("TAIL_MARK");
    expect(user).toContain("chars elided — full text in the artifact");
    expect(user).not.toContain(huge);
    expect(user.length).toBeLessThan(huge.length / 2);
  });

  test("reduction NEVER touches the artifact — the recoverable record stays verbatim", async () => {
    const huge = `HEAD_MARK${"z".repeat(50_000)}TAIL_MARK`;
    const dump = "identical output";
    let spilled = "";
    const capturingArtifacts = {
      sink: () => (content: string) => {
        spilled = content;
        return { ref: REF };
      },
    } as unknown as ToolArtifacts;

    await capturePrompt(
      [
        msg("user", "go"),
        toolMsg("read", dump),
        toolMsg("read", dump),
        toolMsg("grep", huge),
        ...convo(8),
      ],
      fakeAgent(capturingArtifacts),
    );

    expect(spilled).toContain(huge);
    expect(spilled.split(dump).length - 1).toBe(2);
    expect(spilled).not.toContain("superseded");
  });
});

describe("compaction chains — the previous summary is an anchor, not another turn", () => {
  test("an earlier summary is hoisted out of the transcript into its own block", async () => {
    const earlier = "[Compacted 9 messages]\n## Intent\nship the parser\n## Files\nsrc/p.ts";
    const { user, system } = await capturePrompt([msg("user", earlier), ...convo(10)]);

    const anchor = user.slice(0, user.indexOf("<transcript>"));
    expect(anchor).toContain("<previous_summary>");
    expect(anchor).toContain("ship the parser");
    // Not left inline competing with the live turns.
    expect(user.slice(user.indexOf("<transcript>"))).not.toContain("ship the parser");
    expect(system).toContain("Carry every fact in it forward");
  });

  test("with no earlier summary the prompt is the transcript alone", async () => {
    const { user } = await capturePrompt(convo());
    expect(user).not.toContain("<previous_summary>");
    expect(user.startsWith("<transcript>")).toBe(true);
  });

  test("the template names the five sections, files weighted hardest", async () => {
    const { system } = await capturePrompt(convo());
    for (const h of ["## Intent", "## Files", "## Decisions", "## State", "## Next"]) {
      expect(system).toContain(h);
    }
    expect(system).toContain("never 'various files'");
  });
});

describe("compactMessagesLLM — fail-open to the offline body", () => {
  const messages = convo();
  const offline = () => compactMessages(fakeAgent(), messages);

  const cases: [string, Parameters<typeof compactMessagesLLM>[2]][] = [
    ["no model", { model: null }],
    ["aborted", { model: META, signal: AbortSignal.abort(), completeFn: reply("s") }],
    ["error reply", { model: META, completeFn: reply("s", "error") }],
    ["empty reply", { model: META, completeFn: reply("   ") }],
    [
      "thrown call",
      {
        model: META,
        completeFn: (async () => {
          throw new Error("network down");
        }) as never,
      },
    ],
  ];

  for (const [name, opts] of cases) {
    test(`${name} → byte-identical to the deterministic compaction`, async () => {
      const out = await compactMessagesLLM(fakeAgent(), messages, opts);
      expect(out.map((m) => m.textContent)).toEqual(offline().map((m) => m.textContent));
    });
  }

  test("nothing to compact → the same list, untouched", async () => {
    const short = convo(8);
    expect(await compactMessagesLLM(fakeAgent(), short, { model: META, completeFn: reply("s") })).toBe(
      short,
    );
  });
});
