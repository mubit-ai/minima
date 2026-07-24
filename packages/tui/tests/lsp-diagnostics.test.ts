import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentState } from "../src/agent/state.ts";
import type { AfterToolCallContext, ToolResult } from "../src/agent/tools.ts";
import type { ToolCall } from "../src/ai/types.ts";
import { configFromEnv } from "../src/minima/config.ts";
import {
  type DiagnosticsResult,
  LspFramer,
  type LspServerSpec,
  type LspSpawn,
  LspManager,
  type SpawnedConnection,
  makeLspDiagnosticsHook,
} from "../src/tools/_lsp.ts";
import { applyPatchTool } from "../src/tools/apply_patch.ts";
import { editTool } from "../src/tools/edit.ts";

const STUB = join(import.meta.dir, "fixtures", "lsp-stub-server.ts");

// Mode + pidfile ride argv (not env): Bun.spawn does not reflect a parent's runtime-mutated
// process.env into the child, so the stub reads --mode=/--pidfile= flags deterministically.
function stubSpec(mode: string, pidfile?: string): LspServerSpec {
  const args = [STUB, `--mode=${mode}`];
  if (pidfile) args.push(`--pidfile=${pidfile}`);
  return { id: "tsserver", bin: process.execPath, args, extensions: new Set([".ts"]) };
}

const cleanups: (() => void)[] = [];
const managers: LspManager[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function manager(
  dir: string,
  opts: { mode: string; timeoutMs?: number; pidfile?: string },
): LspManager {
  const m = new LspManager({
    workdir: dir,
    resolve: () => stubSpec(opts.mode, opts.pidfile),
    timeoutMs: opts.timeoutMs,
  });
  managers.push(m);
  return m;
}

afterEach(() => {
  for (const m of managers.splice(0)) {
    try {
      m.shutdown();
    } catch {
      // best-effort
    }
  }
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      // best-effort
    }
  }
});

function ctx(
  name: string,
  args: Record<string, unknown>,
  result: ToolResult,
  isError = false,
): AfterToolCallContext {
  const tc: ToolCall = { type: "toolCall", id: "t", name, arguments: args };
  return { toolCall: tc, result, isError, context: new AgentState() };
}

function textOf(b: unknown): string {
  return (b as { text?: string }).text ?? "";
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await Bun.sleep(25);
  }
  return cond();
}

