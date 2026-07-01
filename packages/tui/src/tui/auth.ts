/**
 * `minima auth` — one-click browser login that provisions a managed Mubit
 * project for this repo and returns a scoped API key to the locally-running CLI.
 *
 * Loopback + PKCE (the `gh auth login` pattern): we start an ephemeral HTTP
 * server on 127.0.0.1, open the browser to the Mubit console's /app/cli-auth
 * page, and — after Clerk login + server-side provisioning — the browser
 * redirects a one-time code to our loopback. We then exchange {code, verifier}
 * at /api/cli/token for the key. The verifier never leaves this process, so the
 * code (all the browser ever sees) is useless on its own.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";

export const DEFAULT_CONSOLE_URL = "https://console.mubit.ai";

export interface AuthResult {
  mubitApiKey: string;
  minimaUrl: string;
  instanceId: string;
  projectId: string;
  namespace: string;
}

export interface RunAuthOptions {
  /** Stable repo identity → project name (see projects.repoIdentity). */
  repo: string;
  /** Mubit console base URL, e.g. https://console.mubit.ai. */
  consoleUrl?: string;
  region?: "eu" | "us";
  /** Overall deadline for the whole flow (default 120s). */
  timeoutMs?: number;
  /** Injectable for tests / headless. Default opens the OS browser. */
  openBrowser?: (url: string) => void;
  /** Called with the auth URL (so callers can print a manual fallback). */
  onUrl?: (url: string) => void;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function openBrowserDefault(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // If the browser can't be opened, the caller's onUrl fallback still prints the link.
  }
}

interface Loopback {
  port: number;
  waitForCode: (timeoutMs: number) => Promise<string>;
  close: () => void;
}

function startLoopback(state: string): Promise<Loopback> {
  return new Promise((resolveStart, rejectStart) => {
    let resolveCode: (code: string) => void;
    let rejectCode: (err: Error) => void;
    const done = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = u.searchParams.get("code");
      const gotState = u.searchParams.get("state");
      if (!code || gotState !== state) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end("<h2>Invalid authorization callback.</h2>");
        rejectCode(new Error("invalid callback (state mismatch or missing code)"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<html><body style='font-family:system-ui;text-align:center;padding-top:4rem'>" +
          "<h2>Minima CLI authorized ✅</h2>" +
          "<p>You can close this tab and return to your terminal.</p></body></html>",
      );
      resolveCode(code);
    });

    server.on("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      let settled = false;
      const waitForCode = (timeoutMs: number) =>
        new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error("timed out waiting for browser authorization"));
          }, timeoutMs);
          done.then(
            (code) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(code);
            },
            (err) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              reject(err);
            },
          );
        });
      resolveStart({ port, waitForCode, close: () => server.close() });
    });
  });
}

function buildAuthUrl(
  consoleUrl: string,
  q: {
    port: number;
    state: string;
    challenge: string;
    repo: string;
    host: string;
    region?: string;
  },
): string {
  const base = consoleUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/app/cli-auth`);
  url.searchParams.set("port", String(q.port));
  url.searchParams.set("state", q.state);
  url.searchParams.set("challenge", q.challenge);
  url.searchParams.set("repo", q.repo);
  url.searchParams.set("host", q.host);
  if (q.region) url.searchParams.set("region", q.region);
  return url.toString();
}

export async function runAuth(opts: RunAuthOptions): Promise<AuthResult> {
  const consoleUrl = (opts.consoleUrl || DEFAULT_CONSOLE_URL).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { verifier, challenge } = makePkce();
  const state = base64url(randomBytes(16));

  const loop = await startLoopback(state);
  try {
    const url = buildAuthUrl(consoleUrl, {
      port: loop.port,
      state,
      challenge,
      repo: opts.repo,
      host: hostname(),
      region: opts.region,
    });
    opts.onUrl?.(url);
    (opts.openBrowser ?? openBrowserDefault)(url);

    const code = await loop.waitForCode(timeoutMs);

    const res = await fetchImpl(`${consoleUrl}/api/cli/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, verifier }),
    });
    if (!res.ok) {
      throw new Error(`token exchange failed (HTTP ${res.status})`);
    }
    const data = (await res.json()) as Partial<AuthResult>;
    if (!data.mubitApiKey) {
      throw new Error("server did not return an API key");
    }
    return {
      mubitApiKey: data.mubitApiKey,
      minimaUrl: data.minimaUrl ?? "",
      instanceId: data.instanceId ?? "",
      projectId: data.projectId ?? "",
      namespace: data.namespace ?? "",
    };
  } finally {
    loop.close();
  }
}
