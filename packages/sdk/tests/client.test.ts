import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../src/client.ts";
import { MinimaClient, retryDelayMs } from "../src/client.ts";
import { MinimaError, MinimaRateLimited, MinimaUnavailable } from "../src/errors.ts";
import type {
  CalibrationResponse,
  DiagnoseResponse,
  FeedbackRequest,
  MemoryHealthResponse,
  ModelsResponse,
  RankedModel,
  RecommendResponse,
  SavingsResponse,
  StrategiesResponse,
  WorkflowResponse,
} from "../src/schemas.ts";

interface Recorded {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function mockTransport(responses: Array<{ status: number; body: unknown; retryAfter?: string }>) {
  const calls: Recorded[] = [];
  let i = 0;
  const fetchLike = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (!r) throw new Error("no response scripted");
    return {
      status: r.status,
      json: async () => r.body,
      headers: { get: (name: string) => (name === "retry-after" ? (r.retryAfter ?? null) : null) },
    };
  };
  return { calls, fetchLike };
}

const FEEDBACK_OK = { accepted: true, warnings: [] };

/**
 * Response fixtures are annotated with the real wire interfaces, so a schemas.ts change
 * that the mocks no longer satisfy fails `bun run check` instead of passing silently.
 */
const HAIKU: RankedModel = {
  model_id: "claude-haiku-4-5",
  provider: "anthropic",
  predicted_success: 0.87,
  est_cost_usd: 0.0012,
  score: 0.91,
};

const RECOMMEND_OK: RecommendResponse = {
  recommendation_id: "rec-1",
  recommended_model: HAIKU,
  ranked: [HAIKU],
  confidence: 0.87,
  decision_basis: "memory",
  threshold_used: 0.8,
  classified_task_type: "code",
  classified_difficulty: "medium",
  catalog_version: "2026-08-01",
};

function client(t: ReturnType<typeof mockTransport>) {
  return new MinimaClient({
    baseUrl: "http://minima.test",
    apiKey: "k",
    fetch: t.fetchLike,
    feedbackRetryDelaysMs: [1, 1],
  });
}

describe("headers", () => {
  test("sends x-minima-client, user-agent, and bearer auth", async () => {
    const t = mockTransport([{ status: 200, body: { ok: 1 } }]);
    await client(t).health();
    const h = t.calls[0]?.headers ?? {};
    expect(h["x-minima-client"]).toBeTruthy();
    expect(h["user-agent"]).toStartWith("minima-sdk-ts/");
    expect(h.authorization).toBe("Bearer k");
  });

  test("an unauthenticated client sends no authorization header at all", async () => {
    const t = mockTransport([{ status: 200, body: { ok: 1 } }]);
    await new MinimaClient({ baseUrl: "http://minima.test", fetch: t.fetchLike }).health();
    const h = t.calls[0]?.headers ?? {};
    expect("authorization" in h).toBe(false);
    expect(h["x-minima-client"]).toBeTruthy(); // the rest still rides
  });
});

describe("base url", () => {
  test.each([
    ["http://minima.test", "http://minima.test/v1/health"],
    ["http://minima.test/", "http://minima.test/v1/health"],
    ["http://minima.test///", "http://minima.test/v1/health"],
    ["http://minima.test/api", "http://minima.test/api/v1/health"],
    ["http://minima.test/api/", "http://minima.test/api/v1/health"],
  ])("%s resolves to %s", async (baseUrl, expected) => {
    const t = mockTransport([{ status: 200, body: { ok: 1 } }]);
    await new MinimaClient({ baseUrl, fetch: t.fetchLike }).health();
    expect(t.calls[0]?.url).toBe(expected);
  });
});

