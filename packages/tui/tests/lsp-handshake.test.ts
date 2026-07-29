import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LspServerSpec,
  type LspSpawn,
  LspManager,
  type SpawnedConnection,
} from "../src/tools/_lsp.ts";

// Seam-freeze review (2026-07-27) drove a REAL typescript-language-server 5.3.0 and found
// this: `initialize` can answer with a JSON-RPC *error* — `Could not find a valid TypeScript
// installation … Exiting.` — in the very ordinary case of a workspace with no local
// typescript. The correlator resolved on `error` exactly as it does on `result`, so the
// handshake reported success, the client went on to didOpen a server that had already quit,
// and every subsequent edit burned the full 1500ms budget and reported `timeout`.
// Measured before the fix: 1502/1501/1501ms across three consecutive edits, forever.

const SPEC: LspServerSpec = {
  id: "tsserver",
  bin: "/nonexistent",
  args: [],
  extensions: new Set([".ts"]),
};

/** A connection that answers `initialize` with an error and then stays up, like a server
 * that has declined to work rather than crashed. */
function erroringSpawn(counter: { spawns: number }): LspSpawn {
  return (): SpawnedConnection => {
    counter.spawns += 1;
    let deliver: (msg: unknown) => void = () => {};
    return {
      alive: true,
      send(msg: object) {
        const m = msg as { id?: number; method?: string };
        if (m.method === "initialize") {
          queueMicrotask(() =>
            deliver({
              jsonrpc: "2.0",
              id: m.id,
              error: {
                code: -32603,
                message:
                  "Request initialize failed with message: Could not find a valid TypeScript installation.",
              },
            }),
          );
        }
      },
      onMessage(fn) {
        deliver = fn;
      },
      kill() {},
    };
  };
}

async function fixture(): Promise<{ dir: string; file: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "lsp-handshake-"));
  const file = join(dir, "a.ts");
  await writeFile(file, "export const x: number = 1;\n");
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("LSP handshake — an initialize error is a failure, not a success", () => {
  test("an errored initialize fails fast as `error`, never burning the timeout budget", async () => {
    const { dir, file, cleanup } = await fixture();
    const counter = { spawns: 0 };
    const m = new LspManager({
      workdir: dir,
      resolve: () => SPEC,
      spawn: erroringSpawn(counter),
      timeoutMs: 1500,
    });
    try {
      const started = Date.now();
      const r = await m.diagnosticsFor(file);
      const elapsed = Date.now() - started;
      // Before the fix this was `timeout` after ~1500ms; the status also misreported the
      // cause, so the operator-visible symptom was "slow server" not "server refused".
      expect(r.status).toBe("error");
      expect(r.diagnostics).toEqual([]);
      expect(elapsed).toBeLessThan(500);
    } finally {
      m.shutdown();
      cleanup();
    }
  });

  test("a definitively-failed server is not respawned on every edit", async () => {
    const { dir, file, cleanup } = await fixture();
    const counter = { spawns: 0 };
    const m = new LspManager({
      workdir: dir,
      resolve: () => SPEC,
      spawn: erroringSpawn(counter),
      timeoutMs: 1500,
    });
    try {
      for (let i = 0; i < 3; i += 1) {
        const r = await m.diagnosticsFor(file);
        expect(r.status).toBe("error");
      }
      // An explicit initialize error is definitive: the server told us it cannot work, so
      // retrying it once per edit only pays the spawn cost again.
      expect(counter.spawns).toBe(1);
    } finally {
      m.shutdown();
      cleanup();
    }
  });

  test("a handshake TIMEOUT stays retryable — only explicit errors are cached", async () => {
    const { dir, file, cleanup } = await fixture();
    let spawns = 0;
    const silent: LspSpawn = (): SpawnedConnection => {
      spawns += 1;
      return {
        alive: true,
        send() {},
        onMessage() {},
        kill() {},
      };
    };
    const m = new LspManager({ workdir: dir, resolve: () => SPEC, spawn: silent, timeoutMs: 40 });
    try {
      await m.diagnosticsFor(file);
      // Let the in-flight handshake actually lose its race before probing again; without
      // this the second call rides the first call's still-pending connection and the
      // assertion would be testing scheduling, not the retry policy.
      await Bun.sleep(150);
      await m.diagnosticsFor(file);
      // A timeout can be a slow machine or a cold project load; it must not permanently
      // disable diagnostics for the session the way a refusal does.
      expect(spawns).toBeGreaterThan(1);
    } finally {
      m.shutdown();
      cleanup();
    }
  });
});
