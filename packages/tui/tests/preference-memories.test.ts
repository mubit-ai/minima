import { describe, expect, test } from "bun:test";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  SCRIBE_SYSTEM,
  type ScribeCandidate,
  type ScribeSignal,
  parseCandidates,
  runScribePass,
} from "../src/minima/index.ts";

// PR-2 preference memories: 'preference' joins the app-level kind union (no SQL CHECK —
// the shipped v12 batch is untouched), the scribe may distill it from user corrections,
// and provenance rules are unchanged (non-gate-cited → pending until /memory confirm).

function freshDb(): { db: MinimaDb; runId: string } {
  const db = new MinimaDb(":memory:");
  db.ensureProject("proj");
  const runId = db.startRun({ projectKey: "proj" });
  return { db, runId };
}

describe("preference memories — ledger flow", () => {
  test("insert → list → pin → confirm → reject round-trips the new kind", () => {
    const { db } = freshDb();
    const id = db.insertMemory({
      projectKey: "proj",
      kind: "preference",
      content: "Prefer small stacked PRs over one large diff in this repo.",
      evidenceSource: "human",
      origin: "user",
      status: "active",
      actor: "user",
    });
    let row = db.listMemories("proj").find((r) => r.id === id);
    expect(row?.kind).toBe("preference");
    expect(row?.status).toBe("active");
    expect(row?.evidence_source).toBe("human");

    expect(db.setMemoryStatus(id, "pinned", "user")).toBe(true);
    expect(db.getMemory(id)?.status).toBe("pinned");
    expect(db.setMemoryStatus(id, "active", "user")).toBe(true);
    expect(db.getMemory(id)?.status).toBe("active");
    expect(db.setMemoryStatus(id, "rejected", "user")).toBe(true);
    row = db.getMemory(id) ?? undefined;
    expect(row?.status).toBe("rejected");
    expect(row?.kind).toBe("preference");
  });

  test("a pending preference candidate confirms active (the /memory confirm flow)", () => {
    const { db } = freshDb();
    const id = db.insertMemory({
      projectKey: "proj",
      kind: "preference",
      content: "User prefers conventional commits with scoped subjects.",
      evidenceSource: "human",
      origin: "scribe",
      status: "pending",
      actor: "scribe",
    });
    expect(db.listMemories("proj", { statuses: ["pending"] })[0]?.kind).toBe("preference");
    expect(db.setMemoryStatus(id, "active", "user")).toBe(true);
    expect(db.getMemory(id)?.status).toBe("active");
  });
});

describe("preference memories — scribe candidates", () => {
  test("parseCandidates accepts kind 'preference' and still drops unknown kinds", () => {
    const parsed = parseCandidates(
      'noise before [{"kind":"preference","content":"User prefers uv over pip here.","evidence":[1]},' +
        '{"kind":"bogus","content":"dropped"}] noise after',
    );
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.kind).toBe("preference");
    expect(parsed?.[0]?.content).toBe("User prefers uv over pip here.");
  });

  test("extraction guidance names the preference kind (user-correction sourced)", () => {
    expect(SCRIBE_SYSTEM).toContain("preference (");
    expect(SCRIBE_SYSTEM).toContain("user_correction");
  });

  test("a user-correction pass may yield a preference row — provenance unchanged (pending, human)", async () => {
    const { db, runId } = freshDb();
    db.upsertPlanFromTodos(runId, [{ content: "write the migration", status: "in_progress" }]);
    const plan = db.getActivePlan(runId)!;
    const stepId = db.getPlanSteps(plan.id)[0]!.id;
    const gateId = db.insertGate({
      planId: plan.id,
      stepId,
      kind: "step_check",
      outcome: "verified",
      sessionId: runId,
    });
    db.recordUserSignal(gateId, "steer", "always use bun, never npm, in this repo");

    const candidate: ScribeCandidate = {
      kind: "preference",
      content: "The user wants bun (never npm) used for all package operations here.",
      evidence: [1],
    };
    const report = await runScribePass({
      db,
      projectKey: "proj",
      extract: async (_evidence: ScribeSignal[], _prompt: string) => [candidate],
    });
    expect(report.added).toBe(1);

    const row = db.listMemories("proj").find((r) => r.kind === "preference");
    expect(row).toBeTruthy();
    expect(row?.origin).toBe("scribe");
    expect(row?.evidence_source).toBe("human");
    expect(row?.status).toBe("pending");
    expect(JSON.parse(row?.citations ?? "[]")).toContain(gateId);
  });
});