describe("recommend", () => {
  test("phase rides as a tag; incumbent + max_candidates on the wire; no retry on 503", async () => {
    const t = mockTransport([{ status: 503, body: { detail: "upstream" } }]);
    await expect(
      client(t).recommend("route me", {
        phase: "interactive",
        incumbentModelId: "claude-haiku-4-5",
        maxCandidates: 4,
      }),
    ).rejects.toBeInstanceOf(MinimaUnavailable);
    expect(t.calls.length).toBe(1); // recommend NEVER retries — fail fast, fail open
    const body = JSON.parse(t.calls[0]?.body ?? "{}");
    expect(body.task.tags).toEqual(["phase:interactive"]);
    expect(body.incumbent_model_id).toBe("claude-haiku-4-5");
    expect(body.max_candidates).toBe(4);
    expect(body.allow_llm_escalation).toBeUndefined(); // dead param not sent
  });

  test("a 200 round-trips the recommendation", async () => {
    const t = mockTransport([{ status: 200, body: RECOMMEND_OK }]);
    const rec = await client(t).recommend("route me");
    expect(rec.recommendation_id).toBe("rec-1");
    expect(rec.recommended_model.model_id).toBe("claude-haiku-4-5");
    expect(new URL(t.calls[0]?.url ?? "").pathname).toBe("/v1/recommend");
    expect(t.calls[0]?.method).toBe("POST");
  });

  test("a bare string is coerced to a TaskInput; the defaults ride with it", async () => {
    const t = mockTransport([{ status: 200, body: RECOMMEND_OK }]);
    await client(t).recommend("route me");
    const body = JSON.parse(t.calls[0]?.body ?? "{}");
    expect(body.task).toEqual({ task: "route me" });
    expect(body.cost_quality_tradeoff).toBe(5.0);
    expect(body.constraints).toEqual({});
  });

  test("a full TaskInput passes through untouched", async () => {
    const t = mockTransport([{ status: 200, body: RECOMMEND_OK }]);
    const task = {
      task: "summarize",
      task_type: "summarization" as const,
      difficulty: "easy" as const,
      expected_output_tokens: 512,
      tags: ["lane:docs"],
    };
    await client(t).recommend(task, {
      costQualityTradeoff: 1.5,
      constraints: { min_quality: 0.9 },
    });
    const body = JSON.parse(t.calls[0]?.body ?? "{}");
    expect(body.task).toEqual(task);
    expect(body.cost_quality_tradeoff).toBe(1.5);
    expect(body.constraints).toEqual({ min_quality: 0.9 });
  });

  test("phase appends to existing tags and never duplicates itself", async () => {
    const t = mockTransport([{ status: 200, body: RECOMMEND_OK }]);
    const c = client(t);
    await c.recommend({ task: "x", tags: ["lane:docs"] }, { phase: "interactive" });
    expect(JSON.parse(t.calls[0]?.body ?? "{}").task.tags).toEqual([
      "lane:docs",
      "phase:interactive",
    ]);

    await c.recommend({ task: "x", tags: ["phase:interactive"] }, { phase: "interactive" });
    expect(JSON.parse(t.calls[1]?.body ?? "{}").task.tags).toEqual(["phase:interactive"]);
  });
});

