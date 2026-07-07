import { describe, expect, mock, test } from "bun:test";
import { MinimaClient, MinimaError, asOutcome } from "../src/minima/index.ts";

/** Build a client backed by an in-memory mock transport. No network. */
function mockClient(
  handler: (
    method: string,
    path: string,
    body: unknown,
    params: URLSearchParams,
  ) => {
    status: number;
    json: unknown;
  },
) {
  const calls: { method: string; path: string; body: unknown; params: string }[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, body, params: u.searchParams.toString() });
    const result = handler(method, u.pathname, body, u.searchParams);
    return { status: result.status, json: async () => result.json };
  };
  const client = new MinimaClient({ baseUrl: "http://svc.local", apiKey: "k", fetch: fetchLike });
  return { client, calls };
}

describe("MinimaClient.recommend", () => {
  test("coerces a bare-string task and posts to /v1/recommend", async () => {
    const { client, calls } = mockClient(() => ({
      status: 200,
      json: {
        recommendation_id: "rec-1",
        recommended_model: {
          model_id: "claude-haiku",
          provider: "anthropic",
          predicted_success: 0.9,
          est_cost_usd: 0.001,
          score: 0.001,
        },
        confidence: 0.8,
        decision_basis: "memory",
        threshold_used: 0.5,
        classified_task_type: "code",
        classified_difficulty: "easy",
        catalog_version: "v1",
      },
    }));

    const res = await client.recommend("write a function");
    expect(res.recommendation_id).toBe("rec-1");
    expect(res.recommended_model.model_id).toBe("claude-haiku");

    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/v1/recommend");
    const sent = calls[0].body as { task: { task: string }; cost_quality_tradeoff: number };
    expect(sent.task.task).toBe("write a function");
    expect(sent.cost_quality_tradeoff).toBe(5.0);
  });

  test("forwards constraints and options", async () => {
    const { client, calls } = mockClient(() => ({
      status: 200,
      json: {
        recommendation_id: "r",
        recommended_model: {
          model_id: "m",
          provider: "p",
          predicted_success: 0.5,
          est_cost_usd: 1,
          score: 1,
        },
        confidence: 0.5,
        decision_basis: "prior",
        threshold_used: 0.5,
        classified_task_type: "qa",
        classified_difficulty: "medium",
        catalog_version: "v1",
      },
    }));

    await client.recommend(
      { task: "x", tags: ["a"] },
      {
        cost_quality_tradeoff: 8,
        constraints: { max_cost_per_call: 0.5 },
        namespace: "team-x",
        allow_llm_escalation: false,
      },
    );

    const sent = calls[0].body as Record<string, unknown>;
    expect(sent.cost_quality_tradeoff).toBe(8);
    expect((sent.constraints as { max_cost_per_call: number }).max_cost_per_call).toBe(0.5);
    expect(sent.namespace).toBe("team-x");
    expect(sent.allow_llm_escalation).toBe(false);
  });
});

describe("MinimaClient.feedback", () => {
  test("posts realized usage to /v1/feedback", async () => {
    const { client, calls } = mockClient(() => ({
      status: 200,
      json: { accepted: true, record_id: "o1", reinforced_entry_ids: ["e1"] },
    }));

    const res = await client.feedback({
      recommendation_id: "rec-1",
      chosen_model_id: "claude-haiku",
      outcome: "success",
      input_tokens: 120,
      output_tokens: 30,
      actual_cost_usd: 0.002,
      latency_ms: 800,
      iterations: 2,
    });

    expect(res.accepted).toBe(true);
    expect(calls[0].path).toBe("/v1/feedback");
    const sent = calls[0].body as Record<string, unknown>;
    expect(sent.outcome).toBe("success");
    expect(sent.actual_cost_usd).toBe(0.002);
    expect(sent.iterations).toBe(2);
  });
});

describe("MinimaClient.capabilities", () => {
  test("parses capabilities response and returns typed object", async () => {
    const { client } = mockClient(() => ({
      status: 200,
      json: {
        plan: false,
        workflow: true,
        api_version: "0.6.0",
        honored_constraints: ["candidate_models", "excluded_models"],
      },
    }));
    const res = await client.capabilities();
    expect(res.plan).toBe(false);
    expect(res.workflow).toBe(true);
    expect(res.api_version).toBe("0.6.0");
    expect(res.honored_constraints).toContain("candidate_models");
  });

  test("hits GET /v1/capabilities with no body", async () => {
    const { client, calls } = mockClient(() => ({
      status: 200,
      json: { plan: false, workflow: true, api_version: "x", honored_constraints: [] },
    }));
    await client.capabilities();
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("/v1/capabilities");
    expect(calls[0].body).toBeUndefined();
  });
});

describe("MinimaClient GET endpoints", () => {
  test("models drops undefined params", async () => {
    const { client, calls } = mockClient(() => ({
      status: 200,
      json: { models: [], catalog_version: "v1" },
    }));
    await client.models({ provider: "anthropic" });
    expect(calls[0].params).toBe("provider=anthropic");
  });

  test("savings forwards all report params", async () => {
    const { client, calls } = mockClient(() => ({
      status: 200,
      json: { org_id: "o", since: 0, days: 7, summary: {} },
    }));
    await client.savings({ namespace: "x", days: 30, group_by: "model" });
    const params = new URLSearchParams(calls[0].params);
    expect(params.get("namespace")).toBe("x");
    expect(params.get("days")).toBe("30");
    expect(params.get("group_by")).toBe("model");
  });
});

describe("MinimaClient error handling", () => {
  test("raises MinimaError with FastAPI detail on 4xx", async () => {
    const { client } = mockClient(() => ({ status: 422, json: { detail: "bad input" } }));
    await expect(client.health()).rejects.toBeInstanceOf(MinimaError);
    await expect(client.health()).rejects.toMatchObject({ status: 422, message: "bad input" });
  });
});

describe("asOutcome", () => {
  test("accepts valid labels", () => {
    expect(asOutcome("success")).toBe("success");
    expect(asOutcome("partial")).toBe("partial");
    expect(asOutcome("failure")).toBe("failure");
  });
  test("rejects invalid", () => {
    expect(() => asOutcome("maybe")).toThrow();
  });
});

// keep mock referenced to satisfy lint when unused-import detection runs
void mock;
