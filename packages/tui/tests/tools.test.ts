import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bashTool,
  builtinTools,
  editTool,
  lsTool,
  readTool,
  webFetchTool,
  webSearchTool,
  writeTool,
} from "../src/tools/index.ts";

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
      "web_search",
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
      "web_search",
      "write",
    ]);
  });
});

// --- Exa-backed web tools ---------------------------------------------------

const realFetch = globalThis.fetch;
const savedExaKey = process.env.EXA_API_KEY;

function mockFetch(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedExaKey === undefined) {
    delete process.env.EXA_API_KEY;
  } else {
    process.env.EXA_API_KEY = savedExaKey;
  }
});

describe("web_search tool", () => {
  test("errors clearly when EXA_API_KEY is unset", async () => {
    delete process.env.EXA_API_KEY;
    const res = await run(webSearchTool(), { query: "typescript" });
    expect((res.content[0] as { text: string }).text).toMatch(/EXA_API_KEY is not set/);
  });

  test("formats a numbered list of results", async () => {
    process.env.EXA_API_KEY = "test-key";
    mockFetch(200, {
      results: [
        { url: "https://a.example", title: "Alpha", publishedDate: "2025-01-01" },
        { url: "https://b.example", title: "Beta" },
      ],
    });
    const res = await run(webSearchTool(), { query: "x", num_results: 20 });
    const out = (res.content[0] as { text: string }).text;
    expect(out).toContain("[1] Alpha (2025-01-01)");
    expect(out).toContain("https://a.example");
    expect(out).toContain("[2] Beta");
    expect(res.details?.count).toBe(2);
  });

  test("reports no results", async () => {
    process.env.EXA_API_KEY = "test-key";
    mockFetch(200, { results: [] });
    const res = await run(webSearchTool(), { query: "nothing" });
    expect((res.content[0] as { text: string }).text).toBe("No results found.");
    expect(res.details?.count).toBe(0);
  });
});

describe("web_fetch tool (Exa)", () => {
  test("returns page text with a title header", async () => {
    process.env.EXA_API_KEY = "test-key";
    mockFetch(200, {
      results: [{ url: "https://a.example", title: "Doc", text: "hello world" }],
    });
    const res = await run(webFetchTool(), { url: "https://a.example" });
    const out = (res.content[0] as { text: string }).text;
    expect(out).toContain("# Doc");
    expect(out).toContain("hello world");
    expect(res.details?.truncated).toBe(false);
  });

  test("truncates past max_chars", async () => {
    process.env.EXA_API_KEY = "test-key";
    mockFetch(200, { results: [{ url: "https://a.example", text: "x".repeat(2000) }] });
    const res = await run(webFetchTool(), { url: "https://a.example", max_chars: 500 });
    const out = (res.content[0] as { text: string }).text;
    expect(out).toContain("[truncated — 1500 more chars]");
    expect(res.details?.truncated).toBe(true);
  });

  test("surfaces auth failure", async () => {
    process.env.EXA_API_KEY = "bad";
    mockFetch(401, { error: "nope" });
    const res = await run(webFetchTool(), { url: "https://a.example" });
    expect((res.content[0] as { text: string }).text).toMatch(/web_fetch failed:.*authentication/);
  });
});
