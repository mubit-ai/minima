import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AskUserRef,
  bashTool,
  builtinTools,
  editTool,
  lsTool,
  questionTool,
  readTool,
  webFetchTool,
  webSearchTool,
  writeTool,
} from "../src/tools/index.ts";
import { EXA_SEARCH_FEE_USD } from "../src/tools/web_search.ts";

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
      "apply_patch",
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
      "apply_patch",
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

  test("todowrite runs sequentially so baseline checks see the pre-work repo (M3.3, Big Plan on)", () => {
    const todo = builtinTools({ bigPlan: true }).find((t) => t.name === "todowrite")!;
    expect(todo.executionMode).toBe("sequential");
    expect(todo.description).toContain("verify");
  });

  test("todowrite stays plain with Big Plan off: no verify promise, no sequential mode", () => {
    const todo = builtinTools().find((t) => t.name === "todowrite")!;
    expect(todo.executionMode).toBeUndefined();
    expect(todo.description).not.toContain("verify");
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

/**
 * Route mocked responses by request URL — needed for fallback tests where one call hits
 * Exa (`api.exa.ai`) and a second hits DuckDuckGo/the target site.
 */
function mockFetchRouted(
  handler: (url: string) => { status: number; body: unknown; contentType?: string },
): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const { status, body, contentType = "application/json" } = handler(url);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": contentType },
    });
  }) as typeof fetch;
}

/** A minimal lite.duckduckgo.com results page: one uddg-wrapped link, one direct link. */
const DDG_LITE_HTML = `<html><body><table>
  <tr><td>
    <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&rut=x"
       class="result-link">First &amp; Best</a>
  </td></tr>
  <tr><td>
    <a href="https://second.example/two" class='result-link'>Second Result</a>
  </td></tr>
  <tr><td><a href="https://ads.example/skip" class="ad-link">Ad</a></td></tr>
</table></body></html>`;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedExaKey === undefined) {
    delete process.env.EXA_API_KEY;
  } else {
    process.env.EXA_API_KEY = savedExaKey;
  }
});

