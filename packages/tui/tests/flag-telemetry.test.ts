import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentState } from "../src/agent/state.ts";
import type { AfterToolCallContext, ToolResult } from "../src/agent/tools.ts";
import type { ToolCall } from "../src/ai/types.ts";
import {
  type DiagnosticsResult,
  type LspClient,
  type LspProbeRecord,
  makeLspDiagnosticsHook,
} from "../src/tools/_lsp.ts";

// TTSR and LSP are both opt-in "until field-validated", and until now neither wrote a row
// anyone could query: TTSR counted retries in memory, and LSP diagnostics rode the tool
// result, where tool_calls.result keeps only the first text block. A week of real use would
// have produced a feeling rather than a verdict. `events.payload` is free-form JSON, so
// both records land with NO migration.

function ctx(path: string, result: ToolResult): AfterToolCallContext {
  const tc: ToolCall = { type: "toolCall", id: "t", name: "edit", arguments: { path } };
  return { toolCall: tc, result, isError: false, context: new AgentState() };
}

function fakeClient(results: Record<string, DiagnosticsResult>): LspClient {
  return {
    diagnosticsFor: async (p: string) => results[p] as DiagnosticsResult,
    shutdown: () => {},
  };
}

async function fixture(): Promise<{ dir: string; file: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "lsp-telemetry-"));
  const file = join(dir, "a.ts");
  await writeFile(file, "export const x = 1;\n");
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("LSP probe telemetry", () => {
  test("records a probe even when the collection found nothing to append", async () => {
    const { dir, file, cleanup } = await fixture();
    const probes: LspProbeRecord[] = [];
    const client = fakeClient({
      [file]: { path: file, uri: `file://${file}`, status: "ok", diagnostics: [] },
    });
    const hook = makeLspDiagnosticsHook(client, { workdir: dir, onProbe: (p) => probes.push(p) });
    try {
      const out = await hook(ctx(file, { content: [] }));
      // A clean file appends nothing — but the probe still happened, and a promotion bar
      // built only on turns that produced output would silently exclude every clean edit.
      expect(out).toBeNull();
      expect(probes).toHaveLength(1);
      expect(probes[0]?.status).toBe("ok");
      expect(probes[0]?.diagnostics).toBe(0);
      expect(probes[0]?.ext).toBe(".ts");
      expect(typeof probes[0]?.latency_ms).toBe("number");
    } finally {
      cleanup();
    }
  });

  test("records the failure statuses the bar is argued from", async () => {
    for (const status of ["timeout", "error", "no-server"] as const) {
      const { dir, file, cleanup } = await fixture();
      const probes: LspProbeRecord[] = [];
      const client = fakeClient({
        [file]: { path: file, uri: `file://${file}`, status, diagnostics: [] },
      });
      const hook = makeLspDiagnosticsHook(client, {
        workdir: dir,
        onProbe: (p) => probes.push(p),
      });
      try {
        await hook(ctx(file, { content: [] }));
        expect(probes.map((p) => p.status)).toEqual([status]);
      } finally {
        cleanup();
      }
    }
  });

  test("a throwing sink never reaches the tool result", async () => {
    const { dir, file, cleanup } = await fixture();
    const client = fakeClient({
      [file]: {
        path: file,
        uri: `file://${file}`,
        status: "ok",
        diagnostics: [{ severity: "error", message: "boom", line: 0, character: 0 }],
      },
    });
    const hook = makeLspDiagnosticsHook(client, {
      workdir: dir,
      onProbe: () => {
        throw new Error("ledger is down");
      },
    });
    try {
      const out = await hook(ctx(file, { content: [] }));
      // Telemetry is bookkeeping: it must never cost the turn its diagnostics.
      expect(out).not.toBeNull();
      expect(out?.details?.lsp).toBeDefined();
    } finally {
      cleanup();
    }
  });

  test("no sink means no work — the hook is unchanged when telemetry is absent", async () => {
    const { dir, file, cleanup } = await fixture();
    const client = fakeClient({
      [file]: { path: file, uri: `file://${file}`, status: "ok", diagnostics: [] },
    });
    const hook = makeLspDiagnosticsHook(client, { workdir: dir });
    try {
      expect(await hook(ctx(file, { content: [] }))).toBeNull();
    } finally {
      cleanup();
    }
  });
});
