import { describe, expect, test } from "bun:test";
import {
  type MemoryClient,
  MubitHarnessMemory,
  NoopHarnessMemory,
  formatRecallBlock,
} from "../src/minima/memory.ts";

/** A fake @mubit-ai/sdk Client that records calls (no network). */
class FakeClient implements MemoryClient {
  remembers: Record<string, unknown>[] = [];
  outcomes: Record<string, unknown>[] = [];
  reflects: Record<string, unknown>[] = [];
  checkpoints: Record<string, unknown>[] = [];
  recallReqs: Record<string, unknown>[] = [];
  recallReturn: unknown = [];
  throwOn = new Set<string>();

  async recall(req: Record<string, unknown>): Promise<unknown> {
    if (this.throwOn.has("recall")) throw new Error("down");
    this.recallReqs.push(req);
    return this.recallReturn;
  }
  async remember(req: Record<string, unknown>): Promise<unknown> {
    if (this.throwOn.has("remember")) throw new Error("down");
    this.remembers.push(req);
    return { record_id: "r1" };
  }
  async recordOutcome(req: Record<string, unknown>): Promise<unknown> {
    this.outcomes.push(req);
    return {};
  }
  async reflect(req: Record<string, unknown>): Promise<unknown> {
    this.reflects.push(req);
    return {};
  }
  async checkpoint(req: Record<string, unknown>): Promise<unknown> {
    this.checkpoints.push(req);
    return {};
  }
}

const base = {
  task: "build a GraphQL resolver",
  modelId: "haiku",
  outcome: "success",
  costUsd: 0.0012,
  latencyMs: 1200,
  turns: 2,
};

describe("MubitHarnessMemory", () => {
  test("recordOutcome writes a trace + score, attributed to the recommendation", async () => {
    const c = new FakeClient();
    await new MubitHarnessMemory(c, "s1").recordOutcome({
      ...base,
      recommendationId: "rec-9",
      quality: 0.87,
    });
    expect(c.remembers).toHaveLength(1);
    expect(c.remembers[0]!.intent).toBe("trace");
    expect(c.remembers[0]!.session_id).toBe("s1");
    expect(c.remembers[0]!.idempotency_key).toBe("rec-9");
    // Lane partition: harness traces never share a lane with the Minima server's
    // typed OutcomeRecord writes (lane=minima:<namespace>).
    expect(c.remembers[0]!.lane).toBe("harness");
    expect(String(c.remembers[0]!.content)).toContain("haiku");
    expect(c.outcomes).toHaveLength(1);
    expect(c.outcomes[0]!.signal).toBe(0.87);
    expect(c.outcomes[0]!.reference_id).toBe("rec-9");
    expect(c.outcomes[0]!.outcome).toBe("success");
  });

  test("abstain (quality null) writes the trace but NO score", async () => {
    const c = new FakeClient();
    await new MubitHarnessMemory(c, "s1").recordOutcome({
      ...base,
      recommendationId: "rec-1",
      quality: null,
    });
    expect(c.remembers).toHaveLength(1);
    expect(c.outcomes).toHaveLength(0);
  });

  test("no-op without a recommendationId (nothing to attribute)", async () => {
    const c = new FakeClient();
    await new MubitHarnessMemory(c, "s1").recordOutcome({
      ...base,
      recommendationId: "",
      quality: 0.9,
    });
    expect(c.remembers).toHaveLength(0);
    expect(c.outcomes).toHaveLength(0);
  });

  test("recall extracts snippets (obj/str), skips junk, caps to limit", async () => {
    const c = new FakeClient();
    c.recallReturn = {
      entries: [{ content: "lesson A" }, { text: "lesson B" }, { nope: 1 }, "lesson D", "lesson E"],
    };
    const out = await new MubitHarnessMemory(c, "s1").recall("q", 3);
    expect(out).toEqual(["lesson A", "lesson B", "lesson D"]);
  });

  test("recall passes the (stable per-repo) session_id — the SDK requires it — and entry types", async () => {
    const c = new FakeClient();
    c.recallReturn = [{ content: "a" }];
    await new MubitHarnessMemory(c, "s1").recall("q");
    // The SDK rejects recall without a session_id/run_id; a stable per-repo id (set by the
    // caller) makes recall surface prior outcomes across runs.
    expect(c.recallReqs[0]!.session_id).toBe("s1");
    expect(c.recallReqs[0]!.entry_types).toEqual(["lesson", "rule", "observation"]);
  });

  test("recall on blank task returns []", async () => {
    const c = new FakeClient();
    c.recallReturn = [{ content: "x" }];
    expect(await new MubitHarnessMemory(c, "s1").recall("   ")).toEqual([]);
  });

  test("fail-open: recall swallows client errors", async () => {
    const c = new FakeClient();
    c.throwOn.add("recall");
    expect(await new MubitHarnessMemory(c, "s1").recall("q")).toEqual([]);
  });

  test("fail-open: recordOutcome swallows client errors", async () => {
    const c = new FakeClient();
    c.throwOn.add("remember");
    await new MubitHarnessMemory(c, "s1").recordOutcome({
      ...base,
      recommendationId: "r",
      quality: 0.9,
    });
    expect(c.outcomes).toHaveLength(0);
  });

  test("endSession reflects + checkpoints for the session", async () => {
    const c = new FakeClient();
    await new MubitHarnessMemory(c, "s7").endSession();
    expect(c.reflects[0]!.session_id).toBe("s7");
    expect(c.checkpoints[0]!.session_id).toBe("s7");
    expect(c.checkpoints[0]!.label).toBe("session-end");
  });
});

describe("NoopHarnessMemory + formatRecallBlock", () => {
  test("noop is inert", async () => {
    const m = new NoopHarnessMemory();
    expect(await m.recall("q")).toEqual([]);
    await m.recordOutcome({ ...base, recommendationId: "r", quality: 0.9 });
    await m.endSession();
  });

  test("formatRecallBlock renders a delimited, reference-only section", () => {
    const b = formatRecallBlock(["alpha", "beta"]);
    expect(b).toContain("prior_learnings");
    expect(b).toContain("- alpha");
    expect(b).toContain("- beta");
    // Framed as passive context, not an instruction — so a fresh chat doesn't act on recalled
    // habits (e.g. run ls) before the user asks. Regression guard for the "unsolicited ls" bug.
    expect(b.toLowerCase()).toContain("reference only");
    expect(b.toLowerCase()).toContain("do not");
  });
});
