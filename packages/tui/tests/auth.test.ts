import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProvisioningPending, runAuth } from "../src/tui/auth.ts";
import { getProject, repoIdentity, setProject, setProjectsDir } from "../src/tui/projects.ts";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * A fake console: serves /api/cli/provision + /api/cli/token, and mimics the
 * browser by hitting the CLI's loopback /callback when we "open" the URL.
 */
function fakeConsole(): Promise<{ url: string; close: () => void; server: Server }> {
  return new Promise((resolve) => {
    const codes = new Map<string, { challenge: string }>();
    const server = createServer(async (req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};

      if (u.pathname === "/api/cli/provision") {
        const code = "test-code-123";
        codes.set(code, { challenge: body.codeChallenge });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code }));
        return;
      }
      if (u.pathname === "/api/cli/token") {
        const rec = codes.get(body.code);
        const expected = base64url(createHash("sha256").update(body.verifier).digest());
        if (!rec || rec.challenge !== expected) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ statusMessage: "Invalid or expired code" }));
          return;
        }
        codes.delete(body.code); // single use
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            mubitApiKey: "mbt_test_key_abc",
            minimaUrl: "https://api.minima.sh",
            instanceId: "mnm-abcdef",
            projectId: "proj_test",
            namespace: "proj_test",
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close(), server });
    });
  });
}

describe("runAuth (loopback + PKCE)", () => {
  test("provisions, exchanges the code, and returns the key", async () => {
    const console_ = await fakeConsole();
    try {
      // "Open browser" = drive the console's provision then redirect to the loopback.
      const openBrowser = (authUrl: string) => {
        const parsed = new URL(authUrl);
        const port = parsed.searchParams.get("port");
        const state = parsed.searchParams.get("state");
        const challenge = parsed.searchParams.get("challenge");
        const repo = parsed.searchParams.get("repo");
        void (async () => {
          const provisionRes = await fetch(`${console_.url}/api/cli/provision`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ repo, codeChallenge: challenge }),
          });
          const { code } = (await provisionRes.json()) as { code: string };
          await fetch(`http://127.0.0.1:${port}/callback?code=${code}&state=${state}`);
        })();
      };

      const result = await runAuth({
        repo: "github.com/acme/widget",
        consoleUrl: console_.url,
        openBrowser,
        timeoutMs: 5000,
      });

      expect(result.mubitApiKey).toBe("mbt_test_key_abc");
      expect(result.namespace).toBe("proj_test");
      expect(result.instanceId).toBe("mnm-abcdef");
    } finally {
      console_.close();
    }
  });

  test("rejects a bad PKCE verifier (challenge mismatch → token 400)", async () => {
    const console_ = await fakeConsole();
    try {
      // Malicious/broken opener: provisions with a DIFFERENT challenge than the CLI's verifier.
      const openBrowser = (authUrl: string) => {
        const parsed = new URL(authUrl);
        const port = parsed.searchParams.get("port");
        const state = parsed.searchParams.get("state");
        void (async () => {
          const provisionRes = await fetch(`${console_.url}/api/cli/provision`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              repo: "x",
              codeChallenge: "not-the-real-challenge-000000000000",
            }),
          });
          const { code } = (await provisionRes.json()) as { code: string };
          await fetch(`http://127.0.0.1:${port}/callback?code=${code}&state=${state}`);
        })();
      };

      await expect(
        runAuth({ repo: "x", consoleUrl: console_.url, openBrowser, timeoutMs: 5000 }),
      ).rejects.toThrow(/token exchange failed/);
    } finally {
      console_.close();
    }
  });

  test("throws ProvisioningPending when the workspace is still coming up", async () => {
    // First-time tenant: the console returns {status:'provisioning'}, so the page
    // redirects `provisioning=1` (no code) and runAuth surfaces a retry signal.
    const openBrowser = (authUrl: string) => {
      const parsed = new URL(authUrl);
      const port = parsed.searchParams.get("port");
      const state = parsed.searchParams.get("state");
      // The loopback 302-redirects to the (unreachable) console; swallow that.
      void fetch(`http://127.0.0.1:${port}/callback?provisioning=1&state=${state}`).catch(() => {});
    };
    await expect(
      runAuth({ repo: "x", consoleUrl: "http://127.0.0.1:1", openBrowser, timeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(ProvisioningPending);
  });

  test("times out when the browser never returns", async () => {
    const console_ = await fakeConsole();
    try {
      await expect(
        runAuth({ repo: "x", consoleUrl: console_.url, openBrowser: () => {}, timeoutMs: 150 }),
      ).rejects.toThrow(/timed out/);
    } finally {
      console_.close();
    }
  });
});

describe("projects map", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("round-trips a per-repo mapping (0600 file)", async () => {
    dir = mkdtempSync(join(tmpdir(), "minima-proj-"));
    setProjectsDir(dir);
    expect(await getProject("github.com/acme/widget")).toBeNull();
    await setProject("github.com/acme/widget", {
      instanceId: "mnm-1",
      projectId: "p1",
      namespace: "p1",
      minimaUrl: "https://api.minima.sh",
    });
    const got = await getProject("github.com/acme/widget");
    expect(got?.namespace).toBe("p1");
    // isolation: a different repo has no mapping
    expect(await getProject("github.com/acme/other")).toBeNull();
  });

  test("repoIdentity returns a stable non-empty string for the cwd", () => {
    const id = repoIdentity(process.cwd());
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});
