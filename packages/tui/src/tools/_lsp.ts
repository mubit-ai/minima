/**
 * LSP diagnostics client (W5.1 pathfinder) — a hand-rolled, zero-dep stdio JSON-RPC
 * client that spawns a locally-installed language server, drives the
 * initialize/initialized handshake + didOpen/didChange (full-sync) document sync, and
 * correlates the server-PUSHED `publishDiagnostics` for the just-edited file within a
 * hard timeout. `makeLspDiagnosticsHook` surfaces those diagnostics ADDITIVELY in the
 * tool result of edit/write/apply_patch via one `afterToolCall` hook.
 *
 * Never-block: every collection is `Promise.race`d against a hard timeout, so the hook —
 * which rides the tool-result critical path — can only ever ADD latency up to the budget.
 * Fail-open: any failure axis (flag off / no server / crash / timeout / clean file /
 * tool-failed / hook-throw) makes the hook return null → the result is byte-identical.
 * Discovery mirrors resolveRg's override tri-state exactly.
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { AfterToolCall, AfterToolCallContext } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { killProcessGroup } from "../minima/check.ts";
import { resolveWithin } from "./_io.ts";

// Never-block budget: diagnosticsFor races collection against this hard ceiling.
const DIAGNOSTICS_TIMEOUT_MS = 1500;
// Settle window for a clear-then-publish server: an empty publish waits this long for a
// follow-up non-empty publish before settling clean (a later publish resolves early).
const DIDCHANGE_DEBOUNCE_MS = 200;

const TIMEOUT: unique symbol = Symbol("lsp-timeout");

// ---------------------------------------------------------------- frozen public seam

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";
export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  line: number;
  character: number;
  source?: string;
  code?: string | number;
}
export type DiagnosticsStatus = "ok" | "no-server" | "timeout" | "unsupported" | "error";
export interface DiagnosticsResult {
  path: string;
  uri: string;
  status: DiagnosticsStatus;
  diagnostics: Diagnostic[];
}

export interface LspServerSpec {
  id: "tsserver" | "pyright" | "gopls";
  bin: string;
  args: string[];
  extensions: ReadonlySet<string>;
}

export interface LspClient {
  diagnosticsFor(absPath: string, opts?: { timeoutMs?: number }): Promise<DiagnosticsResult>;
  shutdown(): void;
}

export interface SpawnedConnection {
  send(msg: object): void;
  onMessage(fn: (msg: any) => void): void;
  kill(): void;
  readonly alive: boolean;
}
export type LspSpawn = (spec: LspServerSpec, cwd: string) => SpawnedConnection;

// ------------------------------------------------------------------------ discovery

interface ServerDef {
  id: LspServerSpec["id"];
  command: string;
  args: string[];
  extensions: ReadonlySet<string>;
}

const SERVER_DEFS: readonly ServerDef[] = [
  {
    id: "tsserver",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]),
  },
  {
    id: "pyright",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: new Set([".py", ".pyi"]),
  },
  { id: "gopls", command: "gopls", args: [], extensions: new Set([".go"]) },
];

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
};

const whichCache = new Map<string, string | null>();

function whichCached(command: string): string | null {
  const hit = whichCache.get(command);
  if (hit !== undefined) return hit;
  const resolved = Bun.which(command);
  whichCache.set(command, resolved);
  return resolved;
}

/** Discovery mirrors resolveRg's override contract EXACTLY: undefined → cached probe;
 * null → force no-server; a spec → force (the hermetic test seam). */
export function resolveLspServer(
  ext: string,
  override?: LspServerSpec | null,
): LspServerSpec | null {
  if (override !== undefined) return override;
  const def = SERVER_DEFS.find((d) => d.extensions.has(ext));
  if (!def) return null;
  const bin = whichCached(def.command);
  if (!bin) return null;
  return { id: def.id, bin, args: def.args, extensions: def.extensions };
}

// ---------------------------------------------------------------- JSON-RPC framing

const ENCODER = new TextEncoder();

function encodeMessage(msg: object): Uint8Array {
  const body = ENCODER.encode(JSON.stringify(msg));
  const header = ENCODER.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
  const out = new Uint8Array(header.byteLength + body.byteLength);
  out.set(header, 0);
  out.set(body, header.byteLength);
  return out;
}

function indexOfDoubleCrlf(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.byteLength; i += 1) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

