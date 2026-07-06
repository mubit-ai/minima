import { afterEach, describe, expect, mock, test } from "bun:test";
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
import {
  ConstJudge,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";
import { eventToDict, runJson, runPrint } from "../src/run_modes.ts";

const FAUX_MODEL: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

function resetAll() {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
}

function mockService(feedbackResponse: Record<string, unknown> = { accepted: true }) {
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    if (method === "POST" && u.pathname === "/v1/recommend") {
      return {
        status: 200,
        json: async () => ({
          recommendation_id: "rec-1",
          recommended_model: {
            model_id: "test-faux",
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            score: 0.001,
          },
          confidence: 0.8,
          decision_basis: "memory",
          threshold_used: 0.5,
          classified_task_type: "qa",
          classified_difficulty: "easy",
          catalog_version: "v1",
        }),
      };
    }
    if (method === "POST" && u.pathname === "/v1/feedback") {
      return { status: 200, json: async () => feedbackResponse };
    }
    return { status: 404, json: async () => ({ detail: "nf" }) };
  };
  return fetchLike;
}

function buildAgent(feedbackResponse?: Record<string, unknown>) {
  const client = new MinimaClient({
    baseUrl: "http://svc.local",
    fetch: mockService(feedbackResponse),
  });
  const config = harnessConfig({
    candidates: ["test-faux"],
    minimaApiKey: "k",
    allowOffline: false,
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  return new MinimaAgent({ config, router, judge: new ConstJudge(null), tools: [] });
}

/** Capture process.stdout.write for the duration of `fn`. */
async function captureStdout(fn: () => Promise<number>): Promise<{ out: string; code: number }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (s: string) => {
    chunks.push(s);
    return true;
  };
  try {
    const code = await fn();
    return { out: chunks.join(""), code };
  } finally {
    (process.stdout as { write: unknown }).write = orig;
  }
}

afterEach(resetAll);

describe("eventToDict", () => {
  test("maps text deltas, tool events, and lifecycle markers", () => {
    expect(eventToDict({ type: "agent_start" })).toEqual({ type: "start" });
    expect(eventToDict({ type: "turn_end", message: null, toolResults: [] })).toEqual({
      type: "turn_end",
    });
    expect(
      eventToDict({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi", contentIndex: 0 },
      }),
    ).toEqual({ type: "text_delta", delta: "hi" });
    expect(
      eventToDict({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: null }),
    ).toEqual({ type: "tool_start", name: "bash" });
  });
});

describe("runPrint", () => {
  test("prints the final assistant text and exits 0", async () => {
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("42")], stop_reason: "stop" })]);

    const agent = buildAgent();
    const { out, code } = await captureStdout(() => runPrint(agent, "what is 6*7?"));
    expect(code).toBe(0);
    expect(out.trim()).toBe("42");
    reg.unregister();
  });
});

describe("runJson", () => {
  test("streams one JSON object per line, ending with done", async () => {
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("hello")] })]);

    const agent = buildAgent();
    const { out, code } = await captureStdout(() => runJson(agent, "say hello"));
    expect(code).toBe(0);
    const lines = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const types = lines.map((l) => l.type);
    expect(types[0]).toBe("start");
    expect(types).toContain("text_delta");
    expect(types[types.length - 1]).toBe("done");
    expect(types).not.toContain("feedback_error"); // accepted feedback → no rejection line
    reg.unregister();
  });

  test("an accepted=false feedback emits a feedback_error line (not run failure)", async () => {
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("hello")] })]);

    const agent = buildAgent({ accepted: false, warnings: ["memory_write_failed"] });
    const { out, code } = await captureStdout(() => runJson(agent, "say hello"));
    expect(code).toBe(0); // the turn succeeded; only the learning write-back was rejected
    const lines = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const fb = lines.find((l) => l.type === "feedback_error");
    expect(fb).toBeDefined();
    expect(String(fb?.message)).toContain("memory_write_failed");
    reg.unregister();
  });
});

// keep mock referenced (bun:test import)
void mock;
