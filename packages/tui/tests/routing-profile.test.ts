import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
} from "../src/ai/index.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  ConstJudge,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
  minDefinedCap,
  parseProfileCandidates,
  perTaskTypeEntry,
  resolveProfilePool,
} from "../src/minima/index.ts";

const PROJECT = "github.com/test/profile-repo";

const FAUX: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};
const CLAUDE_X: Model = {
  ...FAUX,
  id: "claude-x",
  provider: "anthropic",
  api: "anthropic-messages",
};
const CLAUDE_Y: Model = {
  ...FAUX,
  id: "claude-y",
  provider: "anthropic",
  api: "anthropic-messages",
};

let saved: string | undefined;
beforeEach(() => {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "k";
});
afterEach(() => {
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
});

function freshDb(): { db: MinimaDb; runId: string } {
  const db = new MinimaDb(":memory:");
  db.ensureProject(PROJECT);
  const runId = db.startRun({ projectKey: PROJECT });
  return { db, runId };
}

/** Mock service capturing every recommend body; always picks test-faux (runs on faux). */
function service() {
  const recommendCalls: Record<string, unknown>[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if (u.pathname === "/v1/recommend") {
      recommendCalls.push(init?.body ? JSON.parse(init.body) : {});
      const card = {
        model_id: "test-faux",
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
          threshold_used: 0.5,
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
  fetchLike: (url: string, init?: { method?: string; body?: string }) => Promise<unknown>,
  over: Parameters<typeof harnessConfig>[0] = {},
) {
  registerModel(CLAUDE_X);
  registerModel(CLAUDE_Y);
  registerModel(FAUX);
  const reg = registerFauxProvider([FAUX]);
  reg.setResponses([new AssistantMessage({ content: [text("ok")], stop_reason: "stop" })]);
  const config = harnessConfig({
    candidates: ["claude-x"],
    allowOffline: false,
    minimaApiKey: "k",
    judgeSampleRate: 0,
    ...over,
  });
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike as never });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const agent = new MinimaAgent({ config, router, judge: new ConstJudge(0.9), tools: [] });
  const { db, runId } = freshDb();
  agent.db = db;
  agent.runId = runId;
  return { agent, reg, db };
}

describe("routing_profiles migration", () => {
  test("creates routing_profiles + profile_events with the project index", () => {
    const db = new MinimaDb(":memory:");
    const tables = db.db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)")
      .all("routing_profiles", "profile_events") as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual(["profile_events", "routing_profiles"]);
    const index = db.db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("ix_profile_events_project");
    expect(index).toBeTruthy();
  });
});

