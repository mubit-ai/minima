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
  CostMeter,
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
  return new MinimaAgent({
    config,
    router,
    judge: new ConstJudge(null),
    meter: new CostMeter(),
    tools: [],
  });
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

/** Capture stdout AND stderr for the duration of `fn` — the stdout-purity harness. */
async function captureStdio(
  fn: () => Promise<number>,
): Promise<{ out: string; err: string; code: number }> {
  const errChunks: string[] = [];
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (s: string) => {
    errChunks.push(s);
    return true;
  };
  try {
    const { out, code } = await captureStdout(fn);
    return { out, err: errChunks.join(""), code };
  } finally {
    (process.stderr as { write: unknown }).write = origErr;
  }
}

function buildOfflineAgent() {
  const failingFetch = async () => ({ status: 500, json: async () => ({ detail: "svc down" }) });
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: failingFetch });
  const config = harnessConfig({
    candidates: ["test-faux"],
    minimaApiKey: "k",
    allowOffline: true,
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  return new MinimaAgent({
    config,
    router,
    judge: new ConstJudge(null),
    meter: new CostMeter(),
    tools: [],
  });
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

describe("print-mode output hygiene (F7)", () => {
  test("stdout carries ONLY the reply; the run summary goes to stderr", async () => {
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("42")], stop_reason: "stop" })]);

    const agent = buildAgent();
    const { out, err, code } = await captureStdio(() => runPrint(agent, "what is 6*7?"));
    expect(code).toBe(0);
    expect(out).toBe("42\n"); // purity: nothing but the reply on stdout
    expect(err).toContain("minima: ran test-faux (routed)");
    reg.unregister();
  });

  test("an offline one-shot says which model served it, unrouted", async () => {
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("offline-ok")], stop_reason: "stop" })]);

    const agent = buildOfflineAgent();
    const { out, err, code } = await captureStdio(() => runPrint(agent, "hi"));
    expect(code).toBe(0);
    expect(out).toBe("offline-ok\n");
    expect(err).toContain("minima: ran test-faux (offline)");
    expect(err).toMatch(/\$\d/); // realized cost rides along (meter attached)
    reg.unregister();
  });

  test("json mode: the final done line carries model, basis, and actual cost", async () => {
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
    const done = lines[lines.length - 1]!;
    expect(done.type).toBe("done"); // done stays the terminal line
    expect(done.model).toBe("test-faux");
    expect(done.basis).toBe("routed");
    expect(typeof done.actual_cost_usd).toBe("number");
    reg.unregister();
  });

  test("json mode: an offline one-shot reports basis offline", async () => {
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("offline-ok")], stop_reason: "stop" })]);

    const agent = buildOfflineAgent();
    const { out } = await captureStdout(() => runJson(agent, "hi"));
    const lines = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const done = lines[lines.length - 1]!;
    expect(done.type).toBe("done");
    expect(done.basis).toBe("offline");
    reg.unregister();
  });
});

describe("lastFeedbackError is per-turn (no stale learning-loop note)", () => {
  test("an earlier turn's rejection does not persist onto a later pinned turn", async () => {
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({ content: [text("one")], stop_reason: "stop" }),
      new AssistantMessage({ content: [text("two")], stop_reason: "stop" }),
    ]);
    const agent = buildAgent({ accepted: false, warnings: ["memory_write_failed"] });

    // Turn 1: routed with a recommendation → feedback is sent and rejected → error surfaces.
    await agent.promptRouted("first");
    expect(agent.lastFeedbackError).not.toBeNull();

    // Turn 2: pinned → no recommendation, so feedbackSafely early-returns and sends nothing.
    // The stale rejection from turn 1 must NOT carry over (else the TUI re-shows the note).
    agent.config.pinned = true;
    await agent.promptRouted("second");
    expect(agent.lastFeedbackError).toBeNull();

    reg.unregister();
  });
});

// keep mock referenced (bun:test import)
void mock;