describe("LSP diagnostics hook (W5.1)", () => {
  test("AC1: surfaces a type error in the same turn", async () => {
    const dir = tempDir("lsp-ac1-");
    const file = join(dir, "bad.ts");
    await writeFile(file, "const x: number = 1;\n", "utf8");
    const edit = editTool({ workdir: dir });
    const result = await edit.execute(
      "t",
      { path: file, old_string: "const x: number = 1;", new_string: "const x: number = 'oops';" },
      null,
      null,
    );
    expect(result.details?.error).toBeUndefined();

    const hook = makeLspDiagnosticsHook(manager(dir, { mode: "error" }), { workdir: dir });
    const ar = await hook(ctx("edit", { path: file }, result));
    expect(ar).not.toBeNull();
    const lsp = ar?.details?.lsp as DiagnosticsResult;
    expect(lsp.status).toBe("ok");
    expect(lsp.diagnostics.length).toBeGreaterThan(0);
    const appended = (ar?.content ?? []).map(textOf).join("\n");
    expect(appended).toContain("not assignable");
    // original tool content survives — the hook only appends
    expect(appended).toContain("edited");
  });

  test("AC2: absent server is byte-identical", async () => {
    const dir = tempDir("lsp-ac2-");
    const file = join(dir, "a.ts");
    await writeFile(file, "const a = 1;\n");
    const edit = editTool({ workdir: dir });
    const result = await edit.execute(
      "t",
      { path: file, old_string: "const a = 1;", new_string: "const a = 2;" },
      null,
      null,
    );
    const baseline = structuredClone(result);
    const mgr = new LspManager({ workdir: dir, resolve: () => null });
    managers.push(mgr);
    const hook = makeLspDiagnosticsHook(mgr, { workdir: dir });
    const ar = await hook(ctx("edit", { path: file }, result));
    expect(ar).toBeNull();
    expect(result).toEqual(baseline);
  });

  test("AC3: slow server times out and skips", async () => {
    const dir = tempDir("lsp-ac3-");
    const file = join(dir, "s.ts");
    await writeFile(file, "const s = 1;\n");
    const edit = editTool({ workdir: dir });
    const result = await edit.execute(
      "t",
      { path: file, old_string: "const s = 1;", new_string: "const s = 2;" },
      null,
      null,
    );
    const baseline = structuredClone(result);
    const timeoutMs = 400;
    const hook = makeLspDiagnosticsHook(manager(dir, { mode: "slow", timeoutMs }), {
      workdir: dir,
    });
    const started = Date.now();
    const ar = await hook(ctx("edit", { path: file }, result));
    const elapsed = Date.now() - started;
    expect(ar).toBeNull();
    expect(elapsed).toBeLessThan(timeoutMs + 1500);
    expect(result).toEqual(baseline);
  });

  test("AC4: clean file appends nothing", async () => {
    const dir = tempDir("lsp-ac4-");
    const file = join(dir, "clean.ts");
    await writeFile(file, "const c = 1;\n");
    const edit = editTool({ workdir: dir });
    const result = await edit.execute(
      "t",
      { path: file, old_string: "const c = 1;", new_string: "const c = 2;" },
      null,
      null,
    );
    const baseline = structuredClone(result);
    const hook = makeLspDiagnosticsHook(manager(dir, { mode: "clean" }), { workdir: dir });
    const ar = await hook(ctx("edit", { path: file }, result));
    expect(ar).toBeNull();
    expect(result).toEqual(baseline);
  });

  test("AC5: apply_patch surfaces diagnostics", async () => {
    const dir = tempDir("lsp-ac5-");
    const f1 = join(dir, "one.ts");
    const f2 = join(dir, "two.ts");
    await writeFile(f1, "const one = 1;\n");
    await writeFile(f2, "const two = 2;\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.ts",
      "@@",
      "-const one = 1;",
      "+const one = 'x';",
      "*** Update File: two.ts",
      "@@",
      "-const two = 2;",
      "+const two = 'y';",
      "*** End Patch",
    ].join("\n");
    const ap = applyPatchTool({ workdir: dir });
    const result = await ap.execute("t", { patch }, null, null);
    expect(result.details?.writes).toBeDefined();
    const hook = makeLspDiagnosticsHook(manager(dir, { mode: "error" }), { workdir: dir });
    const ar = await hook(ctx("apply_patch", { patch }, result));
    expect(ar).not.toBeNull();
    const lsp = ar?.details?.lsp as DiagnosticsResult[];
    expect(Array.isArray(lsp)).toBe(true);
    const withDiag = lsp.filter((r) => r.diagnostics.length > 0);
    expect(withDiag.length).toBe(2);
  });

  test("AC6: shutdown kills the server", async () => {
    const dir = tempDir("lsp-ac6-");
    const pidfile = join(dir, "stub.pid");
    const file = join(dir, "k.ts");
    await writeFile(file, "const k = 1;\n");
    const mgr = manager(dir, { mode: "error", pidfile });
    await mgr.diagnosticsFor(file);
    expect(await waitFor(() => existsSync(pidfile), 4000)).toBe(true);
    const pid = Number(readFileSync(pidfile, "utf8").trim());
    expect(Number.isFinite(pid)).toBe(true);
    expect(alive(pid)).toBe(true);
    mgr.shutdown();
    expect(await waitFor(() => !alive(pid), 4000)).toBe(true);
  });

  test("AC7: frames split across chunks", () => {
    const got: { id?: number; method?: string }[] = [];
    const framer = new LspFramer((m) => got.push(m));
    const enc = new TextEncoder();
    const frame = (obj: unknown): Uint8Array => {
      const body = enc.encode(JSON.stringify(obj));
      const header = enc.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
      const out = new Uint8Array(header.byteLength + body.byteLength);
      out.set(header, 0);
      out.set(body, header.byteLength);
      return out;
    };
    const m1 = frame({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    const m2 = frame({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: "file:///x", diagnostics: [] },
    });
    // m1 split across three chunks: mid-header, then mid-body
    framer.push(m1.subarray(0, 8));
    framer.push(m1.subarray(8, 20));
    framer.push(m1.subarray(20));
    // two whole messages in a single chunk
    const combined = new Uint8Array(m2.byteLength * 2);
    combined.set(m2, 0);
    combined.set(m2, m2.byteLength);
    framer.push(combined);
    expect(got.length).toBe(3);
    expect(got[0]?.id).toBe(1);
    expect(got[1]?.method).toBe("textDocument/publishDiagnostics");
    expect(got[2]?.method).toBe("textDocument/publishDiagnostics");
  });

  test("AC8: flag resolves through optInFlag", () => {
    const savedLsp = process.env.MINIMA_TUI_LSP;
    const savedExp = process.env.MINIMA_TUI_EXPERIMENTAL;
    const restore = (v: string | undefined, k: string): void => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    try {
      delete process.env.MINIMA_TUI_LSP;
      delete process.env.MINIMA_TUI_EXPERIMENTAL;
      expect(configFromEnv().lsp).toBe(false);
      process.env.MINIMA_TUI_LSP = "1";
      expect(configFromEnv().lsp).toBe(true);
      delete process.env.MINIMA_TUI_LSP;
      process.env.MINIMA_TUI_EXPERIMENTAL = "1";
      expect(configFromEnv().lsp).toBe(true);
      process.env.MINIMA_TUI_LSP = "0";
      expect(configFromEnv().lsp).toBe(false);
    } finally {
      restore(savedLsp, "MINIMA_TUI_LSP");
      restore(savedExp, "MINIMA_TUI_EXPERIMENTAL");
    }
  });

  test("injected spawn seam correlates publishDiagnostics in-process", async () => {
    const dir = tempDir("lsp-inproc-");
    const file = join(dir, "p.ts");
    await writeFile(file, "const p = 1;\n");
    const spawn: LspSpawn = (): SpawnedConnection => {
      let listener: ((m: unknown) => void) | null = null;
      return {
        alive: true,
        send(msg: { id?: number; method?: string; params?: { textDocument?: { uri: string; version: number } } }) {
          if (msg.method === "initialize") {
            listener?.({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
            return;
          }
          if (msg.method === "textDocument/didOpen" || msg.method === "textDocument/didChange") {
            const td = msg.params?.textDocument;
            if (!td) return;
            listener?.({
              jsonrpc: "2.0",
              method: "textDocument/publishDiagnostics",
              params: {
                uri: td.uri,
                version: td.version,
                diagnostics: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                    severity: 2,
                    message: "heads up",
                  },
                ],
              },
            });
          }
        },
        onMessage(fn) {
          listener = fn;
        },
        kill() {},
      };
    };
    const mgr = new LspManager({ workdir: dir, resolve: () => stubSpec(), spawn });
    managers.push(mgr);
    const res = await mgr.diagnosticsFor(file);
    expect(res.status).toBe("ok");
    expect(res.diagnostics.length).toBe(1);
    expect(res.diagnostics[0]?.severity).toBe("warning");
  });

  test("crash mid-handshake stays byte-identical (fail-open)", async () => {
    const dir = tempDir("lsp-crash-");
    const file = join(dir, "c.ts");
    await writeFile(file, "const c = 1;\n");
    const edit = editTool({ workdir: dir });
    const result = await edit.execute(
      "t",
      { path: file, old_string: "const c = 1;", new_string: "const c = 2;" },
      null,
      null,
    );
    const baseline = structuredClone(result);
    const hook = makeLspDiagnosticsHook(manager(dir, { mode: "crash", timeoutMs: 600 }), {
      workdir: dir,
    });
    const ar = await hook(ctx("edit", { path: file }, result));
    expect(ar).toBeNull();
    expect(result).toEqual(baseline);
  });
});
