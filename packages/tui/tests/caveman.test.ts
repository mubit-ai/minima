import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_CAVEMAN_LEVEL,
  cavemanSystemAppend,
  getCaveman,
  parseCavemanArg,
  setCaveman,
} from "../src/minima/caveman.ts";
import { readSource } from "./_source.ts";

afterEach(() => setCaveman(null));

describe("caveman mode", () => {
  test("off by default and appends nothing", () => {
    expect(getCaveman()).toBeNull();
    expect(cavemanSystemAppend(getCaveman())).toBe("");
  });

  test("parses levels, off-synonyms, and rejects junk", () => {
    expect(parseCavemanArg(" ULTRA ")).toBe("ultra");
    expect(parseCavemanArg("wenyan-full")).toBe("wenyan-full");
    expect(parseCavemanArg("off")).toBe("off");
    expect(parseCavemanArg("normal")).toBe("off");
    expect(parseCavemanArg("")).toBeNull();
    expect(parseCavemanArg("banana")).toBeNull();
  });

  test("the append carries the active level and the never-compress rules", () => {
    setCaveman(DEFAULT_CAVEMAN_LEVEL);
    const block = cavemanSystemAppend(getCaveman());
    expect(block).toContain("Active level: **full**");
    expect(block).toContain("Code blocks unchanged");
    expect(block).toContain("Never drop not/never/no/only/except");
  });

  test("runtime injects it into the turn's system prompt and /caveman is dispatched", () => {
    const runtime = readSource("minima/runtime.ts");
    expect(runtime).toContain("cavemanSystemAppend(getCaveman())");
    const app = readSource("tui/app.tsx");
    expect(app).toContain('{ name: "caveman"');
    expect(app).toContain('case "caveman":');
  });
});
