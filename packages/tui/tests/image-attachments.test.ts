import { beforeEach, describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  type ImageContent,
  type Model,
  image,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
} from "../src/ai/index.ts";
import {
  ConstJudge,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";
import { visionCandidates } from "../src/minima/premium.ts";
import { readSource } from "./_source.ts";

const BLIND: Model = {
  id: "blind-model",
  provider: "faux",
  api: "faux",
  name: "Blind",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};
const SEEING: Model = { ...BLIND, id: "seeing-model", input: ["text", "image"] };
const SEEING2: Model = { ...SEEING, id: "seeing-2" };

const PIXEL: ImageContent = image("aGVsbG8=", "image/png");

beforeEach(() => {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
});

/**
 * Mock /v1/recommend that picks `pick`, or `altPick` once `pick` lands in excluded_models —
 * which is what lets the recovery ladder actually take a second rung (a pool of one has
 * nowhere to go once its only model is excluded).
 */
function service(pick: string, thresholdUsed = 0.5, altPick = pick) {
  const recommendCalls: Record<string, unknown>[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if (u.pathname === "/v1/recommend") {
      const req = init?.body ? JSON.parse(init.body) : {};
      recommendCalls.push(req);
      const excluded: string[] = req.constraints?.excluded_models ?? [];
      const card = {
        model_id: excluded.includes(pick) ? altPick : pick,
        provider: "faux",
        predicted_success: 0.9,
        est_cost_usd: 0.001,
        score: 0.001,
      };
      return {
        status: 200,
        json: async () => ({
          recommendation_id: `rec-${recommendCalls.length}`,
          recommended_model: card,
          ranked: [card],
          confidence: 0.8,
          decision_basis: "prior",
          threshold_used: thresholdUsed,
          catalog_version: "v1",
        }),
      };
    }
    if (u.pathname === "/v1/feedback")
      return { status: 200, json: async () => ({ accepted: true }) };
    return { status: 404, json: async () => ({}) };
  };
  return { fetchLike, recommendCalls };
}

function buildAgent(
  pick: string,
  judge = new ConstJudge(0.9),
  over: Parameters<typeof harnessConfig>[0] = {},
  thresholdUsed = 0.5,
  altPick = pick,
) {
  registerModel(BLIND);
  registerModel(SEEING);
  registerModel(SEEING2);
  const { fetchLike, recommendCalls } = service(pick, thresholdUsed, altPick);
  const reg = registerFauxProvider([BLIND, SEEING, SEEING2]);
  reg.setResponses([new AssistantMessage({ content: [text("ok")], stop_reason: "stop" })]);
  const config = harnessConfig({
    candidates: [pick],
    allowOffline: false,
    minimaApiKey: "k",
    ...over,
  });
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike as never });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const agent = new MinimaAgent({ config, router, judge, tools: [] });
  return { agent, reg, recommendCalls };
}

const userMessages = (agent: MinimaAgent) =>
  agent.agentState.messages.filter((m) => m.role === "user");

describe("attachments reach the model as one user message", () => {
  test("a vision model gets the text and the image in the SAME message", async () => {
    const { agent, reg } = buildAgent("seeing-model");
    await agent.promptRouted("what is this", { attachments: [PIXEL] });
    const users = userMessages(agent);
    // One message, not two — Agent.coercePrompts would split a bare ContentBlock[] into a
    // user message per block, orphaning the image from its question.
    expect(users).toHaveLength(1);
    expect(users[0]?.content.map((b) => b.type)).toEqual(["text", "image"]);
    expect(users[0]?.content[1]).toMatchObject({ data: "aGVsbG8=", mime_type: "image/png" });
    reg.unregister();
  });

  test("several attachments keep their order behind the text", async () => {
    const { agent, reg } = buildAgent("seeing-model");
    const a = image("QUFB", "image/png");
    const b = image("QkJC", "image/png");
    await agent.promptRouted("compare", { attachments: [a, b] });
    const blocks = userMessages(agent)[0]?.content ?? [];
    expect(blocks.map((x) => x.type)).toEqual(["text", "image", "image"]);
    expect(blocks.map((x) => (x.type === "image" ? x.data : null))).toEqual([
      null,
      "QUFB",
      "QkJC",
    ]);
    reg.unregister();
  });

  test("a prompt with NO attachments is shaped exactly as before — one text block", async () => {
    const { agent, reg } = buildAgent("seeing-model");
    await agent.promptRouted("plain task");
    const users = userMessages(agent);
    expect(users).toHaveLength(1);
    expect(users[0]?.content).toEqual([text("plain task")]);
    reg.unregister();
  });
});

