import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWithin } from "../src/tools/_io.ts";
import { builtinTools } from "../src/tools/builtin.ts";
import { editTool } from "../src/tools/edit.ts";
import { readTool } from "../src/tools/read.ts";
import { type TodoTask, todowriteTool } from "../src/tools/todowrite.ts";
import { writeTool } from "../src/tools/write.ts";
import { refreshCatalogOnce, resetCatalogBootstrap } from "../src/minima/catalog.ts";
import { harnessConfig } from "../src/minima/index.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "minima-iso-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function textOf(r: { content: { type: string; text?: string }[] }): string {
  return r.content.map((b) => ("text" in b ? b.text : "")).join("");
}

describe("resolveWithin (path confinement)", () => {
  test("no base → expand passthrough (historical behavior)", () => {
    expect(resolveWithin("src/a.ts")).toEqual({ ok: true, path: "src/a.ts" });
  });
  test("relative resolves against the base", () => {
    const r = resolveWithin("sub/a.ts", "/base/dir");
    expect(r).toEqual({ ok: true, path: "/base/dir/sub/a.ts" });
  });
  test("`..` escape is rejected", () => {
    expect(resolveWithin("../outside.ts", "/base/dir").ok).toBe(false);
    expect(resolveWithin("sub/../../../etc/passwd", "/base/dir").ok).toBe(false);
  });
  test("absolute path outside the base is rejected; inside is allowed", () => {
    expect(resolveWithin("/etc/passwd", "/base/dir").ok).toBe(false);
    expect(resolveWithin("/base/dir/x.ts", "/base/dir")).toEqual({
      ok: true,
      path: "/base/dir/x.ts",
    });
  });
  test("the base itself is allowed", () => {
    expect(resolveWithin(".", "/base/dir")).toEqual({ ok: true, path: "/base/dir" });
  });
});

describe("per-instance todo state", () => {
  test("two agents in one process keep independent todo lists", async () => {
    const stateA: TodoTask[] = [];
    const stateB: TodoTask[] = [];
    const a = todowriteTool(stateA);
    const b = todowriteTool(stateB);
    await a.execute("1", { tasks: JSON.stringify([{ content: "task A" }]) }, null, null);
    await b.execute(
      "2",
      { tasks: JSON.stringify([{ content: "task B1" }, { content: "task B2" }]) },
      null,
      null,
    );
    expect(stateA.map((t) => t.content)).toEqual(["task A"]);
    expect(stateB.map((t) => t.content)).toEqual(["task B1", "task B2"]);
  });
});

describe("workdir-scoped filesystem tools", () => {
  test("read/write/edit operate within a workdir via relative paths", async () => {
    const wd = tmp();
    const w = writeTool({ workdir: wd });
    const r = readTool({ workdir: wd });
    const e = editTool({ workdir: wd });

    await w.execute("1", { path: "sub/hello.txt", content: "hello world" }, null, null);
    const read1 = await r.execute("2", { path: "sub/hello.txt", offset: 1, limit: 10 }, null, null);
    expect(textOf(read1)).toContain("hello world");

    await e.execute(
      "3",
      { path: "sub/hello.txt", old_string: "world", new_string: "minima" },
      null,
      null,
    );
    const read2 = await r.execute("4", { path: "sub/hello.txt", offset: 1, limit: 10 }, null, null);
    expect(textOf(read2)).toContain("hello minima");
  });

  test("escape attempts are rejected with an actionable error", async () => {
    const wd = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "secret.txt"), "s3cret");

    const r = readTool({ workdir: wd });
    const res1 = await r.execute(
      "1",
      { path: join(outside, "secret.txt"), offset: 1, limit: 10 },
      null,
      null,
    );
    expect(textOf(res1)).toContain("escapes workdir");
    expect(textOf(res1)).not.toContain("s3cret");

    const w = writeTool({ workdir: wd });
    const res2 = await w.execute("2", { path: "../evil.txt", content: "x" }, null, null);
    expect(textOf(res2)).toContain("escapes workdir");

    const tools = builtinTools({ workdir: wd });
    const bash = tools.find((t) => t.name === "bash")!;
    const res3 = await bash.execute("3", { command: "pwd", workdir: "../.." }, null, null);
    expect(textOf(res3)).toContain("escapes workdir");
  });

  test("two tool sets in one process write to distinct workdirs", async () => {
    const wd1 = tmp();
    const wd2 = tmp();
    const t1 = builtinTools({ workdir: wd1 });
    const t2 = builtinTools({ workdir: wd2 });
    const w1 = t1.find((t) => t.name === "write")!;
    const w2 = t2.find((t) => t.name === "write")!;
    await w1.execute("1", { path: "who.txt", content: "one" }, null, null);
    await w2.execute("2", { path: "who.txt", content: "two" }, null, null);
    const r1 = await t1
      .find((t) => t.name === "read")!
      .execute("3", { path: "who.txt", offset: 1, limit: 5 }, null, null);
    const r2 = await t2
      .find((t) => t.name === "read")!
      .execute("4", { path: "who.txt", offset: 1, limit: 5 }, null, null);
    expect(textOf(r1)).toContain("one");
    expect(textOf(r2)).toContain("two");
  });

  test("bash without a model workdir defaults to the factory workdir", async () => {
    const wd = tmp();
    const bash = builtinTools({ workdir: wd }).find((t) => t.name === "bash")!;
    const res = await bash.execute("1", { command: "pwd" }, null, null);
    // macOS tmpdir may gain a /private prefix — compare by the unique leaf dir name.
    expect(textOf(res).split("\n")[0]!.endsWith(wd.split("/").pop()!)).toBe(true);
  });
});

describe("refreshCatalogOnce", () => {
  test("memoizes: concurrent + repeat calls share one underlying refresh", async () => {
    resetCatalogBootstrap();
    const config = harnessConfig({ minimaUrl: "", candidates: [] }); // no sources → count via promise identity
    const p1 = refreshCatalogOnce(config);
    const p2 = refreshCatalogOnce(config);
    expect(p1).toBe(p2);
    await p1;
    expect(refreshCatalogOnce(config)).toBe(p1); // still the same memo after resolution
    resetCatalogBootstrap();
  });
});
