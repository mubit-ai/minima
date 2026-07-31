/**
 * read tool — port of the Python harness's tools/read.py.
 */

import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { image, text } from "../ai/types.ts";
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

/**
 * 3.75 MB raw = exactly 5 MB base64 on the wire, the tightest per-image ceiling any target
 * imposes (Anthropic allows 10 MB direct but 5 MB through Bedrock/Vertex, and `base_url`
 * can point at either). Gemini's 20 MB is a whole-REQUEST limit, so this leaves room for
 * the transcript. Checked against stat() so an oversized file is never read into memory.
 */
export const MAX_IMAGE_BYTES = 3_750_000;

type ImageKind = "png" | "jpeg" | "webp" | "gif" | "bmp" | "ico";

// png/jpeg/webp is the three-way intersection of what Anthropic, OpenAI and Gemini accept
// — Gemini takes no GIF. The others are sniffed only so they earn a specific message
// instead of falling into the generic binary-file guard below.
const SENDABLE_MIME: Partial<Record<ImageKind, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Image kind from magic bytes, never from the extension: Anthropic validates the declared
 * media_type against the actual bytes, so a .png holding JPEG data would 400. */
function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "webp";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
    return "gif";
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "ico";
  return null;
}

async function readImage(p: string, size: number, opts: FsToolOptions): Promise<ToolResult> {
  // One branch, two reasons: MINIMA_TUI_IMAGES=0 and "this model has no vision" both land
  // here, and both get the pre-feature message byte for byte.
  if (!opts.imageResults?.()) return errorResult(`read: image file not supported: ${p}`);
  if (size > MAX_IMAGE_BYTES)
    return errorResult(
      `read: image too large (${size} bytes; limit ${MAX_IMAGE_BYTES}): ${p} — downscale it or inspect with bash`,
    );
  const bytes = await Bun.file(p).bytes();
  const kind = sniffImage(bytes);
  if (!kind) return errorResult(`read: not a valid image: ${p}`);
  const mime = SENDABLE_MIME[kind];
  if (!mime)
    return errorResult(
      `read: image format not supported (${kind}): ${p} — convert to png, jpeg or webp`,
    );
  // Text block FIRST: db/sink, the transcript projection and compaction all read
  // textContent only, so without it every one of them would see an empty result.
  return {
    content: [
      text(`[image] ${p} (${mime}, ${size} bytes)`),
      image(Buffer.from(bytes).toString("base64"), mime),
    ],
    details: { image: true, mime, bytes: size },
  };
}

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
      // Before the binary sniff, not after: every image format has NUL bytes and would
      // otherwise die there rather than reaching the image path.
      if (IMAGE_EXTS.has(extname(p).toLowerCase())) return readImage(p, st.size, opts);
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