/** Incremental Content-Length parser over a byte stream: accumulates chunks, scans for the
 * header terminator, waits for the exact body byte count, then emits and loops on the
 * remainder — handles split headers/bodies AND multiple messages per chunk. */
export class LspFramer {
  private buf = new Uint8Array(0);
  private readonly decoder = new TextDecoder();

  constructor(private readonly onMessage: (msg: any) => void) {}

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    const merged = new Uint8Array(this.buf.byteLength + chunk.byteLength);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.byteLength);
    this.buf = merged;
    this.drain();
  }

  private drain(): void {
    for (;;) {
      const headerEnd = indexOfDoubleCrlf(this.buf);
      if (headerEnd < 0) return;
      const header = this.decoder.decode(this.buf.subarray(0, headerEnd));
      const bodyStart = headerEnd + 4;
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buf = this.buf.subarray(bodyStart);
        continue;
      }
      const len = Number(match[1]);
      if (this.buf.byteLength < bodyStart + len) return;
      const body = this.buf.subarray(bodyStart, bodyStart + len);
      this.buf = this.buf.subarray(bodyStart + len);
      let msg: unknown;
      try {
        msg = JSON.parse(this.decoder.decode(body));
      } catch {
        continue;
      }
      this.onMessage(msg);
    }
  }
}

// -------------------------------------------------------------------- default spawn

function defaultSpawn(spec: LspServerSpec, cwd: string): SpawnedConnection {
  const proc = Bun.spawn([spec.bin, ...spec.args], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const listeners: ((msg: any) => void)[] = [];
  const framer = new LspFramer((msg) => {
    for (const fn of listeners) fn(msg);
  });
  let live = true;
  const markDead = (): void => {
    live = false;
  };
  void (async () => {
    const reader = proc.stdout.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) framer.push(value);
      }
    } catch {
      // stdout broke — treat the connection as dead
    } finally {
      markDead();
    }
  })();
  proc.exited.then(markDead).catch(markDead);
  return {
    get alive() {
      return live;
    },
    send(msg: object) {
      try {
        proc.stdin.write(encodeMessage(msg));
        proc.stdin.flush();
      } catch {
        markDead();
      }
    },
    onMessage(fn) {
      listeners.push(fn);
    },
    kill() {
      markDead();
      try {
        killProcessGroup(proc);
      } catch {
        // already gone
      }
    },
  };
}

// ------------------------------------------------------------------- message helpers

function didOpenMessage(uri: string, languageId: string, version: number, content: string): object {
  return {
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri, languageId, version, text: content } },
  };
}

function didChangeMessage(uri: string, version: number, content: string): object {
  return {
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: { textDocument: { uri, version }, contentChanges: [{ text: content }] },
  };
}

const SEVERITY: Record<number, DiagnosticSeverity> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
};

function toDiagnostic(d: any): Diagnostic {
  const start = d?.range?.start ?? {};
  const out: Diagnostic = {
    severity: SEVERITY[d?.severity as number] ?? "error",
    message: String(d?.message ?? ""),
    line: Number(start.line ?? 0),
    character: Number(start.character ?? 0),
  };
  if (d?.source != null) out.source = String(d.source);
  if (d?.code != null) out.code = typeof d.code === "number" ? d.code : String(d.code);
  return out;
}

