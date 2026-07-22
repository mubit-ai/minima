import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_QUEUE,
  type PromptQueue,
  clearQueue,
  decideBusySubmit,
  enqueuePrompt,
  holdOnAbort,
  queueNote,
  releaseOnPrompt,
  takeNext,
} from "../src/tui/prompt_queue.ts";

describe("decideBusySubmit — what Enter does while a turn is running", () => {
  test("a plain prompt enqueues (it must NOT reach the agent mid-turn)", () => {
    expect(decideBusySubmit("fix the failing test")).toEqual({ kind: "enqueue" });
  });

  test("each read-only local command dispatches immediately", () => {
    for (const line of [
      "/tree",
      "/tasks",
      "/why",
      "/bp",
      "/session",
      "/cost",
      "/perms",
      "/memory",
      "/memory list",
      "/help",
    ]) {
      expect(decideBusySubmit(line).kind).toBe("dispatch");
    }
  });

  test("dispatch carries the parsed name and args", () => {
    expect(decideBusySubmit("/why 3")).toEqual({ kind: "dispatch", name: "why", args: "3" });
    expect(decideBusySubmit("  /tree  ")).toEqual({ kind: "dispatch", name: "tree", args: "" });
    expect(decideBusySubmit("/memory   list")).toEqual({
      kind: "dispatch",
      name: "memory",
      args: "list",
    });
  });

  test("matching is case-insensitive (handleCommand lowercases too)", () => {
    expect(decideBusySubmit("/TREE").kind).toBe("dispatch");
    expect(decideBusySubmit("/Memory LIST").kind).toBe("dispatch");
  });

  test("side-effectful commands enqueue instead of dispatching", () => {
    for (const line of [
      "/compact",
      "/clear",
      "/new",
      "/undo",
      "/rewind 2",
      "/model auto",
      "/plan start",
      "/verify",
      "/resume",
      "/budget set 5",
    ]) {
      expect(decideBusySubmit(line)).toEqual({ kind: "enqueue" });
    }
  });

  test("allowlisted names with mutating args enqueue (conservative sub-command gating)", () => {
    expect(decideBusySubmit("/tasks cancel")).toEqual({ kind: "enqueue" });
    expect(decideBusySubmit("/cost fleet")).toEqual({ kind: "enqueue" });
    expect(decideBusySubmit("/memory add remember this")).toEqual({ kind: "enqueue" });
    expect(decideBusySubmit("/memory pin 1")).toEqual({ kind: "enqueue" });
    expect(decideBusySubmit("/memory delete 2")).toEqual({ kind: "enqueue" });
  });

  test("an unknown slash command enqueues (it errors normally after the turn)", () => {
    expect(decideBusySubmit("/definitely-not-a-command")).toEqual({ kind: "enqueue" });
  });
});

describe("prompt queue — FIFO drain, abort hold, escape clear", () => {
  test("enqueue + takeNext drain in submit order", () => {
    let q: PromptQueue = EMPTY_QUEUE;
    q = enqueuePrompt(q, "first");
    q = enqueuePrompt(q, "second");
    q = enqueuePrompt(q, "/compact");
    const a = takeNext(q);
    expect(a?.next).toBe("first");
    const b = takeNext(a!.queue);
    expect(b?.next).toBe("second");
    const c = takeNext(b!.queue);
    expect(c?.next).toBe("/compact");
    expect(takeNext(c!.queue)).toBeNull();
  });

  test("takeNext on an empty queue is null", () => {
    expect(takeNext(EMPTY_QUEUE)).toBeNull();
  });

  test("abort holds the queue: items survive but nothing drains", () => {
    let q = enqueuePrompt(EMPTY_QUEUE, "next task");
    q = holdOnAbort(q);
    expect(q.held).toBe(true);
    expect(q.items).toEqual(["next task"]);
    expect(takeNext(q)).toBeNull();
  });

  test("abort with nothing queued does not arm a stale hold", () => {
    expect(holdOnAbort(EMPTY_QUEUE).held).toBe(false);
  });

  test("a fresh user PROMPT releases the hold; a slash command does not", () => {
    const held = holdOnAbort(enqueuePrompt(EMPTY_QUEUE, "queued work"));
    expect(releaseOnPrompt(held, "/tree").held).toBe(true);
    const released = releaseOnPrompt(held, "carry on");
    expect(released.held).toBe(false);
    expect(takeNext(released)?.next).toBe("queued work");
  });

  test("escape while idle clears the whole queue and reports the count", () => {
    let q = enqueuePrompt(EMPTY_QUEUE, "a");
    q = enqueuePrompt(q, "b");
    q = holdOnAbort(q);
    const { queue, cleared } = clearQueue(q);
    expect(cleared).toBe(2);
    expect(queue).toEqual(EMPTY_QUEUE);
  });
});

describe("queueNote — the footer indicator", () => {
  test("empty queue shows nothing", () => {
    expect(queueNote(EMPTY_QUEUE)).toBeNull();
  });

  test("counts queued prompts", () => {
    expect(queueNote(enqueuePrompt(EMPTY_QUEUE, "x"))).toBe("1 queued");
    expect(queueNote(enqueuePrompt(enqueuePrompt(EMPTY_QUEUE, "x"), "y"))).toBe("2 queued");
  });

  test("held queue says so and hints the exit", () => {
    expect(queueNote(holdOnAbort(enqueuePrompt(EMPTY_QUEUE, "x")))).toBe(
      "1 queued · held (esc clears)",
    );
  });
});

describe("app wiring (source pins, the behavior.test.ts pattern)", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

  test("busy Enter routes through decideBusySubmit: dispatch runs handleCommand now, everything else enqueues — nothing reaches the agent mid-turn", () => {
    expect(src).toContain("if (busy || drainBusyRef.current) {");
    expect(src).toContain("const decision = decideBusySubmit(text);");
    expect(src).toContain("await handleCommand(decision.name, decision.args);");
    expect(src).toContain("setPromptQueue((q) => enqueuePrompt(q, text));");
  });

  test("the drain fires only on idle unowned frames and submits through the normal path", () => {
    expect(src).toContain("if (busy || drainBusyRef.current) return;");
    expect(src).toContain(
      "if (gateFocus || bigPlanBehavior?.block || permPrompt || questionPrompt) return;",
    );
    expect(src).toContain(
      "if (pickerOpen || paletteOpen || sessionPickerOpen || configOverlayOpen) return;",
    );
    expect(src).toContain("const taken = takeNext(promptQueue);");
    expect(src).toContain("await submitLine(taken.next);");
  });

  test("abort holds the queue, idle Esc clears it, a fresh prompt releases it", () => {
    expect(src).toContain("setPromptQueue(holdOnAbort);");
    expect(src).toContain("if (key.escape && promptQueue.items.length > 0) {");
    expect(src).toContain("setPromptQueue((q) => releaseOnPrompt(q, text));");
  });

  test("the composer is never busy-disabled and the footer carries the queue note", () => {
    expect(src).not.toContain("disabled={busy");
    expect(src).toContain("disabled={gateFocus !== null && !gateFocus.noteEntry}");
    expect(src).toContain("queueNote={queueNote(promptQueue)}");
  });
});
