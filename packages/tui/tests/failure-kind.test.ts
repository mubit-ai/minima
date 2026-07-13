import { describe, expect, test } from "bun:test";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  type FailureDecision,
  INTERVENTION_TIER,
  isTransientError,
  makeFailureMatcher,
  replanMessage,
  replanPreamble,
  writeRecoveryGate,
} from "../src/minima/failure_kind.ts";

describe("isTransientError", () => {
  test("matches genuine infra/rate-limit/timeout/5xx/network phrasing", () => {
    for (const t of [
      "openai-compat request failed: HTTP 429",
      "openai-compat request failed: HTTP 500",
      "openai-compat request failed: HTTP 503",
      "rate limit exceeded",
      "Rate-limit hit, retry later",
      "too many requests",
      "the model is overloaded (529)",
      "Request timed out",
      "connect ETIMEDOUT 1.2.3.4:443",
      "read ECONNRESET",
      "fetch failed",
      "socket hang up",
      "service unavailable",
    ]) {
      expect(isTransientError(t)).toBe(true);
    }
  });

  test("does NOT match capability/config errors or arbitrary text", () => {
    for (const t of [
      null,
      undefined,
      "",
      "boom",
      "upstream 500", // no "HTTP" prefix → not the structured 5xx signal
      "no API key for provider openai",
      "openai-compat request failed: HTTP 400",
      "openai-compat request failed: HTTP 401",
      "the answer was wrong",
    ]) {
      expect(isTransientError(t as string | null | undefined)).toBe(false);
    }
  });
});

describe("INTERVENTION_TIER", () => {
  test("backoff/escalate are 🟡, replan is 🔴", () => {
    expect(INTERVENTION_TIER.backoff).toBe("yellow");
    expect(INTERVENTION_TIER.escalate).toBe("yellow");
    expect(INTERVENTION_TIER.replan).toBe("red");
  });
});

describe("makeFailureMatcher", () => {
  const sig = (over: Partial<Parameters<ReturnType<typeof makeFailureMatcher>>[0]> = {}) => ({
    hardError: false,
    errorText: null,
    judgeFailed: false,
    gateFailed: false,
    ...over,
  });

  test("no failure → null", () => {
    const m = makeFailureMatcher();
    expect(m(sig())).toBeNull();
  });

  test("transient hard error → backoff (🟡)", () => {
    const m = makeFailureMatcher();
    const d = m(sig({ hardError: true, errorText: "HTTP 429 rate limit" }))!;
    expect(d.kind).toBe("transient");
    expect(d.intervention).toBe("backoff");
    expect(d.tier).toBe("yellow");
  });

  test("non-transient hard error → escalate (capability)", () => {
    const m = makeFailureMatcher();
    const d = m(sig({ hardError: true, errorText: "HTTP 400 bad request" }))!;
    expect(d.kind).toBe("capability");
    expect(d.intervention).toBe("escalate");
  });

  test("judge failure → escalate (capability)", () => {
    const m = makeFailureMatcher();
    const d = m(sig({ judgeFailed: true }))!;
    expect(d.kind).toBe("capability");
    expect(d.intervention).toBe("escalate");
  });

  test("first gate fail escalates; a persistent gate fail becomes structural → replan (🔴)", () => {
    const m = makeFailureMatcher();
    const first = m(sig({ gateFailed: true }))!;
    expect(first.intervention).toBe("escalate");
    const second = m(sig({ gateFailed: true }))!;
    expect(second.kind).toBe("structural");
    expect(second.intervention).toBe("replan");
    expect(second.tier).toBe("red");
    // ...and it stays structural while it keeps failing.
    expect(m(sig({ gateFailed: true }))!.intervention).toBe("replan");
  });

  test("a recovered (non-failing) rung resets the streak, so a fresh gate fail escalates again", () => {
    const m = makeFailureMatcher();
    m(sig({ gateFailed: true })); // streak 1 → escalate
    m(sig({ gateFailed: true })); // streak 2 → replan
    expect(m(sig())).toBeNull(); // recovered → reset
    expect(m(sig({ gateFailed: true }))!.intervention).toBe("escalate"); // back to first-fail
  });

  test("a transient blip between gate fails resets the streak (not persistence of the SAME check)", () => {
    const m = makeFailureMatcher();
    expect(m(sig({ gateFailed: true }))!.intervention).toBe("escalate"); // streak 1
    expect(m(sig({ hardError: true, errorText: "ECONNRESET" }))!.intervention).toBe("backoff");
    expect(m(sig({ gateFailed: true }))!.intervention).toBe("escalate"); // streak reset → 1 again
  });

  test("a real gate fail OUTRANKS a coincidental transient error (escalate, streak preserved)", () => {
    const m = makeFailureMatcher();
    // Both a red check AND a terminal 429 on the same rung → the check wins (not backoff).
    const first = m(sig({ hardError: true, errorText: "HTTP 429 rate limit", gateFailed: true }))!;
    expect(first.intervention).toBe("escalate");
    // The streak is NOT reset by the coincident transient, so persistence still promotes to replan.
    const second = m(sig({ hardError: true, errorText: "HTTP 503", gateFailed: true }))!;
    expect(second.intervention).toBe("replan");
  });
});

describe("replan steer", () => {
  test("preamble / message tell the model to revise the plan and carry the reason", () => {
    const text = replanPreamble("verification still failing after 2 attempts");
    expect(text).toContain("REVISE YOUR PLAN");
    expect(text).toContain("verification still failing after 2 attempts");
    expect((replanMessage("r").content[0] as { text: string }).text).toContain("REVISE YOUR PLAN");
  });
});

describe("writeRecoveryGate", () => {
  const decision: FailureDecision = {
    kind: "structural",
    intervention: "replan",
    tier: "red",
    reason: "verification keeps failing",
  };

  test("writes an audit-only recovery gate (kind=recovery, rec_id NULL, factors carry the decision)", () => {
    const db = new MinimaDb(":memory:");
    db.upsertPlanFromTodos("s1", [{ content: "A", status: "in_progress" }]);
    writeRecoveryGate({ db, sessionId: "s1", agentId: "lead" }, decision);
    const plan = db.getActivePlan("s1")!;
    const gates = db.getGates(plan.id).filter((g) => g.kind === "recovery");
    expect(gates).toHaveLength(1);
    expect(gates[0]!.rec_id).toBeNull();
    expect(gates[0]!.outcome).toBe("unchecked");
    expect(gates[0]!.confidence).toBe("red");
    expect(gates[0]!.verified_by).toBeNull();
    expect(gates[0]!.step_id).toBeNull();
    expect(JSON.parse(gates[0]!.factors_json ?? "{}")).toMatchObject({
      recovery: true,
      kind: "structural",
      intervention: "replan",
      reason: "verification keeps failing",
    });
    db.close();
  });

  test("fail-open: no db / no active plan writes nothing and never throws", () => {
    expect(() =>
      writeRecoveryGate({ db: null, sessionId: "s1", agentId: null }, decision),
    ).not.toThrow();
    const db = new MinimaDb(":memory:");
    expect(() =>
      writeRecoveryGate({ db, sessionId: "no-plan", agentId: null }, decision),
    ).not.toThrow();
    db.close();
  });
});