describe("feedback", () => {
  test("typed options land on the wire; explicit zero usage is reported", async () => {
    const t = mockTransport([{ status: 200, body: FEEDBACK_OK }]);
    await client(t).feedback("rec-1", "m", "partial", {
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      qualityScore: 0.5,
      evidenceSource: "judge",
      chosenEffort: "high",
      iterations: 3,
    });
    const body = JSON.parse(t.calls[0]?.body ?? "{}");
    expect(body.input_tokens).toBe(0);
    expect(body.actual_cost_usd).toBe(0);
    expect(body.quality_score).toBe(0.5);
    expect(body.evidence_source).toBe("judge");
    expect(body.chosen_effort).toBe("high");
    expect(body.iterations).toBe(3);
  });

  test("unmeasured usage fields stay absent", async () => {
    const t = mockTransport([{ status: 200, body: FEEDBACK_OK }]);
    await client(t).feedback("rec-1", "m", "success", {});
    const body = JSON.parse(t.calls[0]?.body ?? "{}");
    expect("input_tokens" in body).toBe(false);
    expect("actual_cost_usd" in body).toBe(false);
  });

  test("retries on 503 then succeeds", async () => {
    const t = mockTransport([
      { status: 503, body: { detail: "upstream" } },
      { status: 200, body: FEEDBACK_OK },
    ]);
    const resp = await client(t).feedback("rec-1", "m", "success");
    expect(resp.accepted).toBe(true);
    expect(t.calls.length).toBe(2);
  });

  test("retries on transport error then succeeds", async () => {
    let first = true;
    const inner = mockTransport([{ status: 200, body: FEEDBACK_OK }]);
    const flaky: typeof inner.fetchLike = async (url, init) => {
      if (first) {
        first = false;
        throw new Error("ECONNRESET");
      }
      return inner.fetchLike(url, init);
    };
    const c = new MinimaClient({
      baseUrl: "http://minima.test",
      fetch: flaky,
      feedbackRetryDelaysMs: [1],
    });
    const resp = await c.feedback("rec-1", "m", "success");
    expect(resp.accepted).toBe(true);
  });

  test("retries on 429 then succeeds", async () => {
    const t = mockTransport([
      { status: 429, body: { detail: "slow down" }, retryAfter: "0" },
      { status: 200, body: FEEDBACK_OK },
    ]);
    const resp = await client(t).feedback("rec-1", "m", "success");
    expect(resp.accepted).toBe(true);
    expect(t.calls.length).toBe(2);
  });

  test("does NOT retry client errors", async () => {
    const t = mockTransport([{ status: 422, body: { detail: "bad" } }]);
    await expect(client(t).feedback("rec-1", "m", "success")).rejects.toBeInstanceOf(MinimaError);
    expect(t.calls.length).toBe(1);
  });

  test("gives up after the delay schedule is exhausted", async () => {
    const t = mockTransport([{ status: 503, body: { detail: "upstream" } }]);
    await expect(client(t).feedback("rec-1", "m", "success")).rejects.toBeInstanceOf(
      MinimaUnavailable,
    );
    expect(t.calls.length).toBe(3); // 1 try + 2 retries
  });

  test("errorCause, notes and the idempotency key land on the wire", async () => {
    // idempotency_key is the server's replay guard — the reason retrying is safe at all.
    const t = mockTransport([{ status: 200, body: FEEDBACK_OK }]);
    await client(t).feedback("rec-1", "m", "failure", {
      errorCause: "infra",
      notes: "provider 529",
      idempotencyKey: "turn-42",
    });
    const body = JSON.parse(t.calls[0]?.body ?? "{}");
    expect(body.error_cause).toBe("infra");
    expect(body.notes).toBe("provider 529");
    expect(body.idempotency_key).toBe("turn-42");
  });

  test("an empty retry schedule means exactly one attempt", async () => {
    const t = mockTransport([{ status: 503, body: { detail: "upstream" } }]);
    const c = new MinimaClient({
      baseUrl: "http://minima.test",
      fetch: t.fetchLike,
      feedbackRetryDelaysMs: [],
    });
    await expect(c.feedback("rec-1", "m", "success")).rejects.toBeInstanceOf(MinimaUnavailable);
    expect(t.calls.length).toBe(1);
  });

  test("a non-Error throw is still classified as transport and retried", async () => {
    let n = 0;
    const fetchLike: FetchLike = async () => {
      n++;
      if (n === 1) throw "ECONNRESET"; // some transports reject with a bare string
      return { status: 200, json: async () => FEEDBACK_OK, headers: { get: () => null } };
    };
    const c = new MinimaClient({
      baseUrl: "http://minima.test",
      fetch: fetchLike,
      feedbackRetryDelaysMs: [1],
    });
    expect((await c.feedback("rec-1", "m", "success")).accepted).toBe(true);
    expect(n).toBe(2);
  });

  test("a caller signal aborted mid-schedule stops the retries", async () => {
    const ctl = new AbortController();
    let n = 0;
    const fetchLike: FetchLike = async () => {
      n++;
      ctl.abort(); // the caller gives up while the response is in flight
      return {
        status: 503,
        json: async () => ({ detail: "upstream" }),
        headers: { get: () => null },
      };
    };
    const c = new MinimaClient({
      baseUrl: "http://minima.test",
      fetch: fetchLike,
      feedbackRetryDelaysMs: [1, 1],
    });
    const req: FeedbackRequest = {
      recommendation_id: "rec-1",
      chosen_model_id: "m",
      outcome: "success",
    };
    await expect(c.feedbackRaw(req, ctl.signal)).rejects.toBeInstanceOf(MinimaUnavailable);
    expect(n).toBe(1);
  });
});

describe("retryDelayMs", () => {
  test("honors a 429 retry-after over the backoff schedule", () => {
    const exc = new MinimaRateLimited("slow", 429, {}, 2);
    expect(retryDelayMs(exc, 5000)).toBe(2000); // 2s honored, NOT the 5s backoff
  });

  test("caps a pathological retry-after at 10s", () => {
    const exc = new MinimaRateLimited("slow", 429, {}, 3600);
    expect(retryDelayMs(exc, 500)).toBe(10_000); // never ~1h
  });

  test("falls back to backoff when a 429 carries no retry-after", () => {
    const exc = new MinimaRateLimited("slow", 429, {}, null);
    expect(retryDelayMs(exc, 500)).toBe(500);
  });

  test("non-429 retryable faults use the backoff schedule", () => {
    const exc = new MinimaUnavailable("down", 503, {});
    expect(retryDelayMs(exc, 500)).toBe(500);
  });
});

