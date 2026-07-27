import { describe, expect, test } from "bun:test";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  distillWorkflow,
  knownProcedureFor,
  mineGreenEpisodes,
  runDream,
} from "../src/minima/index.ts";
import { drainMemoryJobs } from "../src/minima/index.ts";

// B3 memory dream: green-only episode mining (the label-quality moat), deterministic
// distillation, pending-only writes with the Dreams never-mutate-input contract, and the
// procedure:known replay match. Hermetic — no LLM anywhere in a dream.

function repo() {
  const db = new MinimaDb(":memory:");
  db.ensureProject("proj");
  const runId = db.startRun({ projectKey: "proj" });
  return { db, runId };
}

/** A closed plan with the given gate quality. */
function closedPlan(
  db: MinimaDb,
  runId: string,
  title: string,
  gate: { verifiedBy: "deterministic" | "judge"; confidence: "green" | "yellow" } | null,
) {
  db.upsertPlanFromTodos(
    runId,
    [
      { content: `${title} step one`, status: "completed", verify: "bun test one" },
      { content: `${title} step two`, status: "completed" },
    ],
    title,
  );
  const plan = db.getActivePlan(runId) ?? db.getLatestPlan(runId)!;
  if (gate) {
    db.insertGate({
      planId: plan.id,
      stepId: db.getPlanSteps(plan.id)[0]!.id,
      kind: "step_check",
      outcome: "verified",
      confidence: gate.confidence,
      verifiedBy: gate.verifiedBy,
      recId: "rec-g1",
      sessionId: runId,
    });
  }
  db.setPlanStatus(plan.id, "done");
  return plan;
}

describe("memory dream — mining + distillation", () => {
  test("only green deterministic episodes clear the moat", () => {
    const { db, runId } = repo();
    closedPlan(db, runId, "green work", { verifiedBy: "deterministic", confidence: "green" });
    const r2 = db.startRun({ projectKey: "proj" });
    closedPlan(db, r2, "judge work", { verifiedBy: "judge", confidence: "yellow" });
    const r3 = db.startRun({ projectKey: "proj" });
    closedPlan(db, r3, "ungated work", null);

    const eps = mineGreenEpisodes(db, "proj");
    expect(eps).toHaveLength(1);
    expect(eps[0]!.goal).toBe("green work");
    expect(eps[0]!.recIds).toEqual(["rec-g1"]);
  });

  test("distillation is verbatim ledger facts: goal + ordered steps + verify recipe", () => {
    const { db, runId } = repo();
    closedPlan(db, runId, "ship the fix", { verifiedBy: "deterministic", confidence: "green" });
    const ep = mineGreenEpisodes(db, "proj")[0]!;
    const { content, trigger } = distillWorkflow(ep);
    expect(trigger).toBe("ship the fix");
    expect(content).toContain("Verified workflow — ship the fix:");
    expect(content).toContain("1. ship the fix step one (verify: `bun test one`)");
    expect(content).toContain("2. ship the fix step two");
  });
});

describe("memory dream — the Dreams contract", () => {
  test("dream writes pending-only workflow rows and never touches existing memories", () => {
    const { db, runId } = repo();
    closedPlan(db, runId, "green work", { verifiedBy: "deterministic", confidence: "green" });
    const preexisting = db.insertMemory({
      projectKey: "proj",
      kind: "note",
      content: "untouchable user note",
      evidenceSource: "human",
      origin: "user",
      status: "pinned",
    });
    const before = JSON.stringify(db.getMemory(preexisting));

    const report = runDream(db, "proj");
    expect(report.added).toHaveLength(1);
    const row = db.getMemory(report.added[0]!)!;
    expect(row.kind).toBe("workflow");
    expect(row.status).toBe("pending"); // never auto-activates
    expect(row.evidence_source).toBe("gate");
    expect(JSON.parse(row.citations!)).toContain("rec-g1");
    expect(JSON.stringify(db.getMemory(preexisting))).toBe(before); // input untouched
  });

  test("a re-dream is idempotent; a rejected candidate is never resurrected", () => {
    const { db, runId } = repo();
    closedPlan(db, runId, "green work", { verifiedBy: "deterministic", confidence: "green" });
    const first = runDream(db, "proj");
    expect(first.added).toHaveLength(1);
    const again = runDream(db, "proj");
    expect(again.added).toHaveLength(0);
    expect(again.skippedExisting).toBe(1);
    // Reject it — the next dream must NOT bring it back.
    db.setMemoryStatus(first.added[0]!, "rejected", "user");
    const after = runDream(db, "proj");
    expect(after.added).toHaveLength(0);
  });

  test("the drain dispatches dream jobs to runDream", async () => {
    const { db, runId } = repo();
    closedPlan(db, runId, "green work", { verifiedBy: "deterministic", confidence: "green" });
    db.enqueueMemoryJob({ kind: "dream", sessionId: runId });
    await drainMemoryJobs({
      db,
      extract: async () => null,
      projectKeyFor: () => "proj",
    });
    expect(db.listMemoryJobs("done")).toHaveLength(1);
    expect(db.listMemories("proj").filter((m) => m.kind === "workflow")).toHaveLength(1);
  });
});

