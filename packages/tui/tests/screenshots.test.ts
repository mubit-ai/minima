import { describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  type Model,
  image,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
} from "../src/ai/index.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { attachDbSink } from "../src/db/sink.ts";
import {
  ConstJudge,
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";

const VISION_MODEL: Model = {
  id: "vision-faux",
  provider: "faux",
  api: "faux",
  name: "Vision Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
  input: ["text", "image"],
};
const TEXT_MODEL: Model = {
  id: "text-faux",
  provider: "faux",
  api: "faux",
  name: "Text Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
  input: ["text"],
};

const B64 = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])).toString("base64");

function resetAll() {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
}

/** Mock Minima that recommends `modelId`, capturing every recommend body. */
function mockService(modelId: string) {
  const recommendCalls: Record<string, unknown>[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    if (method === "POST" && u.pathname === "/v1/recommend") {
      recommendCalls.push(init?.body ? JSON.parse(init.body) : {});
      return {
        status: 200,
        json: async () => ({
          recommendation_id: "rec-img",
          recommended_model: {
            model_id: modelId,
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            score: 0.001,
          },
          ranked: [
            { model_id: modelId, provider: "faux", predicted_success: 0.9, est_cost_usd: 0.001, score: 0.001 },
          ],
          confidence: 0.8,
          decision_basis: "memory",
          threshold_used: 0.5,
          classified_task_type: "code",
          classified_difficulty: "easy",
          catalog_version: "v1",
        }),
      };
    }
    if (method === "POST" && u.pathname === "/v1/feedback") {
      return { status: 200, json: async () => ({ accepted: true, record_id: "o1" }) };
    }
    return { status: 404, json: async () => ({ detail: "not found" }) };
  };
  return { fetchLike, recommendCalls };
}

function agentFor(model: Model, fetchLike: typeof fetch, db?: MinimaDb, runId?: string): MinimaAgent {
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
  const config = harnessConfig({ candidates: [model.id], allowOffline: false, minimaApiKey: "k" });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const agent = new MinimaAgent({
    config,
    router,
    judge: new ConstJudge(0.9),
    meter: new CostMeter(),
    tools: [],
  });
  if (db && runId) {
    agent.db = db;
    agent.runId = runId;
  }
  return agent;
}

describe("screenshot attachments", () => {
  test("image reaches a vision model but never the recommend request", async () => {
    resetAll();
    registerModel(VISION_MODEL);
    const reg = registerFauxProvider([VISION_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("I see it")], stop_reason: "stop" })]);

    const { fetchLike, recommendCalls } = mockService("vision-faux");
    const agent = agentFor(VISION_MODEL, fetchLike as unknown as typeof fetch);

    await agent.promptRouted("what is in this screenshot?", { attachments: [image(B64)] });

    // The image reached the provider's user message...
    expect(reg.state.requests).toHaveLength(1);
    expect(reg.state.requests[0]!.userImages).toBe(1);
    expect(reg.state.requests[0]!.user).toBe("what is in this screenshot?");
    // ...but the base64 never went to /v1/recommend (text-only routing).
    expect(agent.lastDroppedImages).toBe(0);
    expect(JSON.stringify(recommendCalls)).not.toContain(B64);
    reg.unregister();
  });

  test("image attached: routing is restricted to vision-capable candidates", async () => {
    resetAll();
    // The runtime only offers candidates whose provider key is present, so give both faux
    // models a real provider label (dispatch is still by api="faux") and set its key.
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    const visionM = { ...VISION_MODEL, id: "vision-oai", provider: "openai" };
    const textM = { ...TEXT_MODEL, id: "text-oai", provider: "openai" };
    registerModel(visionM);
    registerModel(textM);
    const reg = registerFauxProvider([visionM, textM]);
    reg.setResponses([new AssistantMessage({ content: [text("seen")], stop_reason: "stop" })]);

    // The mock would happily recommend the text model if offered it — assert the runtime
    // never puts it in the candidate set when an image is present.
    let offeredCandidates: string[] | undefined;
    const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(url);
      if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
        const body = init?.body ? JSON.parse(init.body) : {};
        offeredCandidates = body.constraints?.candidate_models;
        return {
          status: 200,
          json: async () => ({
            recommendation_id: "rec-v",
            recommended_model: { model_id: "vision-oai", provider: "openai", predicted_success: 0.9, est_cost_usd: 0.001, score: 0.001 },
            ranked: [{ model_id: "vision-oai", provider: "openai", predicted_success: 0.9, est_cost_usd: 0.001, score: 0.001 }],
            confidence: 0.8,
            decision_basis: "memory",
            threshold_used: 0.5,
            catalog_version: "v1",
          }),
        };
      }
      if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/feedback") {
        return { status: 200, json: async () => ({ accepted: true, record_id: "o1" }) };
      }
      return { status: 404, json: async () => ({ detail: "not found" }) };
    };
    const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike as unknown as typeof fetch });
    const config = harnessConfig({
      candidates: ["text-oai", "vision-oai"],
      allowOffline: false,
      minimaApiKey: "k",
    });
    const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
    const agent = new MinimaAgent({ config, router, judge: new ConstJudge(0.9), meter: new CostMeter(), tools: [] });

    await agent.promptRouted("what's here?", { attachments: [image(B64)] });

    expect(offeredCandidates).toEqual(["vision-oai"]); // text-oai filtered out pre-request
    expect(agent.lastDroppedImages).toBe(0);
    expect(reg.state.requests.at(-1)!.userImages).toBe(1);
    reg.unregister();
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
  });

  test("warn-and-drop: a text-only model gets no image, and the drop is surfaced", async () => {
    resetAll();
    registerModel(TEXT_MODEL);
    const reg = registerFauxProvider([TEXT_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("text only")], stop_reason: "stop" })]);

    const { fetchLike } = mockService("text-faux");
    const agent = agentFor(TEXT_MODEL, fetchLike as unknown as typeof fetch);

    await agent.promptRouted("describe this", { attachments: [image(B64)] });

    expect(reg.state.requests[0]!.userImages).toBe(0);
    expect(agent.lastDroppedImages).toBe(1);
    reg.unregister();
  });

  test("persistence keeps a marker, never the base64 blob", async () => {
    resetAll();
    registerModel(VISION_MODEL);
    const reg = registerFauxProvider([VISION_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ack")], stop_reason: "stop" })]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const { fetchLike } = mockService("vision-faux");
    const agent = agentFor(VISION_MODEL, fetchLike as unknown as typeof fetch, db, runId);
    const sink = attachDbSink(agent, db, { runId });

    await agent.promptRouted("look", { attachments: [image(B64)] });
    sink.detach();

    const userEvent = db.getRunEvents(runId).find((e) => e.type === "user")!;
    const payload = JSON.parse(userEvent.payload) as { text: string; n_images?: number };
    expect(payload.n_images).toBe(1);
    expect(payload.text).toContain("[+1 image]");
    expect(userEvent.payload).not.toContain(B64);
    reg.unregister();
    db.close();
  });
});