describe("routing profile accessors", () => {
  test("upsert is a partial patch: only provided fields change, updated_at stamped", () => {
    const { db } = freshDb();
    expect(db.getRoutingProfile(PROJECT)).toBeNull();
    const first = db.upsertRoutingProfile(PROJECT, { slider: 3 }, "user");
    expect(first?.slider).toBe(3);
    expect(first?.min_quality).toBeNull();
    expect(first?.updated_at).toBeGreaterThan(0);
    const second = db.upsertRoutingProfile(PROJECT, { minQuality: 0.7 }, "interview");
    expect(second?.slider).toBe(3);
    expect(second?.min_quality).toBe(0.7);
    expect(second?.source).toBe("interview");
  });

  test("one profile_events row PER CHANGED FIELD; a no-op patch writes none", () => {
    const { db } = freshDb();
    db.upsertRoutingProfile(PROJECT, { slider: 3, maxCostPerCall: 0.05 }, "user");
    let events = db.listProfileEvents(PROJECT);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.field).sort()).toEqual(["max_cost_per_call", "slider"]);
    expect(events.every((e) => e.source === "user")).toBe(true);
    const sliderEvent = events.find((e) => e.field === "slider");
    expect(sliderEvent?.old_value).toBeNull();
    expect(sliderEvent?.new_value).toBe("3");
    db.upsertRoutingProfile(PROJECT, { slider: 3 }, "user");
    expect(db.listProfileEvents(PROJECT)).toHaveLength(2);
    db.upsertRoutingProfile(PROJECT, { slider: 8 }, "tuner");
    events = db.listProfileEvents(PROJECT);
    expect(events).toHaveLength(3);
    expect(events[0]?.field).toBe("slider");
    expect(events[0]?.old_value).toBe("3");
    expect(events[0]?.new_value).toBe("8");
    expect(events[0]?.source).toBe("tuner");
  });

  test("explicit null clears a field (with an audit event); lists/maps serialize as JSON", () => {
    const { db } = freshDb();
    db.upsertRoutingProfile(
      PROJECT,
      { candidates: ["claude-x", "claude-y"], perTaskType: { reasoning: { candidates: ["claude-y"] } } },
      "user",
    );
    const row = db.getRoutingProfile(PROJECT);
    expect(JSON.parse(row?.candidates ?? "null")).toEqual(["claude-x", "claude-y"]);
    expect(JSON.parse(row?.per_task_type ?? "null")).toEqual({
      reasoning: { candidates: ["claude-y"] },
    });
    db.upsertRoutingProfile(PROJECT, { candidates: null }, "user");
    expect(db.getRoutingProfile(PROJECT)?.candidates).toBeNull();
    const clearEvent = db.listProfileEvents(PROJECT)[0];
    expect(clearEvent?.field).toBe("candidates");
    expect(clearEvent?.new_value).toBeNull();
  });

  test("an all-noop patch on a missing row creates no empty row", () => {
    const { db } = freshDb();
    expect(db.upsertRoutingProfile(PROJECT, {}, "interview")).toBeNull();
    expect(db.getRoutingProfile(PROJECT)).toBeNull();
  });

  test("clear deletes the row and writes a 'profile' tombstone event", () => {
    const { db } = freshDb();
    db.upsertRoutingProfile(PROJECT, { slider: 3 }, "user");
    expect(db.clearRoutingProfile(PROJECT, "user")).toBe(true);
    expect(db.getRoutingProfile(PROJECT)).toBeNull();
    const events = db.listProfileEvents(PROJECT);
    expect(events[0]?.field).toBe("profile");
    expect(JSON.parse(events[0]?.old_value ?? "null")?.slider).toBe(3);
    expect(events[0]?.new_value).toBeNull();
    expect(db.clearRoutingProfile(PROJECT, "user")).toBe(false);
  });
});

describe("profile parsing helpers", () => {
  const row = (over: Partial<import("../src/db/minima_db.ts").RoutingProfileRow>) => ({
    project_key: PROJECT,
    slider: null,
    min_quality: null,
    max_cost_per_call: null,
    candidates: null,
    per_task_type: null,
    source: null,
    updated_at: null,
    ...over,
  });

  test("malformed / empty JSON never overrides", () => {
    expect(parseProfileCandidates(null)).toBeNull();
    expect(parseProfileCandidates(row({ candidates: "not json" }))).toBeNull();
    expect(parseProfileCandidates(row({ candidates: "[]" }))).toBeNull();
    expect(perTaskTypeEntry(row({ per_task_type: "not json" }), "reasoning")).toBeNull();
    expect(perTaskTypeEntry(row({ per_task_type: '{"reasoning":{"candidates":[]}}' }), "reasoning")).toBeNull();
  });

  test("per-task pool filters to known models, falls back to the default pool when empty", () => {
    const profile = row({
      candidates: '["claude-x"]',
      per_task_type: '{"reasoning":{"candidates":["ghost-model","claude-y"],"minQuality":0.9}}',
    });
    const known = (id: string) => id.startsWith("claude");
    expect(resolveProfilePool(profile, "reasoning", known)).toEqual(["claude-y"]);
    expect(perTaskTypeEntry(profile, "reasoning")?.minQuality).toBe(0.9);
    expect(resolveProfilePool(profile, "other", known)).toEqual(["claude-x"]);
    expect(resolveProfilePool(profile, null, known)).toEqual(["claude-x"]);
    const allGhosts = row({
      candidates: '["claude-x"]',
      per_task_type: '{"reasoning":{"candidates":["ghost-model"]}}',
    });
    expect(resolveProfilePool(allGhosts, "reasoning", known)).toEqual(["claude-x"]);
  });

  test("minDefinedCap: tighter ceiling wins, absent sides pass through", () => {
    expect(minDefinedCap(0.05, 0.02)).toBe(0.02);
    expect(minDefinedCap(0.05, null)).toBe(0.05);
    expect(minDefinedCap(undefined, 0.02)).toBe(0.02);
    expect(minDefinedCap(null, undefined)).toBeUndefined();
  });
});

