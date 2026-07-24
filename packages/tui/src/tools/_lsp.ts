/**
 * LSP diagnostics client (W5.1 pathfinder) — RED placeholder.
 *
 * Frozen seam only; bodies are non-functional so the acceptance tests LOAD and red on
 * behavioral assertions (AC1/AC5/AC7 return nothing, AC8 has no config field yet). The
 * GREEN commit fills these in.
 */

import type { AfterToolCall } from "../agent/tools.ts";

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

export function resolveLspServer(_ext: string, override?: LspServerSpec | null): LspServerSpec | null {
  if (override !== undefined) return override;
  return null;
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

export class LspFramer {
  constructor(_onMessage: (msg: any) => void) {}
  push(_chunk: Uint8Array): void {}
}

export class LspManager implements LspClient {
  constructor(_opts: {
    workdir: string;
    resolve?: (ext: string) => LspServerSpec | null;
    spawn?: LspSpawn;
    timeoutMs?: number;
  }) {}

  async diagnosticsFor(absPath: string): Promise<DiagnosticsResult> {
    return { path: absPath, uri: "", status: "no-server", diagnostics: [] };
  }

  shutdown(): void {}
}

export function makeLspDiagnosticsHook(_client: LspClient, _opts: { workdir: string }): AfterToolCall {
  return async () => null;
}
