import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { BusyIndicator } from "../src/tui/busy.tsx";

// Memory-leak guardrail (2026-07): a sleeping terminal stops draining stdout, so the 8 fps
// spinner's frames accumulated unboundedly in the writable's native buffer (43 GB RSS
// overnight). The BusyIndicator now skips its animation tick while `writableNeedDrain` is
// set — no state change, no re-render, no write — and auto-resumes once the buffer drains.
// Deltas are asserted over generous windows, never exact frame counts (timers are jittery).

class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 30;
  isTTY = true;
  frames: string[] = [];
  /** Mutable stand-in for node's stream.Writable backpressure flag. */
  writableNeedDrain = false;
  write(s: string): boolean {
    this.frames.push(s);
    return !this.writableNeedDrain;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("BusyIndicator backpressure guard", () => {
  test("ticks pause while stdout needs drain and resume when it drains", async () => {
    const stdout = new FakeStdout();
    const inst = render(<BusyIndicator active showTip={false} />, {
      stdout: stdout as never,
      patchConsole: false,
    });

    // Control: a draining stdout keeps animating (frames grow).
    await wait(400);
    const afterControl = stdout.frames.length;

    // Guard: flag the buffer as full; let any in-flight render flush, then freeze-check.
    stdout.writableNeedDrain = true;
    await wait(150);
    const frozenAt = stdout.frames.length;
    await wait(400);
    const afterFrozen = stdout.frames.length;

    // Resume: the next tick re-checks the flag — animation picks back up.
    stdout.writableNeedDrain = false;
    await wait(400);
    const afterResume = stdout.frames.length;

    inst.unmount();

    expect(afterControl).toBeGreaterThan(0); // spinner animated while draining
    expect(afterFrozen).toBe(frozenAt); // no writes while the buffer needed drain
    expect(afterResume).toBeGreaterThan(afterFrozen); // auto-resumed once drained
  });
});
