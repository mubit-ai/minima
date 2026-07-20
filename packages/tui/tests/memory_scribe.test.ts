import { describe, expect, test } from "bun:test";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  type ScribeCandidate,
  type ScribeSignal,
  applyRecurrenceGate,
  drainMemoryJobs,
  mineSignals,
  parseCandidates,
  runScribePass,
} from "../src/minima/index.ts";

// B2 memory scribe: job queue lifecycle, ledger signal mining, recurrence gate, extraction
// stub → reconciliation + provenance activation, budget skip, staleness sweep. Hermetic —
// the ExtractFn seam replaces the routed LLM call everywhere.

function freshDb(): { db: MinimaDb; runId: string } {
  const db = new MinimaDb(":memory:");
  db.ensureProject("proj");
  const runId = db.startRun({ projectKey: "proj" });
  return { db, runId };
}

/** Seed one plan with a step and return {planId, stepId}. */
function seedPlan(db: MinimaDb, runId: string, content: string, verify?: string) {
  db.upsertPlanFromTodos(runId, [{ content, status: "in_progress", verify: verify ?? null }]);
  const plan = db.getActivePlan(runId)!;
  const step = db.getPlanSteps(plan.id)[0]!;
  return { planId: plan.id, stepId: step.id };
}

function gate(
  db: MinimaDb,
  o: {
    planId: string;
    stepId: string;
    runId: string;
    outcome: "verified" | "failed";
    recId?: string;
  },
): string {
  return db.insertGate({
    planId: o.planId,
    stepId: o.stepId,
    kind: "step_check",
    outcome: o.outcome,
    sessionId: o.runId,
    recId: o.recId ?? null,
  });
}

/** A repo whose ledger holds one red→red→green flip (weight 2 → passes the recurrence gate). */
function flippedRepo() {
  const { db, runId } = freshDb();
  const { planId, stepId } = seedPlan(db, runId, "fix the parser", "bun test parser");
  gate(db, { planId, stepId, runId, outcome: "failed", recId: "rec-1" });
  gate(db, { planId, stepId, runId, outcome: "failed", recId: "rec-2" });
  gate(db, { planId, stepId, runId, outcome: "verified", recId: "rec-3" });
  return { db, runId };
}

const stubExtractor =
  (candidates: ScribeCandidate[] | null, calls: string[] = []) =>
  async (_evidence: ScribeSignal[], prompt: string) => {
    calls.push(prompt);
    return candidates;
  };

describe("memory scribe — job queue", () => {
  test("enqueue → FIFO claim → finish; not_before defers; crash requeue recovers", () => {
    const { db, runId } = freshDb();
    const a = db.enqueueMemoryJob({ kind: "reflect", sessionId: runId });
    const b = db.enqueueMemoryJob({ kind: "reflect", sessionId: runId });
    const later = db.enqueueMemoryJob({
      kind: "consolidate",
      notBefore: Date.now() / 1000 + 3600,
    });

    const first = db.claimNextMemoryJob()!;
    expect(first.id).toBe(a);
    expect(first.status).toBe("running");
    const second = db.claimNextMemoryJob()!;
    expect(second.id).toBe(b);
    // The deferred job is not runnable yet.
    expect(db.claimNextMemoryJob()).toBeNull();

    db.finishMemoryJob(second.id, "done");
    // Simulated crash: `a` was left running → startup requeues exactly it.
    expect(db.requeueRunningMemoryJobs()).toBe(1);
    expect(db.claimNextMemoryJob()!.id).toBe(a);
    // Only the deferred job remains queued (a is running again, b is done).
    expect(db.listMemoryJobs("queued").map((j) => j.id)).toEqual([later]);
    expect(
      db
        .listMemoryJobs()
        .map((j) => j.id)
        .sort(),
    ).toEqual([a, b, later].sort());
  });
});

