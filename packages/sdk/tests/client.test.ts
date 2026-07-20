import { describe, expect, test } from "bun:test";
import { MinimaClient } from "../src/client.ts";
import { MinimaError, MinimaRateLimited, MinimaUnavailable } from "../src/errors.ts";

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
});

describe("errors", () => {
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
