import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PatchError, applyPatchTool, parsePatch } from "../src/tools/apply_patch.ts";

let dir = "";
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), "minima-patch-"));
  return dir;
}

function patch(...body: string[]): string {
  return ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
}

async function run(wd: string, patchText: string) {
  const tool = applyPatchTool({ workdir: wd });
  const parsed = tool.parameters.validate({ patch: patchText });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return tool.execute("c1", parsed.value, null, null);
}

const read = (wd: string, rel: string) => readFileSync(join(wd, rel), "utf8");
const write = (wd: string, rel: string, content: string) => writeFileSync(join(wd, rel), content);
const outText = (res: Awaited<ReturnType<typeof run>>) => (res.content[0] as { text: string }).text;

describe("apply_patch — add", () => {
  test("adds a file with a trailing newline", async () => {
    const wd = freshDir();
    const res = await run(wd, patch("*** Add File: new.ts", "+a = 1", "+b = 2"));
    expect(read(wd, "new.ts")).toBe("a = 1\nb = 2\n");
    expect(outText(res)).toContain("applied patch");
  });

  test("add over existing file errors and writes nothing", async () => {
    const wd = freshDir();
    write(wd, "exists.txt", "keep");
    const res = await run(wd, patch("*** Add File: exists.txt", "+overwrite"));
    expect(outText(res)).toContain("already exists");
    expect(read(wd, "exists.txt")).toBe("keep");
  });

  test("add creates nested dirs", async () => {
    const wd = freshDir();
    await run(wd, patch("*** Add File: pkg/sub/m.ts", "+x = 1"));
    expect(read(wd, "pkg/sub/m.ts")).toBe("x = 1\n");
  });
});

describe("apply_patch — update", () => {
  test("single hunk with anchor", async () => {
    const wd = freshDir();
    write(wd, "f.ts", "function foo() {\n  return 1;\n}\n");
    await run(
      wd,
      patch(
        "*** Update File: f.ts",
        "@@ function foo() {",
        " function foo() {",
        "-  return 1;",
        "+  return 2;",
      ),
    );
    expect(read(wd, "f.ts")).toBe("function foo() {\n  return 2;\n}\n");
  });

  test("multiple hunks in one file", async () => {
    const wd = freshDir();
    write(wd, "f.ts", "a = 1\nb = 2\nc = 3\nd = 4\n");
    await run(
      wd,
      patch(
        "*** Update File: f.ts",
        "@@",
        " a = 1",
        "-b = 2",
        "+b = 20",
        "@@",
        " c = 3",
        "-d = 4",
        "+d = 40",
      ),
    );
    expect(read(wd, "f.ts")).toBe("a = 1\nb = 20\nc = 3\nd = 40\n");
  });

  test("preserves a missing trailing newline", async () => {
    const wd = freshDir();
    write(wd, "f.txt", "one\ntwo");
    await run(wd, patch("*** Update File: f.txt", " one", "-two", "+TWO"));
    expect(read(wd, "f.txt")).toBe("one\nTWO");
  });

  test("fuzzy whitespace match (trailing whitespace in file)", async () => {
    const wd = freshDir();
    write(wd, "f.ts", "x = 1   \ny = 2\n");
    await run(wd, patch("*** Update File: f.ts", "-x = 1", "+x = 11", " y = 2"));
    expect(read(wd, "f.ts")).toBe("x = 11\ny = 2\n");
  });

  test("missing target errors", async () => {
    const wd = freshDir();
    const res = await run(wd, patch("*** Update File: nope.ts", "-a", "+b"));
    expect(outText(res)).toContain("does not exist");
  });

  test("unmatched context errors and leaves file untouched", async () => {
    const wd = freshDir();
    write(wd, "f.ts", "real = 1\n");
    const res = await run(wd, patch("*** Update File: f.ts", "-not_here = 9", "+x = 0"));
    expect(outText(res)).toContain("could not locate");
    expect(read(wd, "f.ts")).toBe("real = 1\n");
  });
});

describe("apply_patch — delete / move", () => {
  test("deletes a file", async () => {
    const wd = freshDir();
    write(wd, "gone.txt", "bye");
    await run(wd, patch("*** Delete File: gone.txt"));
    expect(existsSync(join(wd, "gone.txt"))).toBe(false);
  });

  test("delete missing errors", async () => {
    const wd = freshDir();
    const res = await run(wd, patch("*** Delete File: ghost.txt"));
    expect(outText(res)).toContain("does not exist");
  });

  test("move renames and edits", async () => {
    const wd = freshDir();
    write(wd, "old.ts", "v = 1\n");
    await run(wd, patch("*** Update File: old.ts", "*** Move to: new.ts", "-v = 1", "+v = 2"));
    expect(existsSync(join(wd, "old.ts"))).toBe(false);
    expect(read(wd, "new.ts")).toBe("v = 2\n");
  });
});

describe("apply_patch — atomicity", () => {
  test("a bad hunk rolls back all files (nothing written)", async () => {
    const wd = freshDir();
    write(wd, "a.ts", "a = 1\n");
    write(wd, "b.ts", "b = 1\n");
    const res = await run(
      wd,
      patch(
        "*** Update File: a.ts",
        "-a = 1",
        "+a = 2",
        "*** Update File: b.ts",
        "-does_not_match = 9",
        "+b = 2",
      ),
    );
    expect(outText(res)).toContain("could not locate");
    expect(read(wd, "a.ts")).toBe("a = 1\n"); // never written
    expect(read(wd, "b.ts")).toBe("b = 1\n");
  });

  test("multi-file success (update + add)", async () => {
    const wd = freshDir();
    write(wd, "a.ts", "a = 1\n");
    await run(
      wd,
      patch("*** Update File: a.ts", "-a = 1", "+a = 99", "*** Add File: b.ts", "+b = 2"),
    );
    expect(read(wd, "a.ts")).toBe("a = 99\n");
    expect(read(wd, "b.ts")).toBe("b = 2\n");
  });
});

describe("apply_patch — parsing & descriptor", () => {
  test("requires Begin Patch", () => {
    expect(() => parsePatch("*** Add File: x\n+1\n*** End Patch")).toThrow(PatchError);
    expect(() => parsePatch("*** Add File: x\n+1\n*** End Patch")).toThrow(/Begin Patch/);
  });

  test("requires End Patch", () => {
    expect(() => parsePatch("*** Begin Patch\n*** Add File: x\n+1")).toThrow(/End Patch/);
  });

  test("counts change kinds in order", () => {
    const changes = parsePatch(
      patch("*** Add File: a", "+1", "*** Delete File: b", "*** Update File: c", "-x", "+y"),
    );
    expect(changes.map((c) => c.kind)).toEqual(["add", "delete", "update"]);
  });

  test("empty patch is reported", async () => {
    const wd = freshDir();
    const res = await run(wd, patch());
    expect(outText(res)).toContain("empty patch");
  });

  test("tool descriptor", () => {
    const t = applyPatchTool();
    expect(t.name).toBe("apply_patch");
    expect(t.description).toContain("*** Begin Patch");
  });
});
