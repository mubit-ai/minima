import { beforeEach, describe, expect, test } from "bun:test";
import { type Model, registerModel, resetModelRegistry } from "../src/ai/index.ts";
import {
  type HarnessConfig,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";

const MODEL: Model = {
  id: "m",
  provider: "p",
  api: "faux",
  name: "M",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};
beforeEach(() => {
  resetModelRegistry();
  registerModel(MODEL);
});

// Prod memory recall is scoped by user_id: without a stable one the server surfaces
// nothing and decision_basis never leaves `prior` (a run can't recall its own prior
// outcomes). recommend() must send config.memorySession, falling back to namespace.
function service() {
  const userIds: (string | undefined)[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if (u.pathname === "/v1/recommend") {
      const body = init?.body ? JSON.parse(init.body) : {};
      userIds.push(body?.user_id);
      return {
        status: 200,
        json: async () => ({
          recommendation_id: "rec-1",
          recommended_model: {
            model_id: "m",
            provider: "p",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            score: 0.001,
          },
          ranked: [
            { model_id: "m", provider: "p", predicted_success: 0.9, est_cost_usd: 0.001, score: 0.001 },
          ],
          confidence: 0.8,
          decision_basis: "prior",
          threshold_used: 0.5,
          catalog_version: "v1",
        }),
      };
    }
    return { status: 404, json: async () => ({}) };
  };
  return { fetchLike, userIds };
}

function routerFor(overrides: Partial<HarnessConfig>) {
  const { fetchLike, userIds } = service();
  const config = harnessConfig({ minimaApiKey: "k", allowOffline: false, ...overrides });
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike as never });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  return { router, userIds };
}

describe("recommend sends a stable user_id for server-side recall", () => {
  test("uses memorySession when set", async () => {
    const { router, userIds } = routerFor({ memorySession: "proj-42", namespace: "proj-42" });
    await router.recommend({ task: "hi" });
    expect(userIds[0]).toBe("proj-42");
  });

  test("falls back to namespace when memorySession is null", async () => {
    const { router, userIds } = routerFor({ memorySession: null, namespace: "ns-only" });
    await router.recommend({ task: "hi" });
    expect(userIds[0]).toBe("ns-only");
  });

  test("omitted when neither is set (no bogus recall scope)", async () => {
    const { router, userIds } = routerFor({ memorySession: null, namespace: null });
    await router.recommend({ task: "hi" });
    expect(userIds[0]).toBeUndefined();
  });
});