describe("the vision drop-guard", () => {
  test("a blind model gets NO image block and is told one was dropped", async () => {
    const { agent, reg } = buildAgent("blind-model");
    await agent.promptRouted("what is this", { attachments: [PIXEL] });
    const blocks = userMessages(agent)[0]?.content ?? [];
    expect(blocks.map((b) => b.type)).toEqual(["text"]);
    const body = blocks[0]?.type === "text" ? blocks[0].text : "";
    expect(body).toContain("what is this");
    expect(body).toContain("1 image omitted");
    expect(body).toContain("blind-model");
    reg.unregister();
  });

  test("the omission note pluralizes honestly", async () => {
    const { agent, reg } = buildAgent("blind-model");
    await agent.promptRouted("look", { attachments: [PIXEL, PIXEL] });
    const blocks = userMessages(agent)[0]?.content ?? [];
    expect(blocks[0]?.type === "text" ? blocks[0].text : "").toContain("2 images omitted");
    reg.unregister();
  });

  test("a blind model with no attachments is never told anything was dropped", async () => {
    const { agent, reg } = buildAgent("blind-model");
    await agent.promptRouted("plain task");
    expect(userMessages(agent)[0]?.content).toEqual([text("plain task")]);
    reg.unregister();
  });

  test("recovery rungs re-send the images rather than retrying blind", async () => {
    // ConstJudge(0.1) < threshold_used 0.7 → rung 0 "fails" → the ladder re-issues once.
    const { agent, reg } = buildAgent(
      "seeing-model",
      new ConstJudge(0.1),
      { judgeSampleRate: 1, stopStrikes: 0 },
      0.7,
      "seeing-2",
    );
    agent.recoveryRungs = 1;
    reg.setResponses([
      new AssistantMessage({ content: [text("try 1")], stop_reason: "stop" }),
      new AssistantMessage({ content: [text("try 2")], stop_reason: "stop" }),
    ]);
    await agent.promptRouted("what is this", {
      attachments: [PIXEL],
      candidates: ["seeing-model", "seeing-2"],
    });
    // Asserted against what the PROVIDER received, not agentState: the ladder rewinds the
    // transcript to runStartIdx between rungs, so the finished message list shows one turn
    // however many were attempted.
    expect(reg.state.requests).toHaveLength(2);
    expect(reg.state.requests.map((r) => r.model)).toEqual(["seeing-model", "seeing-2"]);
    for (const r of reg.state.requests) expect(r.images).toHaveLength(1);
    reg.unregister();
  });

  test("a ladder rung on a BLIND model drops the image for that rung only", async () => {
    const { agent, reg } = buildAgent(
      "seeing-model",
      new ConstJudge(0.1),
      { judgeSampleRate: 1, stopStrikes: 0 },
      0.7,
      "blind-model",
    );
    agent.recoveryRungs = 1;
    reg.setResponses([
      new AssistantMessage({ content: [text("try 1")], stop_reason: "stop" }),
      new AssistantMessage({ content: [text("try 2")], stop_reason: "stop" }),
    ]);
    await agent.promptRouted("what is this", {
      attachments: [PIXEL],
      candidates: ["seeing-model", "blind-model"],
    });
    expect(reg.state.requests).toHaveLength(2);
    expect(reg.state.requests[0]?.images).toHaveLength(1);
    expect(reg.state.requests[1]?.images).toHaveLength(0);
    expect(reg.state.requests[1]?.user).toContain("1 image omitted");
    reg.unregister();
  });
});

// A LAST RESORT (see _source.ts), for the two composer seams bun test cannot exercise: Ink's
// keypress handler and the app's JSX. The logic behind both is tested by behavior above.
describe("the composer wiring", () => {
  const app = readSource("tui/app.tsx");
  const textInput = readSource("tui/text-input.tsx");

  test("MINIMA_TUI_IMAGES=0 turns Ctrl+V's image half off by passing no handler", () => {
    expect(app).toContain(
      "onImagePaste={agent.config.images ? handleImagePaste : undefined}",
    );
  });

  test("with no handler, Ctrl+V falls through to the pre-existing text paste", () => {
    // The `else` is the byte-identical old behavior; without it a flags-off Ctrl+V would
    // silently stop pasting text at all.
    const at = textInput.indexOf('const token = onImagePaste?.();');
    expect(at).toBeGreaterThan(-1);
    expect(textInput.slice(at, at + 260)).toContain("const clip = readClipboard();");
  });

  test("the title's image count is derived from the DRAFT, not the store", () => {
    expect(app).toContain("const attachedCount = parseAttachmentTokens(typedText).length;");
  });

  test("attachments are resolved at submit, so a queued prompt keeps its images", () => {
    const consumeAt = app.indexOf("consumeAttachments(trimmed)");
    const promptAt = app.indexOf("await agent.promptRouted(expanded,");
    expect(consumeAt).toBeGreaterThan(-1);
    expect(consumeAt).toBeLessThan(promptAt);
  });
});

describe("visionCandidates — pre-request pool narrowing", () => {
  beforeEach(() => {
    registerModel(BLIND);
    registerModel(SEEING);
  });

  test("keeps only the ids whose registry entry declares image input", () => {
    expect(visionCandidates(["blind-model", "seeing-model"])).toEqual(["seeing-model"]);
  });

  test("an id missing from the registry is treated as blind (fail-closed)", () => {
    expect(visionCandidates(["not-a-model", "seeing-model"])).toEqual(["seeing-model"]);
  });

  test("a pool where nothing can see returns undefined — narrow to nothing is worse", () => {
    expect(visionCandidates(["blind-model"])).toBeUndefined();
    expect(visionCandidates([])).toBeUndefined();
  });

  test("order is preserved, so the caller's preference survives the filter", () => {
    registerModel({ ...SEEING, id: "seeing-2" });
    expect(visionCandidates(["seeing-2", "blind-model", "seeing-model"])).toEqual([
      "seeing-2",
      "seeing-model",
    ]);
  });
});
