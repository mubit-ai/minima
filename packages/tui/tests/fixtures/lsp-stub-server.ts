/**
 * Hermetic LSP stub server (W5.1) — a Bun script speaking REAL Content-Length framed
 * JSON-RPC over stdio, with its OWN byte parser (independent of the client's framer, so
 * both directions exercise real framing). Scripted via env LSP_STUB_MODE:
 *
 *   error  — one error diagnostic on didOpen/didChange
 *   clean  — one empty-diagnostics publish
 *   slow   — never publishes (client must time out)
 *   crash  — process.exit(1) on the initialize request
 *
 * LSP_STUB_PIDFILE (optional): the stub writes its own pid there at startup so a
 * lifecycle test can assert the child is dead after the manager's shutdown().
 */

const mode = process.env.LSP_STUB_MODE ?? "error";
const pidfile = process.env.LSP_STUB_PIDFILE;

if (pidfile) await Bun.write(pidfile, String(process.pid));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function send(msg: unknown): void {
  const body = encoder.encode(JSON.stringify(msg));
  const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
  const frame = new Uint8Array(header.byteLength + body.byteLength);
  frame.set(header, 0);
  frame.set(body, header.byteLength);
  process.stdout.write(frame);
}

function indexOfDoubleCrlf(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.byteLength; i += 1) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

function publish(uri: string, version: unknown, diagnostics: unknown[]): unknown {
  const params: Record<string, unknown> = { uri, diagnostics };
  if (typeof version === "number") params.version = version;
  return { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params };
}

function emit(uri: string, version: unknown): void {
  if (mode === "slow") return;
  if (mode === "clean") {
    send(publish(uri, version, []));
    return;
  }
  send(
    publish(uri, version, [
      {
        range: { start: { line: 11, character: 4 }, end: { line: 11, character: 10 } },
        severity: 1,
        code: "ts2322",
        source: "typescript",
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ]),
  );
}

function handle(msg: {
  id?: number;
  method?: string;
  params?: { textDocument?: { uri?: string; version?: number } };
}): void {
  if (msg.method === "initialize") {
    if (mode === "crash") process.exit(1);
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
    return;
  }
  if (msg.method === "initialized") return;
  if (msg.method === "textDocument/didOpen" || msg.method === "textDocument/didChange") {
    const td = msg.params?.textDocument ?? {};
    if (typeof td.uri === "string") emit(td.uri, td.version);
  }
}

let buf = new Uint8Array(0);
for await (const chunk of Bun.stdin.stream()) {
  const merged = new Uint8Array(buf.byteLength + chunk.byteLength);
  merged.set(buf, 0);
  merged.set(chunk, buf.byteLength);
  buf = merged;
  for (;;) {
    const headerEnd = indexOfDoubleCrlf(buf);
    if (headerEnd < 0) break;
    const header = decoder.decode(buf.subarray(0, headerEnd));
    const m = /content-length:\s*(\d+)/i.exec(header);
    const bodyStart = headerEnd + 4;
    if (!m) {
      buf = buf.subarray(bodyStart);
      continue;
    }
    const len = Number(m[1]);
    if (buf.byteLength < bodyStart + len) break;
    const body = buf.subarray(bodyStart, bodyStart + len);
    buf = buf.subarray(bodyStart + len);
    try {
      handle(JSON.parse(decoder.decode(body)));
    } catch {
      // ignore malformed frames
    }
  }
}
