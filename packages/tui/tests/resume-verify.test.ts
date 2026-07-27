import { describe, expect, test } from "bun:test";
import { MinimaDb } from "../src/db/minima_db.ts";
import { reverifyNotice, reverifyOnResume, stepToReverify } from "../src/session/resume_verify.ts";

// D2: on resume the working tree is co-equal state — re-run the in-progress step's
// verify (consent-gated), re-baseline on divergence, and audit the whole thing. Checks
// run real bash (`true`/`false`) — hermetic and instant.

function fixture(verify: string | null, baseline?: "red" | "green") {
  const db = new MinimaDb(":memory:");
  db.ensureProject("proj");
  const resumed = db.startRun({ projectKey: "proj" });
  const current = db.startRun({ projectKey: "proj" });
  db.upsertPlanFromTodos(resumed, [
    { content: "done step", status: "completed" },
    { content: "active step", status: "in_progress", verify },
  ]);
  const plan = db.getActivePlan(resumed)!;
  const step = db.getPlanSteps(plan.id).find((s) => s.status === "in_progress")!;
  if (baseline) db.setStepBaseline(step.id, baseline);
  return { db, resumed, current, step };
}

describe("resume re-verify", () => {
  test("finds the in-progress step with a verify (and nothing else)", () => {
    const { db, resumed } = fixture("true");
    expect(stepToReverify(db, resumed)?.content).toBe("active step");
    const none = fixture(null);
    expect(stepToReverify(none.db, none.resumed)).toBeNull();
  });

  test("matching baseline → silent proceed (no re-baseline, event says diverged=false)", async () => {
    const { db, resumed, current, step } = fixture("true", "green");
    const r = await reverifyOnResume({
      db,
      planSessionId: resumed,
      eventRunId: current,
      consent: () => true,
    });
    expect(r?.fresh).toBe("green");
    expect(r?.diverged).toBe(false);
    expect(reverifyNotice(r)).toBeNull();
    expect(
      db.getPlanSteps(db.getActivePlan(resumed)!.id).find((s) => s.id === step.id)!.baseline,
    ).toBe("green");
    const ev = db.getRunEvents(current).find((e) => e.type === "resume_reverify")!;
    expect(JSON.parse(ev.payload)).toMatchObject({ diverged: false, fresh_baseline: "green" });
  });

  test("diverged baseline → re-baseline from reality + 🟡 notice + audit event", async () => {
    const { db, resumed, current, step } = fixture("false", "green");
    const r = await reverifyOnResume({
      db,
      planSessionId: resumed,
      eventRunId: current,
      consent: () => true,
    });
    expect(r?.fresh).toBe("red");
    expect(r?.diverged).toBe(true);
    expect(reverifyNotice(r)).toContain("green → red");
    expect(
      db.getPlanSteps(db.getActivePlan(resumed)!.id).find((s) => s.id === step.id)!.baseline,
    ).toBe("red");
    const ev = db.getRunEvents(current).find((e) => e.type === "resume_reverify")!;
    expect(JSON.parse(ev.payload)).toMatchObject({ diverged: true, recorded_baseline: "green" });
  });

  test("never-captured baseline → captured now, not flagged as divergence", async () => {
    const { db, resumed, current, step } = fixture("true");
    const r = await reverifyOnResume({
      db,
      planSessionId: resumed,
      eventRunId: current,
      consent: () => true,
    });
    expect(r?.diverged).toBe(false);
    expect(
      db.getPlanSteps(db.getActivePlan(resumed)!.id).find((s) => s.id === step.id)!.baseline,
    ).toBe("green");
  });

  test("MP18 holds: consent denied → the command never runs, skip is reported", async () => {
    const { db, resumed, current, step } = fixture("echo SHOULD_NOT_RUN", "green");
    const r = await reverifyOnResume({
      db,
      planSessionId: resumed,
      eventRunId: current,
      consent: () => false,
    });
    expect(r?.skipped).toBe("consent");
    expect(r?.fresh).toBeNull();
    expect(reverifyNotice(r)).toContain("never approved");
    // Baseline untouched, no audit event claiming a run happened.
    expect(
      db.getPlanSteps(db.getActivePlan(resumed)!.id).find((s) => s.id === step.id)!.baseline,
    ).toBe("green");
    expect(db.getRunEvents(current).filter((e) => e.type === "resume_reverify")).toHaveLength(0);
  });

  test("no active plan / no in-progress verify → null (nothing to say)", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("proj");
    const runId = db.startRun({ projectKey: "proj" });
    expect(
      await reverifyOnResume({
        db,
        planSessionId: runId,
        eventRunId: runId,
        consent: () => true,
      }),
    ).toBeNull();
  });
});

describe("provider session reuse", () => {
  test("applyRehydratedRun adopts the resumed run's provider session id", async () => {
    const { MinimaAgent, harnessConfig, ModelMapping, CostMeter } = await import(
      "../src/minima/index.ts"
    );
    const { registerModel, resetModelRegistry, resetRegistry } = await import("../src/ai/index.ts");
    const { rehydrateRun, applyRehydratedRun } = await import("../src/db/rehydrate.ts");
    resetRegistry();
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
    const db = new MinimaDb(":memory:");
    db.ensureProject("proj");
    const oldRun = db.startRun({ projectKey: "proj", providerSessionId: "sess-original" });
    const agent = new MinimaAgent({
      config: harnessConfig(),
      mapping: new ModelMapping(),
      meter: new CostMeter(),
      model: FAUX,
      tools: [],
    });
    agent.db = db;
    agent.runId = db.startRun({ projectKey: "proj", providerSessionId: agent.sessionId });
    applyRehydratedRun(agent, rehydrateRun(db, oldRun));
    expect(agent.sessionId).toBe("sess-original");
    expect(db.getRun(agent.runId)!.provider_session_id).toBe("sess-original");
  });
});
