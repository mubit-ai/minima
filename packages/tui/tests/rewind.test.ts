import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssistantMessage, Message } from "../src/ai/types.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { rehydrateRun } from "../src/db/rehydrate.ts";
import { snapshot } from "../src/session/checkpoint.ts";
import {
  parseRewindMarker,
  promptText,
  truncateBeforePrompt,
  truncateLastPrompts,
} from "../src/session/rewind.ts";

const user = (text: string) => new Message({ role: "user", content: text });
const assistant = (text: string) => new AssistantMessage({ content: text, model: "m" });
const tool = (text: string) => new Message({ role: "toolResult", content: text, tool_name: "t" });

function turns(...prompts: string[]): Message[] {
  const out: Message[] = [];
  for (const p of prompts) out.push(user(p), tool(`ran for ${p}`), assistant(`answer to ${p}`));
  return out;
}

describe("rewind helpers (B4)", () => {
  test("truncateBeforePrompt keeps exactly k prompts (and any leading non-user seed)", () => {
    const msgs = [assistant("seed"), ...turns("one", "two", "three")];
    expect(truncateBeforePrompt(msgs, 3)).toEqual(msgs);
    const two = truncateBeforePrompt(msgs, 2);
    expect(two.length).toBe(1 + 6);
    expect(promptText(two.filter((m) => m.role === "user").at(-1) ?? null)).toBe("two");
    const zero = truncateBeforePrompt(msgs, 0);
    expect(zero.length).toBe(1); // the seed survives a keep of 0
  });

  test("truncateLastPrompts drops from the end and hands back the first dropped prompt", () => {
    const msgs = turns("one", "two", "three");
    const cut = truncateLastPrompts(msgs, 1);
    expect(cut.messages.length).toBe(6);
    expect(promptText(cut.droppedPrompt)).toBe("three");
    const cut2 = truncateLastPrompts(msgs, 2);
    expect(promptText(cut2.droppedPrompt)).toBe("two");
    const all = truncateLastPrompts(msgs, 99);
    expect(all.messages.length).toBe(0);
    expect(promptText(all.droppedPrompt)).toBe("one");
    const none = truncateLastPrompts(msgs, 0);
    expect(none.messages).toBe(msgs);
    expect(none.droppedPrompt).toBeNull();
  });

  test("parseRewindMarker validates shape", () => {
    expect(parseRewindMarker({ keep_prompts: 2 })).toEqual({ keep_prompts: 2 });
    expect(parseRewindMarker({ keep_prompts: -1 })).toBeNull();
    expect(parseRewindMarker({ keep_prompts: "2" })).toBeNull();
    expect(parseRewindMarker(null)).toBeNull();
  });
});

function seedRunEvents(db: MinimaDb, runId: string, prompts: string[]): void {
  for (const p of prompts) {
    db.appendEvent({ runId, type: "user", payload: { text: p } });
    db.appendEvent({
      runId,
      type: "assistant",
      payload: { text: `answer to ${p}`, model: "m", stop_reason: "stop", usage: {} },
    });
  }
}

describe("rehydrate honors rewind markers (B4.1)", () => {
  test("marker truncates replay; later turns append after it", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    seedRunEvents(db, runId, ["one", "two", "three"]);
    db.appendEvent({ runId, type: "rewind", payload: { keep_prompts: 1 } });
    seedRunEvents(db, runId, ["two-b"]);

    const r = rehydrateRun(db, runId);
    const prompts = r.messages.filter((m) => m.role === "user").map((m) => promptText(m));
    expect(prompts).toEqual(["one", "two-b"]);
  });

  test("stacked markers walk further back", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    seedRunEvents(db, runId, ["one", "two", "three"]);
    db.appendEvent({ runId, type: "rewind", payload: { keep_prompts: 2 } });
    db.appendEvent({ runId, type: "rewind", payload: { keep_prompts: 1 } });

    const r = rehydrateRun(db, runId);
    const prompts = r.messages.filter((m) => m.role === "user").map((m) => promptText(m));
    expect(prompts).toEqual(["one"]);
  });

  test("meter rows and promptsRun stay full — the spend happened (feedback truth)", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    seedRunEvents(db, runId, ["one", "two"]);
    db.writeDecision({
      recId: "r1",
      runId,
      taskLabel: "t",
      chosenModel: "m",
      decisionBasis: "estimate",
      confidence: 0.5,
      thresholdUsed: 0.5,
      ranked: [],
      estCostUsd: 0.01,
      actualCostUsd: 0.02,
      quality: null,
      judged: false,
      outcome: "success",
      turns: 1,
      latencyMs: 5,
    });
    db.appendEvent({ runId, type: "rewind", payload: { keep_prompts: 0 } });
    const r = rehydrateRun(db, runId);
    expect(r.messages.length).toBe(0);
    expect(r.meterRows.length).toBe(1);
    expect(r.promptsRun).toBe(1);
  });

  test("old readers' contract: unknown event types were already skipped (marker is additive)", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    db.appendEvent({ runId, type: "rewind", payload: { keep_prompts: 5 } });
    const r = rehydrateRun(db, runId);
    expect(r.messages.length).toBe(0);
  });
});

describe("/undo stacking seam (B4.2) — checkpoint walk-back", () => {
  test("latestCheckpoint(beforeCreated) walks turn checkpoints backwards, skipping safety rows", () => {
    const top = mkdtempSync(join(tmpdir(), "minima-undo-"));
    try {
      Bun.spawnSync(["git", "init", top]);
      Bun.spawnSync(["git", "-C", top, "config", "user.email", "t@t.local"]);
      Bun.spawnSync(["git", "-C", top, "config", "user.name", "T"]);
      const db = new MinimaDb(":memory:");
      db.ensureProject("p");
      const runId = db.startRun({ projectKey: "p" });

      writeFileSync(join(top, "f.txt"), "v1\n");
      const c1 = snapshot({ top, db, runId, promptOrdinal: 0 });
      writeFileSync(join(top, "f.txt"), "v2\n");
      const c2 = snapshot({ top, db, runId, promptOrdinal: 1 });
      writeFileSync(join(top, "f.txt"), "v3\n");
      snapshot({ top, db, runId, promptOrdinal: 2, kind: "safety" });

      // First /undo: newest TURN checkpoint (safety rows are never undo targets).
      const first = db.latestCheckpoint(runId, { kind: "turn" });
      expect(first?.id).toBe(c2!.id);
      // Stacked /undo: strictly older than the last restored one.
      const second = db.latestCheckpoint(runId, { kind: "turn", beforeCreated: first!.created });
      expect(second?.id).toBe(c1!.id);
      const third = db.latestCheckpoint(runId, { kind: "turn", beforeCreated: second!.created });
      expect(third).toBeNull();
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });
});

describe("composer prefill seam (B4.3)", () => {
  test("TextInput seeds its draft from initialValue", async () => {
    const input = await Bun.file(
      new URL("../src/tui/text-input.tsx", import.meta.url).pathname,
    ).text();
    expect(input).toContain("initialValue?: string");
    // The input's source of truth is draftRef (stale-closure fix); prefill seeds it at mount.
    expect(input).toContain('value: initialValue ?? ""');
  });
});
