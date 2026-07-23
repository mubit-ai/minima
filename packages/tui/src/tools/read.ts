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
      const r = resolveWithin(String(params.path), opts.workdir);
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
        return errorResult(`read: image file not supported: ${p}`);
      const head = await Bun.file(p).slice(0, BINARY_SNIFF_BYTES).bytes();
      // UTF-16 text has a NUL in every other byte — without the BOM check the sniff
      // would misreport a readable text file as binary.
      if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))
        return errorResult(
          `read: UTF-16 encoded file not supported: ${p} — convert with iconv or read via bash`,
        );
      if (head.includes(0))
        return errorResult(
          `read: binary file (${st.size} bytes): ${p} — use bash to inspect binary content`,
        );
      const { body, n } = await readLines(p, {
        offset: params.offset as number,
        limit: params.limit as number,
      });
      return { content: [text(body || "(empty)")], details: { lines_read: n } };
    },
  };
}
