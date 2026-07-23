import { describe, expect, test } from "bun:test";
import { AgentState } from "../src/agent/state.ts";
import { AssistantMessage, text } from "../src/ai/types.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { DoomLoopRing, makeAntiSpiral, toolCallFailed } from "../src/minima/anti_spiral.ts";
import { isHarnessSteerText } from "../src/minima/stop_gate.ts";

const turn = () => new AssistantMessage({ content: [text("...")] });

describe("toolCallFailed", () => {
  test("thrown tool (isError) → failed", () => {
    expect(toolCallFailed({ content: [] }, true)).toBe(true);
  });
  test("errorResult marker (details.error) → failed", () => {
    expect(toolCallFailed({ content: [], details: { error: true } }, false)).toBe(true);
  });
  test("nonzero exit_code is NOT a failure (idempotent probes exit nonzero normally)", () => {
    expect(toolCallFailed({ content: [], details: { exit_code: 1 } }, false)).toBe(false);
  });
  test("plain result → ok", () => {
    expect(toolCallFailed({ content: [text("done")] }, false)).toBe(false);
  });
});

describe("DoomLoopRing", () => {
  const sig = (r: DoomLoopRing, repeats: number) =>
    r.spiralingSignatures(repeats).map((s) => ({ name: s.name, count: s.count }));

  test("spiralingSignatures returns a sig only once it has failed >= repeats", () => {
    const r = new DoomLoopRing();
    r.push("bash", { cmd: "x" }, true);
    r.push("bash", { cmd: "x" }, true);
    expect(sig(r, 3)).toEqual([]); // only 2 so far
    r.push("bash", { cmd: "x" }, true);
    expect(sig(r, 3)).toEqual([{ name: "bash", count: 3 }]);
  });

  test("passing calls with the same sig do not count", () => {
    const r = new DoomLoopRing();
    r.push("bash", { cmd: "x" }, false);
    r.push("bash", { cmd: "x" }, false);
    r.push("bash", { cmd: "x" }, true);
    expect(sig(r, 3)).toEqual([]); // only 1 failing
  });

  test("different args are different signatures", () => {
    const r = new DoomLoopRing();
    r.push("bash", { cmd: "a" }, true);
    r.push("bash", { cmd: "b" }, true);
    r.push("bash", { cmd: "c" }, true);
    expect(sig(r, 3)).toEqual([]);
  });

  test("detects a loop even when each turn ends on a non-failing call (scans the window)", () => {
    const r = new DoomLoopRing();
    r.push("edit", { p: "f" }, true);
    r.push("read", { p: "f" }, false);
    r.push("edit", { p: "f" }, true);
    r.push("read", { p: "f" }, false);
    r.push("edit", { p: "f" }, true);
    r.push("read", { p: "f" }, false); // latest is a success — anchor-on-latest would miss this
    expect(sig(r, 3)).toEqual([{ name: "edit", count: 3 }]);
  });

  test("key order does not change the signature (stable stringify)", () => {
    const r = new DoomLoopRing();
    r.push("edit", { a: 1, b: 2 }, true);
    r.push("edit", { b: 2, a: 1 }, true);
    r.push("edit", { a: 1, b: 2 }, true);
    expect(sig(r, 3)).toEqual([{ name: "edit", count: 3 }]);
  });

  test("capacity evicts old entries", () => {
    const r = new DoomLoopRing(3);
    r.push("bash", { cmd: "x" }, true);
    r.push("a", {}, false);
    r.push("b", {}, false);
    r.push("bash", { cmd: "x" }, true); // evicts the first bash
    expect(sig(r, 2)).toEqual([]); // only 1 bash failure left in window
  });
});

