import { describe, expect, test } from "bun:test";
import { MinimaDb } from "../src/db/minima_db.ts";
import { RUNG_NAMES, makeFailureMatcher, writeRecoveryGate } from "../src/minima/failure_kind.ts";
import { buildFeedbackNotes } from "../src/minima/runtime.ts";

// E2 ladder-v2: named rung states on decisions/gates/feedback notes. The diagnostics
// unlock is covered through the runtime in failure-kind-runtime.test.ts territory; here
// the naming contract itself is pinned.

describe("named rungs", () => {
  test("every intervention maps to its H-RePlan rung name", () => {
    expect(RUNG_NAMES).toEqual({
      backoff: "retry_step",
      escalate: "revise_step",
      replan: "replan",
    });
  });

  test("the matcher's decisions carry the rung through every path", () => {
    const matcher = makeFailureMatcher();
    const backoff = matcher({
      hardError: true,
      errorText: "429 rate limited",
      judgeFailed: false,
      gateFailed: false,
    });
    expect(backoff?.rung).toBe("retry_step");

    const escalate = matcher({
      hardError: false,
      errorText: null,
      judgeFailed: true,
      gateFailed: false,
    });
    expect(escalate?.rung).toBe("revise_step");

    const m2 = makeFailureMatcher();
    m2({ hardError: false, errorText: null, judgeFailed: false, gateFailed: true });
    const replan = m2({
      hardError: false,
      errorText: null,
      judgeFailed: false,
      gateFailed: true,
    });
    expect(replan?.rung).toBe("replan");
    expect(replan?.intervention).toBe("replan");
  });

  test("recovery gate rows record the rung in their factors", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    db.upsertPlanFromTodos(runId, [{ content: "s", status: "in_progress" }]);
    const matcher = makeFailureMatcher();
    const decision = matcher({
      hardError: true,
      errorText: "socket timeout",
      judgeFailed: false,
      gateFailed: false,
    })!;
    writeRecoveryGate({ db, sessionId: runId, agentId: null }, decision);
    const gate = db.getGates(db.getActivePlan(runId)!.id).find((g) => g.kind === "recovery")!;
    expect(JSON.parse(gate.factors_json ?? "{}")).toMatchObject({
      rung: "retry_step",
      intervention: "backoff",
    });
  });
});

describe("feedback notes composition", () => {
  test("provenance first, recovery rung appended; pre-E2 shapes unchanged without a rung", () => {
    expect(buildFeedbackNotes(null, true, null)).toBeUndefined();
    expect(buildFeedbackNotes(null, false, null)).toBe("unlabeled");
    expect(buildFeedbackNotes({ confidence: "green" }, false, null)).toBe(
      "verified_by=deterministic;tier=green",
    );
    expect(buildFeedbackNotes(null, true, "revise_step")).toBe("recovery=revise_step");
    expect(buildFeedbackNotes(null, false, "replan")).toBe("unlabeled;recovery=replan");
    expect(buildFeedbackNotes({ confidence: "red" }, false, "replan")).toBe(
      "verified_by=deterministic;tier=red;recovery=replan",
    );
  });
});