describe("memory dream — procedure:known replay", () => {
  test("matches only CONFIRMED workflows against the task's goal overlap", () => {
    const { db } = repo();
    const active = db.insertMemory({
      projectKey: "proj",
      kind: "workflow",
      content: "Verified workflow — fix the parser tests:\n1. ...",
      trigger: "fix the parser tests",
      evidenceSource: "gate",
      origin: "scribe",
      status: "active",
    });
    db.insertMemory({
      projectKey: "proj",
      kind: "workflow",
      content: "Verified workflow — deploy the service:\n1. ...",
      trigger: "deploy the service",
      evidenceSource: "gate",
      origin: "scribe",
      status: "pending", // unconfirmed → never matches
    });

    expect(knownProcedureFor(db, "proj", "please fix the parser tests again")?.id).toBe(active);
    expect(knownProcedureFor(db, "proj", "deploy the service to staging")).toBeNull(); // pending
    expect(knownProcedureFor(db, "proj", "write brand new docs")).toBeNull(); // no overlap
  });

  test("non-workflow active memories never match", () => {
    const { db } = repo();
    db.insertMemory({
      projectKey: "proj",
      kind: "lesson",
      content: "always fix the parser tests first",
      trigger: "fix the parser tests",
      evidenceSource: "gate",
      origin: "scribe",
      status: "active",
    });
    expect(knownProcedureFor(db, "proj", "fix the parser tests")).toBeNull();
  });

  test("a matching confirmed workflow puts procedure:known on the recommend wire", async () => {
    const { AssistantMessage, registerFauxProvider, registerModel, resetModelRegistry } =
      await import("../src/ai/index.ts");
    const { resetProviderRegistration, resetRegistry, text } = await import("../src/ai/index.ts");
    const { CostMeter, MinimaAgent, MinimaClient, MinimaRouter, ModelMapping, harnessConfig } =
      await import("../src/minima/index.ts");
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    const FAUX = {
      id: "test-faux",
      provider: "faux",
      api: "faux",
      name: "Faux",
      cost: { input: 1, output: 2 },
      context_window: 8192,
      max_tokens: 4096,
    };
    registerModel(FAUX);
    const reg = registerFauxProvider([FAUX]);
    const recommendBodies: string[] = [];
    const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(url);
      if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
        recommendBodies.push(init?.body ?? "");
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
            ranked: [],
            confidence: 0.8,
            decision_basis: "memory",
            threshold_used: 0.5,
            classified_task_type: "code",
            classified_difficulty: "easy",
            catalog_version: "v1",
          }),
        };
      }
      return { status: 200, json: async () => ({ accepted: true }) };
    };
    const config = harnessConfig({
      candidates: ["test-faux"],
      allowOffline: false,
      minimaApiKey: "k",
      bigPlan: false,
    });
    const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
    const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
    const { db, runId } = repo();
    db.insertMemory({
      projectKey: "proj",
      kind: "workflow",
      content: "Verified workflow — fix the parser tests:\n1. ...",
      trigger: "fix the parser tests",
      evidenceSource: "gate",
      origin: "scribe",
      status: "active",
    });
    const agent = new MinimaAgent({ config, router, meter: new CostMeter(), tools: [] });
    agent.db = db;
    agent.runId = runId;
    reg.setResponses([
      new AssistantMessage({ content: [text("ok")], stop_reason: "endTurn" }),
      new AssistantMessage({ content: [text("ok")], stop_reason: "endTurn" }),
    ]);

    await agent.promptRouted("fix the parser tests");
    expect(JSON.parse(recommendBodies.at(-1)!).task.tags).toContain("procedure:known");

    await agent.promptRouted("write completely unrelated docs");
    const last = JSON.parse(recommendBodies.at(-1)!);
    expect(JSON.stringify(last.task.tags ?? [])).not.toContain("procedure:known");
  });
});
