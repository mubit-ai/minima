import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";

import { SIDEBAR_CHROME_ROWS, sidebarGeometry, sidebarOverlayGeometry } from "../src/tui/layout.ts";
import { cwdSegments, sidebarBodyRows } from "../src/tui/sidebar-chassis.tsx";

describe("cwdSegments (the sidebar footer's cwd line)", () => {
  test("home-relative with the last segment split out bold", () => {
    const home = require("node:os").homedir();
    const { head, base } = cwdSegments(60, `${home}/Mubit/Minima/minima`);
    expect(head).toBe("~/Mubit/Minima/");
    expect(base).toBe("minima");
  });

  test("long paths trim the HEAD from the left, keeping the tail readable", () => {
    const { head, base } = cwdSegments(20, "/very/long/path/that/never/ends/project");
    expect(base).toBe("project");
    expect(head.startsWith("…")).toBe(true);
    expect(stringWidth(head) + stringWidth(base)).toBeLessThanOrEqual(20);
  });

  test("a base longer than the width trims the base itself", () => {
    const { head, base } = cwdSegments(8, "/x/averyverylongbasename");
    expect(head).toBe("");
    expect(base.startsWith("…")).toBe(true);
    expect(stringWidth(base)).toBeLessThanOrEqual(8);
  });
});

describe("sidebarBodyRows (exact chassis row budget)", () => {
  test("body + chrome (+ info) always equals innerHeight", () => {
    const g = sidebarGeometry(100, 30)!;
    expect(sidebarBodyRows(g) + SIDEBAR_CHROME_ROWS).toBe(g.innerHeight);
    const info = { title: "Context", lines: ["a", "b", "c"] };
    expect(sidebarBodyRows(g, info) + SIDEBAR_CHROME_ROWS + info.lines.length + 2).toBe(
      g.innerHeight,
    );
  });

  test("overlay geometry budgets identically; floor of one body row", () => {
    const o = sidebarOverlayGeometry(52, 30)!;
    expect(sidebarBodyRows(o) + SIDEBAR_CHROME_ROWS).toBe(o.innerHeight);
    const tiny = sidebarGeometry(100, 10)!;
    expect(sidebarBodyRows(tiny, { title: "t", lines: ["1", "2", "3"] })).toBe(1);
  });
});
