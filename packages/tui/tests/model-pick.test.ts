import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "../src/ai/types.ts";
import { DEFAULT_CANDIDATES, harnessConfig } from "../src/minima/config.ts";
import { type PinStash, applyPersistentPin, applyUnpin } from "../src/tui/model_pick.ts";

const MODEL_A: Model = {
  id: "model-a",
  provider: "faux",
  api: "faux",
  name: "A",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};
const MODEL_B: Model = { ...MODEL_A, id: "model-b", name: "B" };

describe("persistent pin/unpin (model_pick)", () => {
  test("pin -> unpin restores the original candidate pool", () => {
    const config = harnessConfig({ candidates: ["x", "y"] });
    const stash: PinStash = { pool: null };
    applyPersistentPin(config, stash, MODEL_A);
    expect(config.pinned).toBe(true);
    expect(config.candidates).toEqual(["model-a"]);
    applyUnpin(config, stash);
    expect(config.pinned).toBe(false);
    expect(config.candidates).toEqual(["x", "y"]); // not left narrowed to [model-a]
    expect(stash.pool).toBeNull();
  });

  test("re-pinning keeps the FIRST stash — pin A then B still unpins to the original pool", () => {
    const config = harnessConfig({ candidates: ["x", "y"] });
    const stash: PinStash = { pool: null };
    applyPersistentPin(config, stash, MODEL_A);
    applyPersistentPin(config, stash, MODEL_B);
    expect(config.candidates).toEqual(["model-b"]);
    applyUnpin(config, stash);
    expect(config.candidates).toEqual(["x", "y"]);
  });

  test("unpin with no stash (startup --model pin) falls back to the default pool", () => {
    const config = harnessConfig({ candidates: ["only-pinned"], pinned: true });
    const stash: PinStash = { pool: null };
    applyUnpin(config, stash);
    expect(config.pinned).toBe(false);
    expect(config.candidates).toEqual([...DEFAULT_CANDIDATES]);
  });
});

describe("picker TUI wiring", () => {
  test("⏎ schedules a one-turn pin instead of setting agentState.model directly", () => {
    const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");
    expect(src).toContain("oneShotModelRef.current = model");
    expect(src).toContain("pinModel: pin");
  });

  test("the picker footer says run once vs pin", () => {
    const src = readFileSync(join(import.meta.dir, "../src/tui/model-picker.tsx"), "utf8");
    expect(src).toContain("⏎ run once · Tab pin");
  });
});