describe("route-time application (wire assertions)", () => {
  test("config defaults on the wire when no profile row exists", async () => {
    const { fetchLike, recommendCalls } = service();
    const { agent, reg } = buildAgent(fetchLike);
    await agent.promptRouted("hi");
    expect(recommendCalls[0]?.cost_quality_tradeoff).toBe(5);
    expect(recommendCalls[0]?.constraints).toMatchObject({ candidate_models: ["claude-x"] });
    const constraints = recommendCalls[0]?.constraints as Record<string, unknown>;
    expect(constraints.min_quality).toBeUndefined();
    expect(constraints.max_cost_per_call).toBeUndefined();
    reg.unregister();
  });

  test("profile beats config: slider, min_quality, max_cost_per_call, candidates", async () => {
    const { fetchLike, recommendCalls } = service();
    const { agent, reg, db } = buildAgent(fetchLike);
    db.upsertRoutingProfile(
      PROJECT,
      { slider: 3, minQuality: 0.8, maxCostPerCall: 0.05, candidates: ["claude-y"] },
      "user",
    );
    await agent.promptRouted("hi");
    expect(recommendCalls[0]?.cost_quality_tradeoff).toBe(3);
    expect(recommendCalls[0]?.constraints).toMatchObject({
      candidate_models: ["claude-y"],
      min_quality: 0.8,
      max_cost_per_call: 0.05,
    });
    reg.unregister();
  });

  test("explicit opts beat the profile on every knob", async () => {
    const { fetchLike, recommendCalls } = service();
    const { agent, reg, db } = buildAgent(fetchLike);
    db.upsertRoutingProfile(
      PROJECT,
      { slider: 3, minQuality: 0.8, maxCostPerCall: 0.05, candidates: ["claude-y"] },
      "user",
    );
    await agent.promptRouted("hi", {
      slider: 9,
      minQuality: 0.4,
      maxCostPerCall: 0.5,
      candidates: ["claude-x"],
    });
    expect(recommendCalls[0]?.cost_quality_tradeoff).toBe(9);
    expect(recommendCalls[0]?.constraints).toMatchObject({
      candidate_models: ["claude-x"],
      min_quality: 0.4,
      max_cost_per_call: 0.5,
    });
    reg.unregister();
  });

  test("per-task-type pool applies only when a taskType is known; registry-filtered", async () => {
    const { fetchLike, recommendCalls } = service();
    const { agent, reg, db } = buildAgent(fetchLike);
    db.upsertRoutingProfile(
      PROJECT,
      {
        candidates: ["claude-x"],
        perTaskType: { reasoning: { candidates: ["ghost-model", "claude-y"], minQuality: 0.9 } },
      },
      "user",
    );
    await agent.promptRouted("hi", { taskType: "reasoning" });
    expect(recommendCalls[0]?.constraints).toMatchObject({
      candidate_models: ["claude-y"],
      min_quality: 0.9,
    });
    await agent.promptRouted("hi");
    expect(recommendCalls[1]?.constraints).toMatchObject({ candidate_models: ["claude-x"] });
    reg.unregister();
  });

  test("a per-task pool of only unknown models falls back to the default pool", async () => {
    const { fetchLike, recommendCalls } = service();
    const { agent, reg, db } = buildAgent(fetchLike);
    db.upsertRoutingProfile(
      PROJECT,
      { candidates: ["claude-y"], perTaskType: { reasoning: { candidates: ["ghost-model"] } } },
      "user",
    );
    await agent.promptRouted("hi", { taskType: "reasoning" });
    expect(recommendCalls[0]?.constraints).toMatchObject({ candidate_models: ["claude-y"] });
    reg.unregister();
  });

  test("profile writes reach the next route after invalidateRoutingProfile", async () => {
    const { fetchLike, recommendCalls } = service();
    const { agent, reg, db } = buildAgent(fetchLike);
    await agent.promptRouted("hi");
    expect(recommendCalls[0]?.cost_quality_tradeoff).toBe(5);
    db.upsertRoutingProfile(PROJECT, { slider: 2 }, "user");
    agent.invalidateRoutingProfile();
    await agent.promptRouted("hi");
    expect(recommendCalls[1]?.cost_quality_tradeoff).toBe(2);
    reg.unregister();
  });

  test("pinned bypasses routing entirely — the profile is never applied", async () => {
    const { fetchLike, recommendCalls } = service();
    const { agent, reg, db } = buildAgent(fetchLike, {
      pinned: true,
      candidates: ["test-faux"],
    });
    db.upsertRoutingProfile(PROJECT, { slider: 2, candidates: ["claude-y"] }, "user");
    await agent.promptRouted("hi");
    expect(recommendCalls).toHaveLength(0);
    expect(agent.agentState.model?.id).toBe("test-faux");
    reg.unregister();
  });
});