describe("memory scribe — mining + recurrence", () => {
  test("red→green becomes a gate_flip; unresolved failures a verified_failure", () => {
    const { db, runId } = freshDb();
    const { planId, stepId } = seedPlan(db, runId, "fix the parser", "bun test parser");
    gate(db, { planId, stepId, runId, outcome: "failed", recId: "rec-1" });
    gate(db, { planId, stepId, runId, outcome: "failed", recId: "rec-2" });
    gate(db, { planId, stepId, runId, outcome: "verified", recId: "rec-3" });

    const signals = mineSignals(db, "proj");
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.kind).toBe("gate_flip");
    expect(s.detail).toContain("failed its check 2x, then passed");
    expect(s.detail).toContain("bun test parser");
    expect(s.recIds.sort()).toEqual(["rec-1", "rec-2", "rec-3"]);
    expect(s.gateIds).toHaveLength(3);
  });

  test("user reject/steer mines as an immediate correction that skips the recurrence gate", () => {
    const { db, runId } = freshDb();
    const { planId, stepId } = seedPlan(db, runId, "write the migration");
    const gid = gate(db, { planId, stepId, runId, outcome: "verified" });
    db.recordUserSignal(gid, "reject", "never edit shipped migration batches");

    const signals = mineSignals(db, "proj");
    const corr = signals.find((s) => s.kind === "user_correction")!;
    expect(corr.immediate).toBe(true);
    expect(corr.detail).toContain("never edit shipped migration batches");
    // One occurrence — the recurrence gate keeps it anyway.
    expect(applyRecurrenceGate(signals).some((s) => s.kind === "user_correction")).toBe(true);
  });

  test("recurrence gate drops one-off non-immediate patterns, keeps repeats + weights", () => {
    const mk = (pattern: string, weight = 1, immediate = false): ScribeSignal => ({
      kind: "gate_flip",
      pattern,
      detail: pattern,
      recIds: [],
      gateIds: [],
      ts: 1,
      immediate,
      weight,
    });
    const kept = applyRecurrenceGate([mk("a"), mk("a"), mk("b"), mk("c", 2)]);
    // "a" repeats, "c" folded two failures into one signal (weight 2), "b" is a one-off.
    expect(kept.map((s) => s.pattern)).toEqual(["a", "a", "c"]);
  });
});

describe("memory scribe — extraction parsing", () => {
  test("parses the JSON array out of surrounding prose; caps at 3; validates kinds", () => {
    const reply = `Here you go:\n[
      {"kind":"lesson","content":"run bun test before pushing","evidence":[1]},
      {"kind":"bogus","content":"dropped"},
      {"kind":"guardrail","content":"never force-push main","trigger":"git push"},
      {"kind":"note","content":"a"},{"kind":"note","content":"b"},{"kind":"note","content":"c"}
    ]\nHope that helps!`;
    const out = parseCandidates(reply)!;
    expect(out).toHaveLength(3);
    expect(out[0]!.kind).toBe("lesson");
    expect(out[1]!.trigger).toBe("git push");
  });

  test("garbage and non-array replies are null (extractor failure, not empty success)", () => {
    expect(parseCandidates("no json here")).toBeNull();
    expect(parseCandidates('{"kind":"lesson"}')).toBeNull();
    expect(parseCandidates("[]")).toEqual([]);
  });
});

