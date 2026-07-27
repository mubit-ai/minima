import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssistantMessage, Message } from "../src/ai/types.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { rehydrateRun } from "../src/db/rehydrate.ts";
import { restore, snapshot } from "../src/session/checkpoint.ts";
import { promptText, truncateLastPrompts } from "../src/session/rewind.ts";
import type { ChatMessage } from "../src/tui/layout.ts";
import { buildRewindTurns, parseRewindArgs, renderRewindText } from "../src/tui/rewind_picker.ts";

const chat = (role: ChatMessage["role"], text: string): ChatMessage => ({ role, text });

describe("buildRewindTurns (B5.1)", () => {
  test("turns are real prompts only; slash echoes excluded; replay mapping from the end", () => {
    const messages: ChatMessage[] = [
      chat("user", "first prompt"),
      chat("assistant", "a1"),
      chat("user", "/ckpt"),
      chat("tool", "..."),
      chat("user", "second prompt"),
      chat("assistant", "a2"),
    ];
    const turns = buildRewindTurns(messages, [0], 2);
    expect(turns.length).toBe(2);
    expect(turns[0]!).toMatchObject({ liveIdx: 1, keepPrompts: 0, codeRestorable: true });
    expect(turns[1]!).toMatchObject({ liveIdx: 2, keepPrompts: 1, codeRestorable: false });
    expect(turns[0]!.title).toBe("first prompt");
  });

  test("post-/compact divergence: distance-from-end mapping holds when live has fewer prompts than replay", () => {
    // Replay knows 4 prompts; compaction collapsed the live view to the last 2.
    const messages: ChatMessage[] = [
      chat("user", "third"),
      chat("assistant", "a3"),
      chat("user", "fourth"),
      chat("assistant", "a4"),
    ];
    const turns = buildRewindTurns(messages, [], 4);
    expect(turns[0]!.keepPrompts).toBe(2); // before "third" = keep replay prompts 1..2
    expect(turns[1]!.keepPrompts).toBe(3);
  });

  test("parseRewindArgs: n + optional mode, default both; junk → null", () => {
    expect(parseRewindArgs("2")).toEqual({ n: 2, mode: "both" });
    expect(parseRewindArgs("1 code")).toEqual({ n: 1, mode: "code" });
    expect(parseRewindArgs("3 convo")).toEqual({ n: 3, mode: "convo" });
    expect(parseRewindArgs("")).toBeNull();
    expect(parseRewindArgs("zero")).toBeNull();
    expect(parseRewindArgs("2 files")).toBeNull();
  });

  test("renderRewindText marks code-restorable turns", () => {
    const turns = buildRewindTurns([chat("user", "hello world")], [0], 1);
    const text = renderRewindText(turns, 80);
    expect(text).toContain("1. hello world — ✓ code+convo");
    expect(renderRewindText([], 80)).toContain("Nothing to rewind");
  });
});

// The three restore modes at the seam level (B5.2) — db + git + pure helpers, exactly the
// pieces app.tsx's performRewind composes.
describe("/rewind modes (B5.2)", () => {
  function fixture() {
    const top = mkdtempSync(join(tmpdir(), "minima-rw-"));
    Bun.spawnSync(["git", "init", top]);
    Bun.spawnSync(["git", "-C", top, "config", "user.email", "t@t.local"]);
    Bun.spawnSync(["git", "-C", top, "config", "user.name", "T"]);
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });

    // Prompt 1 mutates f.txt → v1-turn snapshot at ordinal 0, then writes v1.
    writeFileSync(join(top, "f.txt"), "v0\n");
    snapshot({ top, db, runId, promptOrdinal: 0 });
    writeFileSync(join(top, "f.txt"), "v1\n");
    db.appendEvent({ runId, type: "user", payload: { text: "one" } });
    db.appendEvent({ runId, type: "assistant", payload: { text: "a1", model: "m" } });
    // Prompt 2 mutates again → snapshot at ordinal 1 (captures state as of prompt 2 = v1).
    snapshot({ top, db, runId, promptOrdinal: 1 });
    writeFileSync(join(top, "f.txt"), "v2\n");
    db.appendEvent({ runId, type: "user", payload: { text: "two" } });
    db.appendEvent({ runId, type: "assistant", payload: { text: "a2", model: "m" } });

    const live: Message[] = [
      new Message({ role: "user", content: "one" }),
      new AssistantMessage({ content: "a1", model: "m" }),
      new Message({ role: "user", content: "two" }),
      new AssistantMessage({ content: "a2", model: "m" }),
    ];
    return { top, db, runId, live };
  }

  test("conversation only: marker + truncation; files untouched", () => {
    const { top, db, runId, live } = fixture();
    try {
      const keepPrompts = 1; // rewind to before prompt 2
      const dropCount = db.countLeadUserEvents(runId) - keepPrompts;
      db.appendEvent({ runId, type: "rewind", payload: { keep_prompts: keepPrompts } });
      const cut = truncateLastPrompts(live, dropCount);
      expect(promptText(cut.droppedPrompt)).toBe("two");
      expect(cut.messages.length).toBe(2);
      // Replay agrees with the live truncation…
      const replayPrompts = rehydrateRun(db, runId)
        .messages.filter((m) => m.role === "user")
        .map((m) => promptText(m));
      expect(replayPrompts).toEqual(["one"]);
      // …and the worktree still has prompt 2's changes.
      expect(readFileSync(join(top, "f.txt"), "utf8")).toBe("v2\n");
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  test("code only: checkpoint restore to the state AS OF the picked prompt; conversation intact", () => {
    const { top, db, runId } = fixture();
    try {
      const keepPrompts = 1; // files as of prompt 2's submission = v1
      const target = db.earliestCheckpointAtOrAfter(runId, keepPrompts);
      expect(target?.prompt_ordinal).toBe(1);
      const result = restore({ top, db, runId, targetTreeSha: target!.tree_sha });
      expect(result).not.toBeNull();
      expect(readFileSync(join(top, "f.txt"), "utf8")).toBe("v1\n");
      // No marker was appended: replay still holds both prompts.
      const replay = rehydrateRun(db, runId).messages.filter((m) => m.role === "user");
      expect(replay.length).toBe(2);
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  test("both: files AND conversation return to the picked prompt; no changes since → code no-ops", () => {
    const { top, db, runId, live } = fixture();
    try {
      const keepPrompts = 0; // before prompt 1: files v0, conversation empty
      const target = db.earliestCheckpointAtOrAfter(runId, keepPrompts);
      expect(target?.prompt_ordinal).toBe(0);
      restore({ top, db, runId, targetTreeSha: target!.tree_sha });
      db.appendEvent({ runId, type: "rewind", payload: { keep_prompts: keepPrompts } });
      const cut = truncateLastPrompts(live, db.countLeadUserEvents(runId));
      expect(readFileSync(join(top, "f.txt"), "utf8")).toBe("v0\n");
      expect(cut.messages.length).toBe(0);
      expect(rehydrateRun(db, runId).messages.length).toBe(0);
      // "No changes since that prompt": an ordinal past every checkpoint finds none.
      expect(db.earliestCheckpointAtOrAfter(runId, 99)).toBeNull();
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });
});
