import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configFromEnv } from "../src/minima/config.ts";
import { ddgFetch } from "../src/tools/_ddg.ts";
import { webFetchTool } from "../src/tools/index.ts";

const realFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {
  EXA_API_KEY: process.env.EXA_API_KEY,
  MINIMA_TUI_FETCH_LOCAL: process.env.MINIMA_TUI_FETCH_LOCAL,
  MINIMA_TUI_EXPERIMENTAL: process.env.MINIMA_TUI_EXPERIMENTAL,
};

beforeEach(() => {
  delete process.env.EXA_API_KEY;
  delete process.env.MINIMA_TUI_FETCH_LOCAL;
  delete process.env.MINIMA_TUI_EXPERIMENTAL;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function run(tool: ReturnType<typeof webFetchTool>, args: Record<string, unknown>) {
  const parsed = tool.parameters.validate(args);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return tool.execute("t1", parsed.value, null, null);
}

function toolText(res: Awaited<ReturnType<typeof run>>): string {
  return (res.content[0] as { text: string }).text;
}

/** Replace global fetch with a URL-recording mock; returns the list of fetched URLs. */
function mockFetchCounting(handler: (url: string) => Response): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return calls;
}

const HTML = (body: string) =>
  new Response(`<html><head><title>T</title></head><body>${body}</body></html>`, {
    status: 200,
    headers: { "content-type": "text/html" },
  });

const REDIRECT = (location: string) =>
  new Response(null, { status: 302, headers: { location } });

describe("SSRF guard: blocked targets never see a connection", () => {
  test("web_fetch to a loopback listener is refused before any TCP connect", async () => {
    const accepted: number[] = [];
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          accepted.push(1);
          socket.write(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
          );
          socket.end();
        },
        data() {},
      },
    });
    try {
      const res = await run(webFetchTool(), { url: `http://127.0.0.1:${listener.port}/` });
      const out = toolText(res);
      expect(accepted.length).toBe(0);
      expect(out).toMatch(/web_fetch failed:/);
      expect(out).toContain("MINIMA_TUI_FETCH_LOCAL");
    } finally {
      listener.stop(true);
    }
  });

  test("web_fetch to a loopback HTTP server serves zero requests", async () => {
    let served = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        served++;
        return HTML("secret");
      },
    });
    try {
      const res = await run(webFetchTool(), { url: `http://127.0.0.1:${server.port}/` });
      expect(served).toBe(0);
      expect(toolText(res)).toMatch(/web_fetch failed:.*loopback/);
    } finally {
      server.stop(true);
    }
  });

  test("hostname resolving to loopback (localhost) is refused", async () => {
    let served = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        served++;
        return HTML("secret");
      },
    });
    try {
      await expect(ddgFetch(`http://localhost:${server.port}/`)).rejects.toThrow(/loopback/);
      expect(served).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("cloud metadata IP is refused without fetching", async () => {
    const calls = mockFetchCounting(() => HTML("meta"));
    await expect(ddgFetch("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /link-local/,
    );
    expect(calls).toEqual([]);
  });

  test("private, link-local, unspecified and IPv6-local literals are all refused", async () => {
    const blocked = [
      "http://10.0.0.8/",
      "http://172.16.5.5/",
      "http://172.31.255.254/",
      "http://192.168.1.20/",
      "http://0.0.0.0:8080/",
      "http://[::1]:9/",
      "http://[::]/",
      "http://[fe80::1]/",
      "http://[fd12:3456::1]/",
      "http://[fc00::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:10.0.0.1]/",
    ];
    for (const url of blocked) {
      const calls = mockFetchCounting(() => HTML("x"));
      let threw = false;
      try {
        await ddgFetch(url);
      } catch {
        threw = true;
      }
      expect({ url, threw, calls: calls.length }).toEqual({ url, threw: true, calls: 0 });
    }
  });

  test("non-http(s) schemes are refused without fetching", async () => {
    for (const url of ["file:///etc/hosts", "ftp://203.0.113.9/x", "gopher://203.0.113.9/"]) {
      const calls = mockFetchCounting(() => HTML("x"));
      const res = await run(webFetchTool(), { url });
      expect({ url, calls: calls.length }).toEqual({ url, calls: 0 });
      expect(toolText(res)).toMatch(/web_fetch failed:.*scheme/);
    }
  });
});