describe("memory scribe — pass", () => {
  test("gate-cited candidates auto-activate with gate provenance; others stay pending", async () => {
    const { db } = flippedRepo();
    const report = await runScribePass({
      db,
      projectKey: "proj",
      extract: stubExtractor([
        { kind: "lesson", content: "parser tests need the fixture reset first", evidence: [1] },
        { kind: "note", content: "the team prefers small diffs", evidence: [] },
      ]),
    });
    expect(report.added).toBe(2);
    const rows = db.listMemories("proj");
    const lesson = rows.find((r) => r.kind === "lesson")!;
    expect(lesson.status).toBe("active");
    expect(lesson.evidence_source).toBe("gate");
    expect(lesson.origin).toBe("scribe");
    expect(JSON.parse(lesson.citations!)).toContain("rec-1");
    const note = rows.find((r) => r.kind === "note")!;
    expect(note.status).toBe("pending");
    expect(note.evidence_source).toBe("none");
  });

  test("no gated signals → skip, extractor never called", async () => {
    const { db } = freshDb();
    const calls: string[] = [];
    const report = await runScribePass({
      db,
      projectKey: "proj",
      extract: stubExtractor([], calls),
    });
    expect(report.skipped).toBe("no_signals");
    expect(calls).toHaveLength(0);
  });

  test("one-off signal stays below the recurrence gate — no extraction", async () => {
    const { db, runId } = freshDb();
    const { planId, stepId } = seedPlan(db, runId, "one-off step");
    gate(db, { planId, stepId, runId, outcome: "failed" });
    const calls: string[] = [];
    const report = await runScribePass({
      db,
      projectKey: "proj",
      extract: stubExtractor([], calls),
    });
    expect(report.signals).toBe(1);
    expect(report.skipped).toBe("no_signals");
    expect(calls).toHaveLength(0);
  });

  test("near-duplicate NOOPs; a rejected memory is never resurrected", async () => {
    const { db } = flippedRepo();
    const existing = db.insertMemory({
      projectKey: "proj",
      kind: "lesson",
      content: "parser tests need the fixture reset before running",
      evidenceSource: "human",
      origin: "user",
      status: "active",
    });
    const rejected = db.insertMemory({
      projectKey: "proj",
      kind: "note",
      content: "always use tabs for indentation in this repository",
      evidenceSource: "none",
      origin: "scribe",
      status: "rejected",
    });
    const report = await runScribePass({
      db,
      projectKey: "proj",
      extract: stubExtractor([
        {
          kind: "lesson",
          content: "parser tests need the fixture reset before running",
          evidence: [1],
        },
        {
          kind: "note",
          content: "always use tabs for indentation in this repository",
          evidence: [],
        },
      ]),
    });
    expect(report.noops).toBe(2);
    expect(report.added).toBe(0);
    expect(db.listMemories("proj", { includeInvalidated: true })).toHaveLength(2);
    const ops = db.listMemoryEvents(existing).map((e) => e.op);
    expect(ops).toContain("noop");
    expect(db.getMemory(rejected)!.status).toBe("rejected"); // untouched
  });

  test("moderate similarity to a scribe-authored row UPDATEs it in place", async () => {
    const { db } = flippedRepo();
    const prior = db.insertMemory({
      projectKey: "proj",
      kind: "lesson",
      content: "parser test suite needs fixtures",
      evidenceSource: "gate",
      origin: "scribe",
      status: "active",
    });
    const report = await runScribePass({
      db,
      projectKey: "proj",
      extract: stubExtractor([
        {
          kind: "lesson",
          content: "parser test suite needs fixtures reset and seeded before each run",
          evidence: [1],
        },
      ]),
    });
    expect(report.updated).toBe(1);
    expect(report.added).toBe(0);
    const row = db.getMemory(prior)!;
    expect(row.content).toContain("reset and seeded");
    expect(row.status).toBe("active"); // status is preserved, only content refreshed
    expect(db.listMemoryEvents(prior).map((e) => e.op)).toContain("update");
  });

  test("budget floor skips the pass before any extraction", async () => {
    const { db, runId } = flippedRepo();
    const budget = {
      status: () => ({ limitUsd: 1, spentUsd: 0.9, reservedUsd: 0, remainingUsd: 0.1 }),
    };
    const calls: string[] = [];
    const report = await runScribePass({
      db,
      projectKey: "proj",
      extract: stubExtractor([], calls),
      // biome-ignore lint/suspicious/noExplicitAny: structural stub of BudgetLedger.status
      budget: budget as any,
    });
    expect(report.skipped).toBe("budget");
    expect(calls).toHaveLength(0);
    void runId;
  });

  test("extractor null (offline) → skipped, nothing written", async () => {
    const { db } = flippedRepo();
    const report = await runScribePass({
      db,
      projectKey: "proj",
      extract: stubExtractor(null),
    });
    expect(report.skipped).toBe("extractor");
    expect(db.listMemories("proj")).toHaveLength(0);
  });
});

