import { describe, expect, test } from "bun:test";

import { MinimaDb } from "../src/db/minima_db.ts";
import { rehydrateRun } from "../src/db/rehydrate.ts";

interface Call {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

class Seeder {
  private ts = 0;
  constructor(
    private db: MinimaDb,
    private runId: string,
  ) {}

  private append(type: string, payload: unknown): void {
    this.ts += 1;
    this.db.appendEvent({ runId: this.runId, type, payload, ts: this.ts });
  }

  user(text: string): void {
    this.append("user", { role: "user", text });
  }

  assistant(text: string, calls: Call[] = []): void {
    const payload: Record<string, unknown> = {
      role: "assistant",
      text,
      model: "m",
      stop_reason: calls.length ? "toolUse" : "stop",
      usage: {},
    };
    if (calls.length) {
      payload.tool_calls = calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args ?? {} }));
    }
    this.append("assistant", payload);
  }

  tool(id: string, name: string, text: string): void {
    this.append("tool", {
      role: "toolResult",
      text,
      tool_name: name,
      tool_call_id: id,
      is_error: false,
    });
  }

  marker(payload: Record<string, unknown>): void {
    this.append("context_rewind", payload);
  }

  b4Rewind(keepPrompts: number): void {
    this.append("rewind", { keep_prompts: keepPrompts });
  }
}

function freshRun(): { db: MinimaDb; runId: string; seed: Seeder } {
  const db = new MinimaDb(":memory:");
  db.ensureProject("p");
  const runId = db.startRun({ projectKey: "p" });
  return { db, runId, seed: new Seeder(db, runId) };
}

function seedRewoundExploration(seed: Seeder, markerBeforeRewindTurn: boolean): void {
  seed.user("find the config path");
  seed.assistant("", [{ id: "cp1", name: "checkpoint" }]);
  seed.tool("cp1", "checkpoint", "Checkpoint set: explore");
  seed.assistant("", [
    { id: "p1", name: "probe" },
    { id: "p2", name: "probe" },
  ]);
  seed.tool("p1", "probe", "PROBE-ONE noisy exploration output");
  seed.tool("p2", "probe", "PROBE-TWO noisy exploration output");
  const marker = {
    anchor_tool_call_id: "cp1",
    rewind_tool_call_id: "rw1",
    report: "REPORT: config lives in src/x.ts",
    report_chars: 32,
  };
  if (markerBeforeRewindTurn) seed.marker(marker);
  seed.assistant("", [{ id: "rw1", name: "rewind", args: { report: "REPORT: config lives in src/x.ts" } }]);
  if (!markerBeforeRewindTurn) seed.marker(marker);
  seed.tool(
    "rw1",
    "rewind",
    "Context rewound to checkpoint. Pruned tool traffic is preserved in the session ledger.\n\nReport:\nREPORT: config lives in src/x.ts",
  );
  seed.assistant("done");
}

describe("rehydrate honors context_rewind markers (AC2)", () => {
  test("context_rewind marker prunes replayed projection while the ledger keeps every row", () => {
    const { db, runId, seed } = freshRun();
    seedRewoundExploration(seed, false);

    const r = rehydrateRun(db, runId);
    const flat = r.messages.map((m) => m.textContent).join("\n");
    expect(flat).not.toContain("PROBE-ONE");
    expect(flat).not.toContain("PROBE-TWO");
    expect(r.messages.filter((m) => m.role === "toolResult" && m.tool_name === "probe")).toHaveLength(0);
    expect(flat).toContain("REPORT: config lives in src/x.ts");
    expect(
      r.messages.filter((m) => m.role === "toolResult" && m.tool_call_id === "cp1"),
    ).toHaveLength(1);
    expect(r.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
    ]);

    const events = db.getRunEvents(runId);
    expect(events).toHaveLength(10);
    expect(events.filter((e) => e.payload.includes("PROBE-ONE"))).toHaveLength(1);
    expect(events.filter((e) => e.type === "context_rewind")).toHaveLength(1);
    db.close();
  });

  test("marker persisted before the rewind turn flushes (crash order) still prunes", () => {
    const { db, runId, seed } = freshRun();
    seedRewoundExploration(seed, true);

    const r = rehydrateRun(db, runId);
    const flat = r.messages.map((m) => m.textContent).join("\n");
    expect(flat).not.toContain("PROBE-ONE");
    expect(flat).not.toContain("PROBE-TWO");
    expect(flat).toContain("REPORT: config lives in src/x.ts");
    expect(r.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    db.close();
  });

  test("anchor-missing marker is a no-op", () => {
    const { db, runId, seed } = freshRun();
    seed.user("go");
    seed.assistant("", [{ id: "p1", name: "probe" }]);
    seed.tool("p1", "probe", "PROBE-ONE noisy exploration output");
    seed.marker({
      anchor_tool_call_id: "ghost",
      rewind_tool_call_id: "rw1",
      report: "r",
      report_chars: 1,
    });
    seed.assistant("done");

    const r = rehydrateRun(db, runId);
    const flat = r.messages.map((m) => m.textContent).join("\n");
    expect(flat).toContain("PROBE-ONE");
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    db.close();
  });

  test("coexists with a B4 rewind marker in the same run", () => {
    const { db, runId, seed } = freshRun();
    seed.user("one");
    seed.assistant("answer to one");
    seed.user("two");
    seed.assistant("answer to two");
    seed.b4Rewind(1);
    seed.user("three");
    seed.assistant("", [{ id: "cp1", name: "checkpoint" }]);
    seed.tool("cp1", "checkpoint", "Checkpoint set");
    seed.assistant("", [{ id: "p1", name: "probe" }]);
    seed.tool("p1", "probe", "PROBE-ONE noisy exploration output");
    seed.assistant("", [{ id: "rw1", name: "rewind", args: { report: "REPORT: done" } }]);
    seed.marker({
      anchor_tool_call_id: "cp1",
      rewind_tool_call_id: "rw1",
      report: "REPORT: done",
      report_chars: 12,
    });
    seed.tool("rw1", "rewind", "Context rewound to checkpoint.\n\nReport:\nREPORT: done");

    const r = rehydrateRun(db, runId);
    const prompts = r.messages.filter((m) => m.role === "user").map((m) => m.textContent);
    expect(prompts).toEqual(["one", "three"]);
    const flat = r.messages.map((m) => m.textContent).join("\n");
    expect(flat).not.toContain("answer to two");
    expect(flat).not.toContain("PROBE-ONE");
    expect(flat).toContain("REPORT: done");
    db.close();
  });
});