function languageIdForExt(ext: string): string {
  return LANGUAGE_IDS[ext] ?? "plaintext";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

// ------------------------------------------------------------------------- manager

interface DiagWaiter {
  version: number;
  emptyTimer: ReturnType<typeof setTimeout> | null;
  settle: (d: Diagnostic[] | null) => void;
}

interface ServerConn {
  spec: LspServerSpec;
  conn: SpawnedConnection;
  nextId: number;
  pending: Map<number, (result: unknown) => void>;
  waiters: Map<string, DiagWaiter>;
  opened: Set<string>;
  versions: Map<string, number>;
  initialized: Promise<void> | null;
  dead: boolean;
}

export class LspManager implements LspClient {
  private readonly workdir: string;
  private readonly resolveFn: (ext: string) => LspServerSpec | null;
  private readonly spawnFn: LspSpawn;
  private readonly timeoutMs: number;
  private readonly servers = new Map<string, ServerConn>();

  constructor(opts: {
    workdir: string;
    resolve?: (ext: string) => LspServerSpec | null;
    spawn?: LspSpawn;
    timeoutMs?: number;
  }) {
    this.workdir = opts.workdir;
    this.resolveFn = opts.resolve ?? ((ext) => resolveLspServer(ext));
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.timeoutMs = opts.timeoutMs ?? DIAGNOSTICS_TIMEOUT_MS;
  }

  async diagnosticsFor(absPath: string, opts?: { timeoutMs?: number }): Promise<DiagnosticsResult> {
    const uri = pathToFileURL(absPath).href;
    const base: DiagnosticsResult = { path: absPath, uri, status: "ok", diagnostics: [] };
    const spec = this.resolveFn(extname(absPath).toLowerCase());
    if (!spec) return { ...base, status: "no-server" };
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([this.collect(spec, absPath, uri), timeout]);
      if (outcome === TIMEOUT) return { ...base, status: "timeout" };
      return outcome;
    } catch {
      return { ...base, status: "error" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  shutdown(): void {
    for (const sc of this.servers.values()) {
      sc.dead = true;
      for (const w of sc.waiters.values()) w.settle(null);
      sc.waiters.clear();
      try {
        sc.conn.kill();
      } catch {
        // already gone
      }
    }
    this.servers.clear();
  }

  private async collect(
    spec: LspServerSpec,
    absPath: string,
    uri: string,
  ): Promise<DiagnosticsResult> {
    const sc = await this.getServer(spec);
    if (!sc) return { path: absPath, uri, status: "error", diagnostics: [] };
    let content: string;
    try {
      content = await readFile(absPath, "utf8");
    } catch {
      return { path: absPath, uri, status: "error", diagnostics: [] };
    }
    const version = (sc.versions.get(uri) ?? 0) + 1;
    sc.versions.set(uri, version);
    const languageId = languageIdForExt(extname(absPath).toLowerCase());
    const diagnostics = await this.awaitDiagnostics(sc, uri, version, () => {
      if (sc.opened.has(uri)) {
        sc.conn.send(didChangeMessage(uri, version, content));
      } else {
        sc.opened.add(uri);
        sc.conn.send(didOpenMessage(uri, languageId, version, content));
      }
    });
    return { path: absPath, uri, status: "ok", diagnostics };
  }

  private awaitDiagnostics(
    sc: ServerConn,
    uri: string,
    version: number,
    dispatch: () => void,
  ): Promise<Diagnostic[]> {
    // Debounce: a newer change supersedes any in-flight waiter for this uri, so the manager
    // only ever awaits the latest version — a burst never multiplies latency.
    const prev = sc.waiters.get(uri);
    if (prev) prev.settle(null);
    return new Promise<Diagnostic[]>((resolve) => {
      let settled = false;
      const waiter: DiagWaiter = {
        version,
        emptyTimer: null,
        settle: (d) => {
          if (settled) return;
          settled = true;
          if (waiter.emptyTimer) clearTimeout(waiter.emptyTimer);
          if (sc.waiters.get(uri) === waiter) sc.waiters.delete(uri);
          resolve(d ?? []);
        },
      };
      sc.waiters.set(uri, waiter);
      dispatch();
    });
  }

  private async getServer(spec: LspServerSpec): Promise<ServerConn | null> {
    let sc = this.servers.get(spec.id);
    if (sc && (sc.dead || !sc.conn.alive)) {
      this.servers.delete(spec.id);
      sc = undefined;
    }
    if (!sc) {
      let conn: SpawnedConnection;
      try {
        conn = this.spawnFn(spec, this.workdir);
      } catch {
        return null;
      }
      const created: ServerConn = {
        spec,
        conn,
        nextId: 1,
        pending: new Map(),
        waiters: new Map(),
        opened: new Set(),
        versions: new Map(),
        initialized: null,
        dead: false,
      };
      conn.onMessage((msg) => this.route(created, msg));
      created.initialized = this.handshake(created).catch(() => {
        created.dead = true;
      });
      this.servers.set(spec.id, created);
      sc = created;
    }
    await sc.initialized;
    return sc.dead ? null : sc;
  }

  private async handshake(sc: ServerConn): Promise<void> {
    const id = sc.nextId++;
    const responded = new Promise<void>((resolve) => {
      sc.pending.set(id, () => resolve());
    });
    sc.conn.send({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        processId: typeof process.pid === "number" ? process.pid : null,
        rootUri: pathToFileURL(this.workdir).href,
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            publishDiagnostics: { relatedInformation: false },
          },
        },
      },
    });
    const outcome = await Promise.race([
      responded.then(() => "ok" as const),
      delay(this.timeoutMs).then(() => "timeout" as const),
    ]);
    if (outcome !== "ok") throw new Error("lsp initialize timed out");
    sc.conn.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  }

  private route(sc: ServerConn, msg: any): void {
    if (msg == null || typeof msg !== "object") return;
    // Responses (have an id) resolve the id-correlator — only `initialize` uses it here, but
    // it is the half every future request/response op reuses.
    if (
      typeof msg.id === "number" &&
      (Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error"))
    ) {
      const cb = sc.pending.get(msg.id);
      if (cb) {
        sc.pending.delete(msg.id);
        cb(msg.result);
      }
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params ?? {};
      const waiter = sc.waiters.get(params.uri);
      if (!waiter) return;
      if (typeof params.version === "number" && params.version !== waiter.version) return;
      const raw = Array.isArray(params.diagnostics) ? params.diagnostics : [];
      const diagnostics = raw.map(toDiagnostic);
      if (diagnostics.length > 0) {
        waiter.settle(diagnostics);
        return;
      }
      if (!waiter.emptyTimer) {
        waiter.emptyTimer = setTimeout(() => waiter.settle([]), DIDCHANGE_DEBOUNCE_MS);
        waiter.emptyTimer.unref?.();
      }
    }
    // Server→client requests we do not implement are ignored (no reply): the pathfinder only
    // needs the notification correlator, and tsserver/pyright/gopls publish without one.
  }
}

// ---------------------------------------------------------------------------- hook

function touchedPaths(ctx: AfterToolCallContext, workdir: string): string[] {
  const raw: string[] = [];
  const name = ctx.toolCall.name;
  if (name === "edit" || name === "write") {
    const p = ctx.toolCall.arguments.path;
    if (typeof p === "string" && p) raw.push(p);
  } else if (name === "apply_patch") {
    const writes = ctx.result.details?.writes;
    if (Array.isArray(writes)) for (const w of writes) if (typeof w === "string" && w) raw.push(w);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    const r = resolveWithin(p, workdir);
    if (!r.ok || seen.has(r.path)) continue;
    seen.add(r.path);
    out.push(r.path);
  }
  return out;
}

/** One shared budget over the combined collection: the per-file probes run concurrently
 * (each internally raced against the manager's timeout), and a single outer race caps the
 * batch, so apply_patch's N files never multiply latency. A timed-out batch drops → the
 * hook contributes nothing (byte-identical). */
async function collectShared(client: LspClient, paths: string[]): Promise<DiagnosticsResult[]> {
  const collection = Promise.all(paths.map((p) => client.diagnosticsFor(p)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DIAGNOSTICS_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return (await Promise.race([collection, budget])) ?? [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function renderDiagnostics(results: DiagnosticsResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`[lsp] ${basename(r.path)}: ${r.diagnostics.length} diagnostic(s)`);
    for (const d of r.diagnostics.slice(0, 20)) {
      const code = d.code != null ? ` (${d.code})` : "";
      lines.push(`  ${d.severity} ${d.line + 1}:${d.character + 1} ${d.message}${code}`);
    }
    if (r.diagnostics.length > 20) lines.push(`  …and ${r.diagnostics.length - 20} more`);
  }
  return lines.join("\n");
}

/** ADDITIVE afterToolCall: reads touched paths from edit/write `arguments.path` and
 * apply_patch `details.writes`, collects diagnostics under a shared budget, and appends
 * one compact block. Fail-open on every axis — guarded like _artifact_gc's touch hook. */
export function makeLspDiagnosticsHook(
  client: LspClient,
  opts: { workdir: string },
): AfterToolCall {
  return async (ctx) => {
    if (ctx.isError || ctx.result.details?.error) return null;
    const paths = touchedPaths(ctx, opts.workdir);
    if (paths.length === 0) return null;
    let results: DiagnosticsResult[];
    try {
      results = await collectShared(client, paths);
    } catch {
      return null;
    }
    const withDiags = results.filter((r) => r.status === "ok" && r.diagnostics.length > 0);
    if (withDiags.length === 0) return null;
    const lsp = results.length === 1 ? results[0] : results;
    return {
      details: { lsp },
      content: [...ctx.result.content, text(renderDiagnostics(withDiags))],
    };
  };
}
