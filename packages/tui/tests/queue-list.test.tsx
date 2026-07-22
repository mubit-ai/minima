import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import type React from "react";
import stringWidth from "string-width";
import {
  EMPTY_QUEUE,
  type PromptQueue,
  enqueuePrompt,
  holdOnAbort,
} from "../src/tui/prompt_queue.ts";
import { QueueList, queueListLines, queueListRowCount } from "../src/tui/queue_list.tsx";

function queued(...items: string[]): PromptQueue {
  return items.reduce(enqueuePrompt, EMPTY_QUEUE);
}

describe("queueListRowCount — the anchor-ledger height", () => {
  test("empty queue costs zero rows", () => {
    expect(queueListRowCount(EMPTY_QUEUE)).toBe(0);
  });

  test("one row per item up to the cap of 3", () => {
    expect(queueListRowCount(queued("a"))).toBe(1);
    expect(queueListRowCount(queued("a", "b"))).toBe(2);
    expect(queueListRowCount(queued("a", "b", "c"))).toBe(3);
  });

  test("beyond 3 items the cap holds and one +N-more row is added", () => {
    expect(queueListRowCount(queued("a", "b", "c", "d"))).toBe(4);
    expect(queueListRowCount(queued("a", "b", "c", "d", "e"))).toBe(4);
    expect(queueListRowCount(queued("a", "b", "c", "d", "e", "f", "g"))).toBe(4);
  });

  test("held does not change the height (suffix rides an existing row)", () => {
    expect(queueListRowCount(holdOnAbort(queued("a", "b")))).toBe(2);
    expect(queueListRowCount(holdOnAbort(queued("a", "b", "c", "d", "e")))).toBe(4);
  });

  test("row count always equals the rendered line count (booked == rendered)", () => {
    let q: PromptQueue = EMPTY_QUEUE;
    expect(queueListLines(q).length).toBe(queueListRowCount(q));
    for (let i = 0; i < 6; i++) {
      q = enqueuePrompt(q, `item ${i}`);
      expect(queueListLines(q).length).toBe(queueListRowCount(q));
      expect(queueListLines(holdOnAbort(q)).length).toBe(queueListRowCount(holdOnAbort(q)));
    }
  });
});

describe("queueListLines — the stacked rows above the prompt box", () => {
  test("each item renders as one ›-prefixed row, newest last", () => {
    expect(queueListLines(queued("first", "second"))).toEqual(["› first", "› second"]);
  });

  test("multi-line pastes collapse to a single row (a raw newline would break the ledger)", () => {
    expect(queueListLines(queued("fix a\n  then b\nthen c"))).toEqual(["› fix a then b then c"]);
  });

  test("longer queues show the LAST 3 items under a +N-more header", () => {
    expect(queueListLines(queued("a", "b", "c", "d", "e"))).toEqual([
      "  …+2 more",
      "› c",
      "› d",
      "› e",
    ]);
  });

  test("held queue says so on the last row", () => {
    expect(queueListLines(holdOnAbort(queued("x", "y")))).toEqual([
      "› x",
      "› y (held — esc clears)",
    ]);
    const long = queueListLines(holdOnAbort(queued("a", "b", "c", "d")));
    expect(long[0]).toBe("  …+1 more");
    expect(long[3]).toBe("› d (held — esc clears)");
  });

  test("empty queue renders nothing", () => {
    expect(queueListLines(EMPTY_QUEUE)).toEqual([]);
    expect(queueListLines(holdOnAbort(EMPTY_QUEUE))).toEqual([]);
  });
});

// Real-Ink render (the footer-width.test.tsx harness): the list must come out as dim
// single-height rows that truncate at the terminal edge — a wrapped queue row would
// under-book the anchor ledger and top-clip the composer.
class FakeStdout extends EventEmitter {
  columns: number;
  rows = 30;
  frames: string[] = [];
  isTTY = true;
  constructor(columns: number) {
    super();
    this.columns = columns;
  }
  write(s: string): boolean {
    this.frames.push(s);
    return true;
  }
}

async function renderedLines(el: React.ReactElement, columns: number): Promise<string[]> {
  const stdout = new FakeStdout(columns);
  const inst = render(el, { stdout: stdout as never, patchConsole: false });
  await new Promise((r) => setTimeout(r, 30));
  inst.unmount();
  return stdout.frames.join("").split("\n").map(stripVTControlCharacters);
}

describe("QueueList — rendered output", () => {
  test("renders the stacked rows with the +N-more header and held suffix", async () => {
    const q = holdOnAbort(queued("alpha", "bravo", "charlie", "delta"));
    const lines = await renderedLines(<QueueList queue={q} />, 80);
    expect(lines.some((l) => l.includes("…+1 more"))).toBe(true);
    expect(lines.some((l) => l.includes("› bravo"))).toBe(true);
    expect(lines.some((l) => l.includes("› charlie"))).toBe(true);
    expect(lines.some((l) => l.includes("› delta (held — esc clears)"))).toBe(true);
    expect(lines.some((l) => l.includes("alpha"))).toBe(false);
  });

  test("a long queued prompt truncates at the terminal width instead of wrapping", async () => {
    const q = queued(`please ${"reticulate splines ".repeat(20)}`);
    const lines = await renderedLines(<QueueList queue={q} />, 40);
    for (const l of lines) {
      expect(stringWidth(l)).toBeLessThanOrEqual(40);
    }
    const row = lines.find((l) => l.startsWith("› "));
    expect(row).toBeDefined();
    expect(row).toContain("…");
  });

  test("an empty queue renders nothing", async () => {
    const lines = await renderedLines(<QueueList queue={EMPTY_QUEUE} />, 80);
    expect(lines.join("")).toBe("");
  });
});

describe("app wiring (source pins, the prompt-queue.test.ts pattern)", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

  test("the list mounts in the composer column directly above the prompt box", () => {
    expect(src).toContain("{queueListVisible && <QueueList queue={promptQueue} />}");
    const mountAt = src.indexOf("{queueListVisible && <QueueList queue={promptQueue} />}");
    const promptBoxAt = src.indexOf('borderColor={planMode ? "magenta" : "yellow"}');
    expect(mountAt).toBeGreaterThan(0);
    expect(promptBoxAt).toBeGreaterThan(mountAt);
  });

  test("visibility matches the busy-indicator gate (no overlay/perm/question/panel) and height is zero when hidden", () => {
    expect(src).toContain(
      "promptQueue.items.length > 0 && !overlayOpen && !permPrompt && !questionPrompt && !panelVisible;",
    );
    expect(src).toContain(
      "const queueListHeight = queueListVisible ? queueListRowCount(promptQueue) : 0;",
    );
  });

  test("queueListHeight is booked in contentRows (an unbooked row top-clips the composer)", () => {
    expect(src).toContain(
      "        busyIndicatorHeight +\n        queueListHeight +\n        suggestionsHeight +",
    );
  });

  test("queueListHeight is booked in streamReserved (the streaming tail must shrink for it)", () => {
    expect(src).toContain(
      "    busyIndicatorHeight +\n    queueListHeight +\n    streamingThoughtsHeight +",
    );
  });

  test("queueListHeight is booked in the treeMaxRows subtraction (/tree yields rows to it)", () => {
    expect(src).toContain(
      "      busyIndicatorHeight -\n      queueListHeight -\n      TREE_CHROME,",
    );
  });
});