describe("web_search tool", () => {
  test("falls back to DuckDuckGo when EXA_API_KEY is unset", async () => {
    delete process.env.EXA_API_KEY;
    mockFetch(200, DDG_LITE_HTML); // body is a string → served as-is (HTML)
    const res = await run(webSearchTool(), { query: "typescript" });
    const out = (res.content[0] as { text: string }).text;
    // uddg redirect is decoded to the real URL; the direct link is kept; the ad is dropped.
    expect(out).toContain("[1] First & Best");
    expect(out).toContain("https://example.com/one");
    expect(out).toContain("[2] Second Result");
    expect(out).toContain("https://second.example/two");
    expect(out).not.toContain("ads.example");
    expect(res.details?.provider).toBe("duckduckgo");
    expect(res.details?.count).toBe(2);
  });

  test("falls back to DuckDuckGo when the Exa call fails", async () => {
    process.env.EXA_API_KEY = "test-key";
    mockFetchRouted((url) =>
      url.includes("api.exa.ai")
        ? { status: 500, body: { error: "boom" } } // Exa transient failure (retried, then gives up)
        : { status: 200, body: DDG_LITE_HTML, contentType: "text/html" },
    );
    const res = await run(webSearchTool(), { query: "x" });
    const out = (res.content[0] as { text: string }).text;
    expect(out).toContain("[1] First & Best");
    expect(res.details?.provider).toBe("duckduckgo");
  });

  test("reports no results from DuckDuckGo", async () => {
    delete process.env.EXA_API_KEY;
    mockFetch(200, "<html><body>no results here</body></html>");
    const res = await run(webSearchTool(), { query: "nothing" });
    expect((res.content[0] as { text: string }).text).toBe("No results found.");
    expect(res.details?.provider).toBe("duckduckgo");
    expect(res.details?.count).toBe(0);
  });

  test("surfaces a clean error when both providers fail", async () => {
    delete process.env.EXA_API_KEY;
    mockFetch(400, "bad request");
    const res = await run(webSearchTool(), { query: "x" });
    expect((res.content[0] as { text: string }).text).toMatch(/web_search failed:/);
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

  // MUB-172: the Exa per-search fee is real provider spend — book it via onFeeUsd keyed by
  // the tool_call_id, and disclose it in details.
  test("books the Exa per-search fee via onFeeUsd, keyed by tool_call_id", async () => {
    process.env.EXA_API_KEY = "test-key";
    mockFetch(200, { results: [{ url: "https://a.example", title: "Alpha" }] });
    const fees: [number, string][] = [];
    const res = await run(webSearchTool({ onFeeUsd: (usd, id) => fees.push([usd, id]) }), {
      query: "x",
    });
    expect(fees).toEqual([[EXA_SEARCH_FEE_USD, "t1"]]);
    expect(res.details?.feeUsd).toBe(EXA_SEARCH_FEE_USD);
  });

  test("Exa charges the search even when it returns zero results", async () => {
    process.env.EXA_API_KEY = "test-key";
    mockFetch(200, { results: [] });
    const fees: number[] = [];
    const res = await run(webSearchTool({ onFeeUsd: (usd) => fees.push(usd) }), { query: "x" });
    expect(fees).toEqual([EXA_SEARCH_FEE_USD]);
    expect(res.details?.feeUsd).toBe(EXA_SEARCH_FEE_USD);
  });

  test("DuckDuckGo is free: no fee callback, feeUsd 0 in details", async () => {
    delete process.env.EXA_API_KEY;
    mockFetch(200, DDG_LITE_HTML);
    const fees: number[] = [];
    const res = await run(webSearchTool({ onFeeUsd: (usd) => fees.push(usd) }), { query: "x" });
    expect(fees).toEqual([]);
    expect(res.details?.feeUsd).toBe(0);
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

  test("surfaces a clean error when both providers fail", async () => {
    process.env.EXA_API_KEY = "bad";
    // Exa 401 (auth) is not retried → fall back to DDG, which also 401s on the target.
    mockFetch(401, { error: "nope" });
    const res = await run(webFetchTool(), { url: "https://a.example" });
    expect((res.content[0] as { text: string }).text).toMatch(/web_fetch failed:/);
  });
});

describe("web_fetch tool (DuckDuckGo fallback)", () => {
  const PAGE_HTML = `<html><head><title>Doc &amp; Co</title><style>x{}</style></head>
    <body><script>ignore()</script><h1>Heading</h1><p>Hello <b>world</b>.</p></body></html>`;

  test("raw-fetches and strips HTML to text when no Exa key", async () => {
    delete process.env.EXA_API_KEY;
    mockFetchRouted(() => ({ status: 200, body: PAGE_HTML, contentType: "text/html" }));
    const res = await run(webFetchTool(), { url: "https://a.example" });
    const out = (res.content[0] as { text: string }).text;
    expect(out).toContain("# Doc & Co"); // decoded title header
    expect(out).toContain("Heading");
    expect(out).toContain("Hello world"); // tags stripped (inline tags become whitespace), entities decoded
    expect(out).not.toContain("ignore()"); // <script> removed
    expect(out).not.toContain("<p>");
    expect(res.details?.truncated).toBe(false);
  });

  test("falls back to DuckDuckGo when the Exa contents call fails", async () => {
    process.env.EXA_API_KEY = "test-key";
    mockFetchRouted((url) =>
      url.includes("api.exa.ai")
        ? { status: 401, body: { error: "nope" } } // Exa auth failure
        : { status: 200, body: PAGE_HTML, contentType: "text/html" },
    );
    const res = await run(webFetchTool(), { url: "https://a.example" });
    const out = (res.content[0] as { text: string }).text;
    expect(out).toContain("Hello world");
    expect(res.details?.url).toBe("https://a.example");
  });
});

describe("question tool", () => {
  test("headless (no ask callback) tells the model to proceed", async () => {
    const ref: AskUserRef = { current: null };
    const res = await run(questionTool(ref), { question: "Which one?" });
    expect((res.content[0] as { text: string }).text).toMatch(/headless|best assumption/i);
    expect(res.details?.answered).toBe(false);
    expect(res.details?.reason).toBe("headless");
  });

  test("returns the user's answer when ask resolves", async () => {
    const ref: AskUserRef = { current: async () => "Option B" };
    const res = await run(questionTool(ref), {
      question: "Pick",
      options: [{ label: "Option A" }, { label: "Option B", description: "the good one" }],
    });
    expect((res.content[0] as { text: string }).text).toBe("The user answered: Option B");
    expect(res.details?.answered).toBe(true);
    expect(res.details?.answer).toBe("Option B");
  });

  test("dismissed (ask resolves null) tells the model to proceed", async () => {
    const ref: AskUserRef = { current: async () => null };
    const res = await run(questionTool(ref), { question: "Pick" });
    expect((res.content[0] as { text: string }).text).toMatch(/dismissed|best judgment/i);
    expect(res.details?.answered).toBe(false);
    expect(res.details?.reason).toBe("dismissed");
  });

  test("validates required question and option labels", () => {
    const ref: AskUserRef = { current: null };
    const tool = questionTool(ref);
    expect(tool.parameters.validate({}).ok).toBe(false);
    expect(
      tool.parameters.validate({ question: "q", options: [{ description: "no label" }] }).ok,
    ).toBe(false);
    const ok = tool.parameters.validate({ question: "q" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.allow_freetext).toBe(true);
  });

  test("accepts the lenient option shapes weak models emit (string shorthand + label aliases)", () => {
    const tool = questionTool({ current: null });
    // bare strings become { label }
    const strs = tool.parameters.validate({ question: "q", options: ["Yes", "No"] });
    expect(strs.ok).toBe(true);
    if (strs.ok) expect(strs.value.options).toEqual([{ label: "Yes" }, { label: "No" }]);
    // title/name are accepted as aliases for label
    const aliased = tool.parameters.validate({
      question: "q",
      options: [{ title: "A" }, { name: "B", description: "d" }],
    });
    expect(aliased.ok).toBe(true);
    if (aliased.ok)
      expect(aliased.value.options).toEqual([{ label: "A" }, { label: "B", description: "d" }]);
    // a truly labelless object is still rejected
    expect(tool.parameters.validate({ question: "q", options: [{ foo: "bar" }] }).ok).toBe(false);
    // a non-array options is still rejected with the same message
    const bad = tool.parameters.validate({ question: "q", options: "Yes" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join()).toContain("options: must be an array");
  });

  test("is sequential (never runs concurrently with other tools)", () => {
    expect(questionTool({ current: null }).executionMode).toBe("sequential");
  });
});
