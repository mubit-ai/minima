import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BLOB_SPILL_BYTES, MinimaDb, toolSchemaHash } from "../src/db/minima_db.ts";

// D1 (v13): tooling stamps on decisions/gates, resume-mismatch reads, and the >16KB
// blob tier. Hermetic; blobs land in a temp dir.

function decision(db: MinimaDb, runId: string, recId: string): void {
  db.writeDecision({
    recId,
    runId,
    taskLabel: "t",
    chosenModel: "m",
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
}

describe("v13 tooling stamps", () => {
  test("toolSchemaHash is stable across order and sensitive to schema changes", () => {
    const a = { name: "read", parameters: { jsonSchema: { type: "object" } } };
    const b = { name: "bash", parameters: { jsonSchema: { type: "object" } } };
    const h1 = toolSchemaHash([a, b]);
    expect(toolSchemaHash([b, a])).toBe(h1); // order-insensitive
    const b2 = { name: "bash", parameters: { jsonSchema: { type: "object", extra: 1 } } };
    expect(toolSchemaHash([a, b2])).not.toBe(h1); // schema-sensitive
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("stamps flow onto decisions and gates once set; pre-stamp rows stay NULL", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    decision(db, runId, "rec-before");
    db.setVersionStamp({ harnessVersion: "9.9.9", toolSchemaHash: "h".repeat(64) });
    decision(db, runId, "rec-after");
    db.upsertPlanFromTodos(runId, [{ content: "s", status: "in_progress" }]);
    const planId = db.getActivePlan(runId)!.id;
    db.insertGate({ planId, kind: "step_check", outcome: "verified", sessionId: runId });

    const rows = db.getRunDecisions(runId);
    const before = rows.find((r) => r.rec_id === "rec-before")!;
    const after = rows.find((r) => r.rec_id === "rec-after")!;
    expect(before.harness_version).toBeNull();
    expect(after.harness_version).toBe("9.9.9");
    expect(after.tool_schema_hash).toBe("h".repeat(64));
    const gate = db.getGates(planId)[0]! as unknown as Record<string, unknown>;
    expect(gate.harness_version).toBe("9.9.9");
  });

  test("lastRecordedStamp reads the run's newest stamped row (nulls when never stamped)", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    expect(db.lastRecordedStamp(runId).toolSchemaHash).toBeNull();
    db.setVersionStamp({ harnessVersion: "1.0.0", toolSchemaHash: "a".repeat(64) });
    decision(db, runId, "rec-1");
    const rec = db.lastRecordedStamp(runId);
    expect(rec.harnessVersion).toBe("1.0.0");
    expect(rec.toolSchemaHash).toBe("a".repeat(64));
  });
});

describe("v13 blob tier", () => {
  test("a big result spills content-addressed; small ones stay inline-only", () => {
    const blobDir = mkdtempSync(join(tmpdir(), "minima-blobs-"));
    const db = new MinimaDb(":memory:", { blobDir });
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const big = "x".repeat(BLOB_SPILL_BYTES + 100);
    db.writeToolCall({ runId, toolName: "bash", args: {}, result: big, isError: false });
    db.writeToolCall({ runId, toolName: "bash", args: {}, result: "small", isError: false });

    const rows = db.db.query("SELECT result, result_ref FROM tool_calls ORDER BY rowid").all() as {
      result: string;
      result_ref: string | null;
    }[];
    expect(rows[0]!.result.length).toBe(4000); // inline truncation unchanged
    expect(rows[0]!.result_ref).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[1]!.result_ref).toBeNull();
    expect(readdirSync(blobDir)).toHaveLength(1);
    // Rehydrate the full text by ref; junk refs are null.
    expect(db.readBlob(rows[0]!.result_ref!)).toBe(big);
    expect(db.readBlob("0".repeat(64))).toBeNull();
    expect(db.readBlob("../../etc/passwd")).toBeNull();
  });

  test("identical big results dedupe to one blob file", () => {
    const blobDir = mkdtempSync(join(tmpdir(), "minima-blobs-"));
    const db = new MinimaDb(":memory:", { blobDir });
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const big = "y".repeat(BLOB_SPILL_BYTES + 1);
    db.writeToolCall({ runId, toolName: "bash", args: {}, result: big, isError: false });
    db.writeToolCall({ runId, toolName: "read", args: {}, result: big, isError: false });
    expect(readdirSync(blobDir)).toHaveLength(1);
  });

  test(":memory: without a blobDir never spills (no ref, no crash)", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    db.writeToolCall({
      runId,
      toolName: "bash",
      args: {},
      result: "z".repeat(BLOB_SPILL_BYTES + 1),
      isError: false,
    });
    const row = db.db.query("SELECT result_ref FROM tool_calls").get() as {
      result_ref: string | null;
    };
    expect(row.result_ref).toBeNull();
  });
});