describe("errors", () => {
  test("non-JSON 503 body still throws MinimaUnavailable, not a parse error", async () => {
    const fetchLike = async () => ({
      status: 503,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
      headers: { get: () => null },
    });
    const c = new MinimaClient({ baseUrl: "http://minima.test", fetch: fetchLike });
    await expect(c.health()).rejects.toBeInstanceOf(MinimaUnavailable);
  });

  test("429 carries retry-after", async () => {
    const t = mockTransport([{ status: 429, body: { detail: "slow down" }, retryAfter: "7" }]);
    try {
      await client(t).health();
      expect.unreachable();
    } catch (exc) {
      expect(exc).toBeInstanceOf(MinimaRateLimited);
      expect((exc as MinimaRateLimited).retryAfter).toBe(7);
    }
  });

  test("a non-JSON error body names the status instead of the literal 'null'", async () => {
    // readBody swallows a proxy HTML page into null; "null" as the message tells an
    // operator nothing, and the status is all such a response actually carries.
    const fetchLike: FetchLike = async () => ({
      status: 504,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
      headers: { get: () => null },
    });
    const c = new MinimaClient({ baseUrl: "http://minima.test", fetch: fetchLike });
    const exc = (await c.health().catch((e) => e)) as MinimaError;
    expect(exc).toBeInstanceOf(MinimaUnavailable);
    expect(exc.message).toBe("HTTP 504");
  });

  test("an HTTP-date retry-after is ignored rather than parsed as NaN", async () => {
    // The RFC allows a date form; Number() of it is NaN, which must not reach a sleep().
    const t = mockTransport([
      { status: 429, body: { detail: "slow" }, retryAfter: "Wed, 21 Oct 2015 07:28:00 GMT" },
    ]);
    const exc = (await client(t)
      .health()
      .catch((e) => e)) as MinimaRateLimited;
    expect(exc).toBeInstanceOf(MinimaRateLimited);
    expect(exc.retryAfter).toBeNull();
    expect(retryDelayMs(exc, 500)).toBe(500); // the backoff schedule, not NaN
  });

  test("a transport with no headers at all still yields a typed error", async () => {
    // FetchLike types `headers` optional, and timeout.test.ts's fake omits it.
    const fetchLike: FetchLike = async () => ({
      status: 429,
      json: async () => ({ detail: "slow down" }),
    });
    const c = new MinimaClient({ baseUrl: "http://minima.test", fetch: fetchLike });
    const exc = (await c.health().catch((e) => e)) as MinimaRateLimited;
    expect(exc).toBeInstanceOf(MinimaRateLimited);
    expect(exc.retryAfter).toBeNull();
  });

  test("an unparseable 2xx body resolves to null rather than throwing", async () => {
    const fetchLike: FetchLike = async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError("empty body");
      },
      headers: { get: () => null },
    });
    const c = new MinimaClient({ baseUrl: "http://minima.test", fetch: fetchLike });
    expect(await c.health()).toBeNull();
  });
});

