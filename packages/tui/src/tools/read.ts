/**
 * read tool — port of the Python harness's tools/read.py.
 */

import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { readLines, resolveWithin } from "./_io.ts";
import { objectSchema } from "./schema.ts";
import type { FsToolOptions } from "./types.ts";

const parameters = objectSchema(
  {
    path: { type: "string", description: "Absolute or relative file path." },
    offset: { type: "integer", description: "1-based line to start at.", default: 1 },
    limit: { type: "integer", description: "Max lines to return.", default: 2000 },
  },
  ["path"],
);

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"]);
const BINARY_SNIFF_BYTES = 8192;

export function readTool(opts: FsToolOptions = {}): AgentTool {
  return {
    name: "read",
    description:
      "Read a text file. Returns lines with 1-based line numbers. Always read a file before editing it — never guess contents. Use offset/limit for large files (default limit: 2000 lines).",
    parameters,
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      let r = resolveWithin(String(params.path), opts.workdir);
      if (!r.ok && opts.artifacts) {
        // Artifact-root allowance (P1): spill refs live outside every workdir; the jail
        // opens toward exactly one extra root, only when the feature is on.
        const retry = resolveWithin(String(params.path), opts.artifacts.dir);
        if (retry.ok) r = retry;
      }
      if (!r.ok) return errorResult(`read: ${r.error}`);
      const p = r.path;
      let st: Stats;
      try {
        st = await stat(p);
      } catch {
        return errorResult(`read: no such file: ${p}`);
      }
      if (st.isDirectory()) return errorResult(`read: is a directory: ${p}`);
      if (IMAGE_EXTS.has(extname(p).toLowerCase()))
        return errorResult(`read: image file not supported yet: ${p}`);
      const head = await Bun.file(p).slice(0, BINARY_SNIFF_BYTES).bytes();
      if (head.includes(0))
        return errorResult(
          `read: binary file (${st.size} bytes): ${p} — use bash to inspect binary content`,
        );
      const seen = opts.seen;
      const hasher = seen?.enabled ? new Bun.CryptoHasher("sha256") : null;
      const { body, n, eof } = await readLines(p, {
        offset: params.offset as number,
        limit: params.limit as number,
        hasher: hasher ? (chunk) => hasher.update(chunk) : undefined,
      });
      let out = body || "(empty)";
      const details: Record<string, unknown> = { lines_read: n };
      if (seen && hasher && eof) {
        const hash = hasher.digest("hex");
        const off = Math.max(1, Math.floor(params.offset as number) || 1);
        const range = n > 0 ? { start: off, end: off + n - 1 } : { start: 1, end: 1 };
        if (seen.record(p, hash, [range], "read")) {
          out += `\n[snap:${hash.slice(0, 8)}]`;
          details.snap = hash.slice(0, 8);
        }
      }
      return { content: [text(out)], details };
    },
  };
}