describe("SSRF guard: redirects are re-checked per hop", () => {
  test("public host redirecting to a private IP is blocked at the hop", async () => {
    const calls = mockFetchCounting((url) =>
      url === "http://203.0.113.9/start" ? REDIRECT("http://192.168.1.9/loot") : HTML("loot"),
    );
    await expect(ddgFetch("http://203.0.113.9/start")).rejects.toThrow(/private/);
    expect(calls).toEqual(["http://203.0.113.9/start"]);
  });

  test("public-to-public redirects (absolute and relative) still work", async () => {
    const calls = mockFetchCounting((url) => {
      if (url === "http://203.0.113.9/one") return REDIRECT("http://203.0.113.10/two");
      if (url === "http://203.0.113.10/two") return REDIRECT("/three");
      return HTML("hello world");
    });
    const data = await ddgFetch("http://203.0.113.9/one");
    expect(data.results[0]?.text).toContain("hello world");
    expect(calls).toEqual([
      "http://203.0.113.9/one",
      "http://203.0.113.10/two",
      "http://203.0.113.10/three",
    ]);
  });

  test("redirect to a non-http(s) scheme is blocked", async () => {
    const calls = mockFetchCounting((url) =>
      url === "http://203.0.113.9/start" ? REDIRECT("file:///etc/passwd") : HTML("x"),
    );
    await expect(ddgFetch("http://203.0.113.9/start")).rejects.toThrow(/scheme/);
    expect(calls).toEqual(["http://203.0.113.9/start"]);
  });

  test("redirect chains are capped", async () => {
    let n = 0;
    const calls = mockFetchCounting(() => {
      n++;
      return REDIRECT(`http://203.0.113.9/hop${n}`);
    });
    await expect(ddgFetch("http://203.0.113.9/hop0")).rejects.toThrow(/redirect/);
    expect(calls.length).toBe(6);
  });
});

describe("SSRF guard: MINIMA_TUI_FETCH_LOCAL=1 opt-out", () => {
  test("allows loopback fetches and follows local redirects", async () => {
    process.env.MINIMA_TUI_FETCH_LOCAL = "1";
    let served = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        served++;
        if (new URL(req.url).pathname === "/a") return REDIRECT("/b");
        return HTML("hello world");
      },
    });
    try {
      const data = await ddgFetch(`http://127.0.0.1:${server.port}/a`);
      expect(data.results[0]?.text).toContain("hello world");
      expect(served).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("does not unlock non-http(s) schemes", async () => {
    process.env.MINIMA_TUI_FETCH_LOCAL = "1";
    const calls = mockFetchCounting(() => HTML("x"));
    await expect(ddgFetch("file:///etc/hosts")).rejects.toThrow(/scheme/);
    expect(calls).toEqual([]);
  });
});

describe("SSRF guard: public fetches unchanged", () => {
  test("plain public fetch returns title and text as before", async () => {
    const calls = mockFetchCounting(() => HTML("plain public page"));
    const res = await run(webFetchTool(), { url: "http://203.0.113.7/doc" });
    const out = toolText(res);
    expect(out).toContain("# T");
    expect(out).toContain("plain public page");
    expect(calls).toEqual(["http://203.0.113.7/doc"]);
  });
});

describe("MINIMA_TUI_FETCH_LOCAL config wiring", () => {
  test("defaults to deny; env flips it; consent gate ignores experimental", () => {
    delete process.env.MINIMA_TUI_FETCH_LOCAL;
    expect(configFromEnv().fetchLocal).toBe(false);
    process.env.MINIMA_TUI_FETCH_LOCAL = "1";
    expect(configFromEnv().fetchLocal).toBe(true);
    process.env.MINIMA_TUI_FETCH_LOCAL = "0";
    expect(configFromEnv().fetchLocal).toBe(false);
    delete process.env.MINIMA_TUI_FETCH_LOCAL;
    process.env.MINIMA_TUI_EXPERIMENTAL = "1";
    expect(configFromEnv().fetchLocal).toBe(false);
  });
});
