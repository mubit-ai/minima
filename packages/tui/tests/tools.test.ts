import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool, writeTool, editTool, bashTool, lsTool, builtinTools } from "../src/tools/index.ts";

let tmp = "";
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

function newTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), "minima-tools-"));
  return tmp;
}

async function run(tool: ReturnType<typeof readTool>, args: Record<string, unknown>) {
  const parsed = tool.parameters.validate(args);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return tool.execute("t1", parsed.value, null, null);
}

describe("schema validation", () => {
  test("objectSchema applies defaults and requires fields", () => {
    const r = readTool().parameters.validate({ path: "/x" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.path).toBe("/x");
      expect(r.value.offset).toBe(1);
      expect(r.value.limit).toBe(2000);
    }
  });
  test("rejects missing required field", () => {
    const r = readTool().parameters.validate({});
    expect(r.ok).toBe(false);
  });
});

describe("read tool", () => {
  test("returns numbered lines and reports lines_read", async () => {
    const d = newTmp();
    writeFileSync(join(d, "f.txt"), "alpha\nbeta\ngamma\n");
    const res = await run(readTool(), { path: join(d, "f.txt"), offset: 2, limit: 2 });
    const body = (res.content[0] as { text: string }).text;
    expect(body).toBe("2: beta\n3: gamma");
    expect(res.details?.lines_read).toBe(2);
  });
  test("errors on missing file", async () => {
    const res = await run(readTool(), { path: "/no/such/file" });
    expect((res.content[0] as { text: string }).text).toMatch(/no such file/);
  });
  test("errors on directory", async () => {
    const d = newTmp();
    const res = await run(readTool(), { path: d });
    expect((res.content[0] as { text: string }).text).toMatch(/is a directory/);
  });
});

describe("write tool", () => {
  test("creates parent dirs and writes content", async () => {
    const d = newTmp();
    const target = join(d, "sub", "out.txt");
    const res = await run(writeTool(), { path: target, content: "line1\nline2\n" });
    expect((res.content[0] as { text: string }).text).toMatch(/wrote/);
    const written = await Bun.file(target).text();
    expect(written).toBe("line1\nline2\n");
  });
});

describe("edit tool", () => {
  test("replaces a unique string", async () => {
    const d = newTmp();
    const f = join(d, "e.txt");
    writeFileSync(f, "foo bar baz");
    await run(editTool(), { path: f, old_string: "bar", new_string: "BAR" });
    expect(await Bun.file(f).text()).toBe("foo BAR baz");
  });
  test("errors when old_string is ambiguous without replace_all", async () => {
    const d = newTmp();
    const f = join(d, "e.txt");
    writeFileSync(f, "x x x");
    const res = await run(editTool(), { path: f, old_string: "x", new_string: "y" });
    expect((res.content[0] as { text: string }).text).toMatch(/matches 3 times/);
  });
  test("replace_all replaces every occurrence", async () => {
    const d = newTmp();
    const f = join(d, "e.txt");
    writeFileSync(f, "x x x");
    await run(editTool(), { path: f, old_string: "x", new_string: "y", replace_all: true });
    expect(await Bun.file(f).text()).toBe("y y y");
  });
});

describe("bash tool", () => {
  test("returns combined output and exit code", async () => {
    const res = await run(bashTool(), { command: 'echo "hello bash"', timeout: 5000 });
    const body = (res.content[0] as { text: string }).text;
    expect(body).toMatch(/hello bash/);
    expect(body).toMatch(/\[exit 0\]/);
  });
  test("reports non-zero exit codes", async () => {
    const res = await run(bashTool(), { command: "exit 3", timeout: 5000 });
    expect(res.details?.exit_code).toBe(3);
  });
  test("respects workdir", async () => {
    const d = newTmp();
    const res = await run(bashTool(), { command: "pwd", workdir: d, timeout: 5000 });
    expect((res.content[0] as { text: string }).text).toContain(d);
  });
});

describe("ls tool", () => {
  test("lists directory with dirs first and trailing slash", async () => {
    const d = newTmp();
    writeFileSync(join(d, "a.txt"), "x");
    require("node:fs").mkdirSync(join(d, "zdir"));
    require("node:fs").mkdirSync(join(d, "mdir"));
    const res = await run(lsTool(), { path: d });
    const lines = (res.content[0] as { text: string }).text.split("\n");
    // directories (mdir/, zdir/) come before the file (a.txt)
    expect(lines).toEqual(["mdir/", "zdir/", "a.txt"]);
  });
  test("errors on missing path", async () => {
    const res = await run(lsTool(), { path: "/no/such/dir" });
    expect((res.content[0] as { text: string }).text).toMatch(/no such path/);
  });
});

describe("builtinTools", () => {
  test("returns the default set, minus excluded", () => {
    const all = builtinTools();
    expect(all.map((t) => t.name).sort()).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "ls",
      "read",
      "todowrite",
      "web_fetch",
      "write",
    ]);
    const filtered = builtinTools({ exclude: ["bash", "edit"] });
    expect(filtered.map((t) => t.name).sort()).toEqual([
      "glob",
      "grep",
      "ls",
      "read",
      "todowrite",
      "web_fetch",
      "write",
    ]);
  });
});