describe("makeAntiSpiral", () => {
  const deps = (ring: DoomLoopRing, over: Partial<Parameters<typeof makeAntiSpiral>[0]> = {}) => ({
    ring,
    repeats: 3,
    stepCap: 0,
    db: null,
    sessionId: null,
    agentId: null,
    ...over,
  });

  test("quiet when nothing is wrong → pass, no steering", async () => {
    const ring = new DoomLoopRing();
    ring.push("bash", { cmd: "x" }, false);
    const gate = makeAntiSpiral(deps(ring));
    const state = new AgentState();
    expect(await gate(turn(), [], state)).toBe("pass");
    expect(state.steering).toHaveLength(0);
  });

  test("doom loop: first detection steers (handled), persistence stops", async () => {
    const ring = new DoomLoopRing();
    const gate = makeAntiSpiral(deps(ring));
    const state = new AgentState();
    ring.push("bash", { cmd: "x" }, true);
    ring.push("bash", { cmd: "x" }, true);
    ring.push("bash", { cmd: "x" }, true);
    expect(await gate(turn(), [], state)).toBe("handled");
    expect(state.steering).toHaveLength(1);
    expect((state.steering[0]!.content[0] as { text: string }).text).toContain("stuck in a loop");
    ring.push("bash", { cmd: "x" }, true); // still spiraling after the nudge
    expect(await gate(turn(), [], state)).toBe("stop");
  });

  test("oscillation cannot escape the stop: an interleaved success does not spare a re-failing sig", async () => {
    const ring = new DoomLoopRing();
    const gate = makeAntiSpiral(deps(ring));
    const state = new AgentState();
    ring.push("bash", { cmd: "x" }, true);
    ring.push("bash", { cmd: "x" }, true);
    ring.push("bash", { cmd: "x" }, true);
    expect(await gate(turn(), [], state)).toBe("handled"); // nudged at count 3
    ring.push("read", { path: "f" }, false); // interleave a success
    ring.push("bash", { cmd: "x" }, true); // …then fail the SAME call again (count 4 > 3)
    expect(await gate(turn(), [], state)).toBe("stop");
  });

  test("a genuinely DIFFERENT new spiral earns its own one nudge", async () => {
    const ring = new DoomLoopRing();
    const gate = makeAntiSpiral(deps(ring));
    const state = new AgentState();
    ring.push("bash", { cmd: "x" }, true);
    ring.push("bash", { cmd: "x" }, true);
    ring.push("bash", { cmd: "x" }, true);
    expect(await gate(turn(), [], state)).toBe("handled"); // nudge bash
    ring.push("grep", { q: "z" }, true);
    ring.push("grep", { q: "z" }, true);
    ring.push("grep", { q: "z" }, true);
    expect(await gate(turn(), [], state)).toBe("handled"); // a different sig → its own nudge
  });

  test("a text-only turn after the nudge does not spuriously stop (no new failure)", async () => {
    const ring = new DoomLoopRing();
    const gate = makeAntiSpiral(deps(ring));
    const state = new AgentState();
    ring.push("bash", { cmd: "x" }, true);
    ring.push("bash", { cmd: "x" }, true);
    ring.push("bash", { cmd: "x" }, true);
    expect(await gate(turn(), [], state)).toBe("handled"); // nudge
    // model produced a text-only turn: the ring is unchanged, count has NOT climbed past the nudge.
    expect(await gate(turn(), [], state)).toBe("pass");
  });

  test("step cap: injects a wrap-up then stops on the next turn, writing a gate", async () => {
    const db = new MinimaDb(":memory:");
    db.upsertPlanFromTodos("s1", [
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
    ]);
    const ring = new DoomLoopRing();
    ring.push("bash", { cmd: "x" }, false);
    const gate = makeAntiSpiral(deps(ring, { repeats: 0, stepCap: 2, db, sessionId: "s1" }));
    const state = new AgentState();
    expect(await gate(turn(), [], state)).toBe("pass"); // turn 1
    expect(await gate(turn(), [], state)).toBe("handled"); // turn 2 → wrap-up injected
    expect((state.steering[0]!.content[0] as { text: string }).text).toContain("Wrap up");
    expect((state.steering[0]!.content[0] as { text: string }).text).toContain(
      "1/2 steps complete",
    );
    expect(await gate(turn(), [], state)).toBe("stop"); // wrap-up turn done → stop
    const plan = db.getActivePlan("s1")!;
    const stops = db.getGates(plan.id).filter((g) => g.kind === "stop");
    expect(stops).toHaveLength(1);
    expect(JSON.parse(stops[0]!.factors_json ?? "{}")).toMatchObject({ reason: "step_cap" });
  });

  test("both real steer texts match the R3b dim-line predicate (producer lockstep)", async () => {
    // The transcript's harness-noise predicate keys on stable prefixes owned here; feed it
    // the ACTUAL doom-loop nudge and step-cap wrap so a copy edit can't silently unlink them.
    const ring = new DoomLoopRing();
    ring.push("bash", { cmd: "x" }, true);
    ring.push("bash", { cmd: "x" }, true);
    ring.push("bash", { cmd: "x" }, true);
    const doomGate = makeAntiSpiral(deps(ring, { repeats: 3 }));
    const doomState = new AgentState();
    expect(await doomGate(turn(), [], doomState)).toBe("handled");
    expect(isHarnessSteerText((doomState.steering[0]!.content[0] as { text: string }).text)).toBe(
      true,
    );
    const capGate = makeAntiSpiral(deps(new DoomLoopRing(), { repeats: 0, stepCap: 1 }));
    const capState = new AgentState();
    expect(await capGate(turn(), [], capState)).toBe("handled");
    expect(isHarnessSteerText((capState.steering[0]!.content[0] as { text: string }).text)).toBe(
      true,
    );
  });

  test("step cap takes precedence over a concurrent doom loop", async () => {
    const ring = new DoomLoopRing();
    ring.push("bash", { cmd: "x" }, true);
    ring.push("bash", { cmd: "x" }, true);
    ring.push("bash", { cmd: "x" }, true);
    const gate = makeAntiSpiral(deps(ring, { repeats: 3, stepCap: 1 }));
    const state = new AgentState();
    // turn 1 hits the cap immediately; the wrap-up (not the doom-loop nudge) is injected.
    expect(await gate(turn(), [], state)).toBe("handled");
    expect((state.steering[0]!.content[0] as { text: string }).text).toContain("Wrap up");
  });

  test("fully disabled (repeats 0, stepCap 0) → always pass", async () => {
    const ring = new DoomLoopRing();
    ring.push("bash", { cmd: "x" }, true);
    ring.push("bash", { cmd: "x" }, true);
    ring.push("bash", { cmd: "x" }, true);
    const gate = makeAntiSpiral(deps(ring, { repeats: 0, stepCap: 0 }));
    const state = new AgentState();
    expect(await gate(turn(), [], state)).toBe("pass");
    expect(state.steering).toHaveLength(0);
  });
});