describe("memory scribe — staleness sweep", () => {
  test("a workflow older than the last toolchain-manifest change is invalidated", async () => {
    const { db, runId } = freshDb();
    const { planId, stepId } = seedPlan(db, runId, "bump deps");
    const stale = db.insertMemory({
      projectKey: "proj",
      kind: "workflow",
      content: "build with `bun run build` then smoke the binary",
      evidenceSource: "gate",
      origin: "scribe",
      status: "active",
      watermarkTs: Date.now() / 1000 - 3600,
    });
    const fresh = db.insertMemory({
      projectKey: "proj",
      kind: "lesson",
      content: "lessons survive toolchain churn",
      evidenceSource: "gate",
      origin: "scribe",
      status: "active",
      watermarkTs: Date.now() / 1000 - 3600,
    });
    db.insertFileChange({ planId, stepId, path: "packages/tui/package.json", kind: "modified" });

    const report = await runScribePass({
      db,
      projectKey: "proj",
      extract: stubExtractor(null),
    });
    expect(report.invalidated).toBe(1);
    expect(db.getMemory(stale)!.status).toBe("invalidated");
    expect(db.getMemory(fresh)!.status).toBe("active");
  });

  test("a memory naming a vanished chosen model is invalidated", async () => {
    const { db, runId } = freshDb();
    db.writeDecision({
      recId: "rec-x",
      runId,
      taskLabel: "t",
      chosenModel: "old-model-9000",
      decisionBasis: "memory",
      confidence: 0.5,
      thresholdUsed: 0.5,
      ranked: [],
      estCostUsd: 0,
      actualCostUsd: 0,
      quality: null,
      judged: false,
      outcome: "success",
      turns: 1,
      latencyMs: 1,
    });
    const doomed = db.insertMemory({
      projectKey: "proj",
      kind: "lesson",
      content: "old-model-9000 is best for refactors",
      evidenceSource: "none",
      origin: "scribe",
      status: "active",
    });
    await runScribePass({
      db,
      projectKey: "proj",
      extract: stubExtractor(null),
      modelExists: () => false,
    });
    expect(db.getMemory(doomed)!.status).toBe("invalidated");
  });
});

describe("memory scribe — drain", () => {
  test("drains FIFO, resolves each job's project, and a throwing pass fails only its job", async () => {
    const { db, runId } = flippedRepo();
    db.enqueueMemoryJob({ kind: "reflect", sessionId: runId });
    db.enqueueMemoryJob({ kind: "reflect", sessionId: "no-such-run" });
    db.enqueueMemoryJob({ kind: "reflect", sessionId: runId });

    let calls = 0;
    const reports = await drainMemoryJobs(
      {
        db,
        extract: async () => {
          calls += 1;
          if (calls === 1) throw new Error("boom");
          return null;
        },
        projectKeyFor: (job) =>
          job.session_id ? (db.getRun(job.session_id)?.project_key ?? null) : null,
      },
      10,
    );
    // Job 1's pass threw → failed; job 2 had no resolvable project → failed without an
    // extract call; job 3 completed. The queue never wedges on a bad pass.
    expect(calls).toBe(2);
    expect(reports).toHaveLength(1);
    const statuses = db.listMemoryJobs().map((j) => j.status);
    expect(statuses.filter((s) => s === "done")).toHaveLength(1);
    expect(statuses.filter((s) => s === "failed")).toHaveLength(2);
  });
});