describe("reporting", () => {
  test("policyValue hits /v1/policy-value with params", async () => {
    const t = mockTransport([
      {
        status: 200,
        body: {
          org_id: "org",
          since: 0,
          days: 7,
          namespace: "team-a",
          report: {
            n_trusted: 0,
            n_total_reconciled: 0,
            stochastic_share: 0,
            policies: [],
            regret_vs_oracle: 0,
          },
        },
      },
    ]);
    const report = await client(t).policyValue({ namespace: "team-a", days: 7 });
    expect(report.report.n_trusted).toBe(0);
    const url = new URL(t.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/policy-value");
    expect(url.searchParams.get("namespace")).toBe("team-a");
  });

  test("capabilities round-trips", async () => {
    const t = mockTransport([
      {
        status: 200,
        body: { plan: false, workflow: true, api_version: "0.12.0", honored_constraints: [] },
      },
    ]);
    const caps = await client(t).capabilities();
    expect(caps.workflow).toBe(true);
  });
});

/**
 * The seven endpoints that had no test at all. Each asserts the route, the verb, and that
 * dropUndefined keeps unset params off the query string — the three ways a thin typed
 * wrapper actually breaks.
 */
describe("endpoint coverage", () => {
  const WORKFLOW_OK: WorkflowResponse = {
    workflow_recommendation_id: "wf-1",
    steps: [{ step_id: "s1", recommendation: RECOMMEND_OK }],
    total_est_cost_usd: 0.004,
    total_est_cost_if_all_premium: 0.04,
    confidence: 0.8,
  };
  const SAVINGS_OK: SavingsResponse = { org_id: "org", since: 0, days: 30, summary: {} };
  const CALIBRATION_OK: CalibrationResponse = { org_id: "org", since: 0, days: 30 };
  const STRATEGIES_OK: StrategiesResponse = { lane: "default", strategies: [], count: 0 };
  const DIAGNOSE_OK: DiagnoseResponse = { lane: "default", failure_lessons: [] };
  const MEMORY_HEALTH_OK: MemoryHealthResponse = { lane: "default", stale_entries: 0 };
  const MODELS_OK: ModelsResponse = { models: [], catalog_version: "2026-08-01" };

  test("recommendWorkflow POSTs to /v1/recommend/workflow", async () => {
    const t = mockTransport([{ status: 200, body: WORKFLOW_OK }]);
    const resp = await client(t).recommendWorkflow({
      steps: [{ step_id: "s1", task: { task: "write the migration" } }],
    });
    expect(resp.workflow_recommendation_id).toBe("wf-1");
    expect(t.calls[0]?.method).toBe("POST");
    expect(new URL(t.calls[0]?.url ?? "").pathname).toBe("/v1/recommend/workflow");
    expect(JSON.parse(t.calls[0]?.body ?? "{}").steps[0].step_id).toBe("s1");
  });

  test("diagnose POSTs the error text to /v1/diagnose", async () => {
    const t = mockTransport([{ status: 200, body: DIAGNOSE_OK }]);
    const resp = await client(t).diagnose({ error_text: "ECONNRESET", limit: 3 });
    expect(resp.lane).toBe("default");
    expect(t.calls[0]?.method).toBe("POST");
    expect(new URL(t.calls[0]?.url ?? "").pathname).toBe("/v1/diagnose");
    expect(JSON.parse(t.calls[0]?.body ?? "{}")).toEqual({ error_text: "ECONNRESET", limit: 3 });
  });

  test("savings forwards every report param", async () => {
    const t = mockTransport([{ status: 200, body: SAVINGS_OK }]);
    await client(t).savings({ namespace: "team-a", days: 30, group_by: "model" });
    const url = new URL(t.calls[0]?.url ?? "");
    expect(t.calls[0]?.method).toBe("GET");
    expect(url.pathname).toBe("/v1/savings");
    expect(url.searchParams.get("namespace")).toBe("team-a");
    expect(url.searchParams.get("days")).toBe("30");
    expect(url.searchParams.get("group_by")).toBe("model");
  });

  test("calibration hits /v1/calibration and omits unset params", async () => {
    const t = mockTransport([{ status: 200, body: CALIBRATION_OK }]);
    await client(t).calibration({ days: 7 });
    const url = new URL(t.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/calibration");
    expect(url.searchParams.get("days")).toBe("7");
    expect(url.searchParams.has("namespace")).toBe(false);
  });

  test("memoryHealth hits /v1/memory/health with its threshold", async () => {
    const t = mockTransport([{ status: 200, body: MEMORY_HEALTH_OK }]);
    const resp = await client(t).memoryHealth({ namespace: "team-a", stale_threshold_days: 45 });
    expect(resp.stale_entries).toBe(0);
    const url = new URL(t.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/memory/health");
    expect(url.searchParams.get("stale_threshold_days")).toBe("45");
  });

  test("models serializes booleans and a zero cost cap", async () => {
    const t = mockTransport([{ status: 200, body: MODELS_OK }]);
    await client(t).models({ provider: "anthropic", include_stale: true, max_cost: 0 });
    const url = new URL(t.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/models");
    expect(url.searchParams.get("provider")).toBe("anthropic");
    expect(url.searchParams.get("include_stale")).toBe("true");
    expect(url.searchParams.get("max_cost")).toBe("0"); // 0 is a real cap, not "unset"
    expect(url.searchParams.has("task_type")).toBe(false);
  });

  test("strategies sends lesson_types as repeated params, not one comma-joined value", async () => {
    // The server declares `lesson_types: list[str] = Query(...)`, which FastAPI reads as
    // repeated params. A single "timeout,oom" arrives as one lesson type of that name and
    // matches nothing.
    const t = mockTransport([{ status: 200, body: STRATEGIES_OK }]);
    await client(t).strategies({
      namespace: "team-a",
      max_strategies: 5,
      lesson_types: ["timeout", "oom"],
    });
    const url = new URL(t.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/strategies");
    expect(url.searchParams.getAll("lesson_types")).toEqual(["timeout", "oom"]);
    expect(url.searchParams.get("max_strategies")).toBe("5");
  });
});
