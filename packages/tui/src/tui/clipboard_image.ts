/**
 * Reading an IMAGE off the system clipboard, for the composer's Ctrl+V.
 *
 * Sibling of clipboard.ts (which handles text) and deliberately shaped the same way: a short
 * per-platform command table plus Bun.spawnSync. The one addition is the `run` seam — every
 * spawn goes through it, so the tests drive the whole decision tree without a real clipboard,
 * a real subprocess, or a real image.
 *
 * PNG ON EVERY PLATFORM, always. macOS coerces to «class PNGf», wl-paste/xclip are asked for
 * `image/png` explicitly. One format in means one 4-byte magic check and a fixed-offset IHDR
 * read for the dimensions, instead of a general sniffer — and on macOS it is also the SMALL
 * flavor: the same screenshot advertises 118 KB as PNGf and 3.6 MB as TIFF.
 *
 * LATENCY. Each osascript call costs ~0.25s of wall clock, nearly all of it interpreter
 * startup rather than data (measured: `clipboard info` alone and a 118 KB PNG extraction both
 * take ~0.25s). So macOS pays ~0.25s to answer "is there an image?" and ~0.5s total when there
 * is one. That is a blocking spawnSync in the Ink render loop, which is acceptable ONLY because
 * this runs on an explicit keypress with nothing animating. Do not move this onto a timer.
 *
 * osascript also writes unrelated diagnostics to STDERR (e.g. "*** Error creating a JP2 color
 * space: falling back to sRGB" on a pasteboard carrying a jp2 flavor). Read stdout only.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_IMAGE_BYTES } from "../tools/read.ts";

/**
 * Long-edge ceiling in pixels. Anthropic's own recommended maximum, and every provider
 * downsamples above roughly this size server-side anyway — so a bigger image buys no accuracy
 * and costs real tokens. Resizing to it is what makes a full-screen Retina screenshot paste
 * at all rather than bouncing off MAX_IMAGE_BYTES.
 */
export const MAX_IMAGE_EDGE = 1568;

/**
 * Refuse before materializing. On macOS the PNG flavor's size is known from `clipboard info`
 * BEFORE extraction, and extraction is hex — 2 bytes of string per byte of image — so a
 * pathological pasteboard would otherwise become a 50 MB string on the way to being rejected.
 */
export const CLIPBOARD_READ_CAP = 25_000_000;

export interface ClipboardImage {
  /** base64, ready for an ImageContent block. */
  data: string;
  mime: "image/png";
  /** Decoded size, AFTER any downscale — what the wire actually carries. */
  bytes: number;
  width: number;
  height: number;
  /** True when the bytes were re-encoded to fit MAX_IMAGE_EDGE (surfaced in the paste note). */
  resized: boolean;
}

export type ClipboardRead =
  /** An image is attached. */
  | { kind: "image"; image: ClipboardImage }
  /** No image flavor on the clipboard — the caller falls back to the text paste. */
  | { kind: "none" }
  /** There WAS an image and we could not take it; `message` is shown to the user verbatim. */
  | { kind: "error"; message: string };

export interface RunResult {
  exitCode: number;
  stdout: Uint8Array;
}

/** Runs one argv. Returns null when the command does not exist (try the next candidate). */
export type Runner = (cmd: string[], stdin?: Uint8Array) => RunResult | null;

const defaultRun: Runner = (cmd, stdin) => {
  try {
    const r = Bun.spawnSync(cmd, {
      stdin: stdin ? Buffer.from(stdin) : undefined,
      // stderr is noise on this path (see the header) and must never reach the TUI.
      stderr: "ignore",
    });
    return { exitCode: r.exitCode, stdout: new Uint8Array(r.stdout) };
  } catch {
    return null; // ENOENT — command not installed
  }
};

// -- pure helpers ------------------------------------------------------------------------------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** True when `b` starts with the PNG signature. Everything downstream assumes PNG. */
export function isPng(b: Uint8Array): boolean {
  return b.length >= 4 && PNG_MAGIC.every((byte, i) => b[i] === byte);
}

/**
 * macOS `osascript -e 'clipboard info'` → the flavors we care about. The real output is a flat
 * comma-separated list of `<flavor>, <bytes>` pairs:
 *
 *   «class PNGf», 118502, «class AVIF», 13599, GIF picture, 41913, TIFF picture, 3633934, …
 *
 * `png` is the PNGf size when advertised (used for the pre-extraction cap). `hasImage` is
 * broader on purpose: the pasteboard coerces TIFF/GIF/etc. to PNG on request, so an image-ish
 * flavor with no explicit PNGf entry is still worth asking for.
 */
export function parseClipboardInfo(s: string): { png?: number; hasImage: boolean } {
  const png = /«class PNGf», (\d+)/.exec(s);
  const hasImage =
    png !== null || /«class (AVIF|8BPS|BMP |TPIC|jp2 )»|(TIFF|GIF|JPEG|PICT) picture/.test(s);
  return { png: png ? Number(png[1]) : undefined, hasImage };
}

/** Linux `wl-paste --list-types` / `xclip -t TARGETS -o` → does it offer PNG. */
export function hasImageFlavor(list: string): boolean {
  return /^image\/png$/m.test(list.trim());
}

/**
 * AppleScript renders raw data as `«data PNGf<HEX>»`. The four chars after `data ` are the
 * type code, not payload — dropping them is what makes the result start with the PNG magic.
 * Returns null on any other shape (including an AppleScript error message on stdout).
 */
export function decodeAppleHexData(s: string): Uint8Array | null {
  const m = /«data \w{4}([0-9A-Fa-f]*)»/.exec(s);
  if (!m || !m[1] || m[1].length % 2 !== 0) return null;
  return new Uint8Array(Buffer.from(m[1], "hex"));
}

/**
 * Width/height from a PNG's IHDR, which is at a fixed offset by spec: 8-byte signature, 4-byte
 * length, 4-byte "IHDR", then two big-endian uint32s. Null when the bytes are not a PNG or are
 * truncated before byte 24.
 */
export function pngDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (!isPng(b) || b.length < 24) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The entire sizing policy, as one pure function.
 *
 * `"resize"` also covers the small-but-heavy case (dimensions already under the edge cap, bytes
 * over the wire limit): re-encoding usually still helps, and if it does not the caller reports
 * the honest failure afterwards. Unknown dimensions (`null`) are treated as within the cap —
 * the byte check is the one that matters, and refusing on an unreadable header would be
 * refusing something we never actually tried.
 */
export function downscalePlan(
  bytes: number,
  dims: { width: number; height: number } | null,
): "none" | "resize" | "too-large" {
  if (bytes > CLIPBOARD_READ_CAP) return "too-large";
  if (dims && Math.max(dims.width, dims.height) > MAX_IMAGE_EDGE) return "resize";
  if (bytes > MAX_IMAGE_BYTES) return "resize";
  return "none";
}

/** The user-facing refusal, kept in one place so the tests and the TUI agree on the wording. */
export function tooLargeMessage(bytes: number): string {
  return `paste: image too large (${bytes} bytes; limit ${MAX_IMAGE_BYTES}) — downscale it and copy again`;
}

// -- resizing ----------------------------------------------------------------------------------

/**
 * Shrink to MAX_IMAGE_EDGE on the long side, returning null when no resizer is available (the
 * caller then attaches the original if it fits, or refuses).
 *
 * macOS `sips` is a base-system binary, so it is always there — but it only works on FILES,
 * hence the temp round-trip. ImageMagick pipes stdin→stdout and needs no temp file; the `>`
 * suffix on the geometry means "only shrink", so an already-small image is never blown up.
 */
export function resizePng(
  bytes: Uint8Array,
  run: Runner = defaultRun,
  platform: string = process.platform,
): Uint8Array | null {
  if (platform === "darwin") {
    const base = join(tmpdir(), `minima-clip-${process.pid}-${bytes.length}`);
    const src = `${base}.png`;
    const dst = `${base}-small.png`;
    try {
      writeFileSync(src, bytes);
      const r = run(["sips", "-Z", String(MAX_IMAGE_EDGE), src, "--out", dst]);
      if (r === null || r.exitCode !== 0) return null;
      return new Uint8Array(readFileSync(dst));
    } catch {
      return null;
    } finally {
      for (const p of [src, dst]) {
        try {
          unlinkSync(p);
        } catch {
          // never existed, or already gone — nothing to clean up
        }
      }
    }
  }
  for (const bin of ["magick", "convert"]) {
    const r = run(
      [bin, "png:-", "-resize", `${MAX_IMAGE_EDGE}x${MAX_IMAGE_EDGE}>`, "png:-"],
      bytes,
    );
    if (r !== null && r.exitCode === 0 && isPng(r.stdout)) return r.stdout;
  }
  return null;
}

// -- per-platform extraction -------------------------------------------------------------------

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

/** macOS: one `clipboard info` probe (also gives the size), then the PNG coercion. */
export function readDarwin(run: Runner): ClipboardRead {
  const probe = run(["osascript", "-e", "clipboard info"]);
  if (probe === null || probe.exitCode !== 0) return { kind: "none" };
  const info = parseClipboardInfo(decode(probe.stdout));
  if (!info.hasImage) return { kind: "none" };
  if (info.png !== undefined && info.png > CLIPBOARD_READ_CAP)
    return { kind: "error", message: tooLargeMessage(info.png) };

  const got = run(["osascript", "-e", "get the clipboard as «class PNGf»"]);
  if (got === null || got.exitCode !== 0)
    return { kind: "error", message: "paste: the clipboard image could not be read" };
  const bytes = decodeAppleHexData(decode(got.stdout));
  if (bytes === null || !isPng(bytes))
    return { kind: "error", message: "paste: the clipboard image could not be decoded" };
  return finish(bytes, run, "darwin");
}

/** Linux: Wayland first (wl-paste), then X11 (xclip). A missing binary is not an error. */
export function readLinux(run: Runner): ClipboardRead {
  const sources: { list: string[]; get: string[] }[] = [
    { list: ["wl-paste", "--list-types"], get: ["wl-paste", "--type", "image/png"] },
    {
      list: ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
      get: ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
    },
  ];
  for (const src of sources) {
    const listed = run(src.list);
    if (listed === null || listed.exitCode !== 0) continue; // not installed / not this display server
    if (!hasImageFlavor(decode(listed.stdout))) return { kind: "none" };
    const got = run(src.get);
    if (got === null || got.exitCode !== 0 || !isPng(got.stdout))
      return { kind: "error", message: "paste: the clipboard image could not be read" };
    return finish(got.stdout, run, "linux");
  }
  return { kind: "none" };
}

/** Shared tail: size policy, optional resize, then the ImageContent-ready payload. */
function finish(bytes: Uint8Array, run: Runner, platform: string): ClipboardRead {
  const plan = downscalePlan(bytes.length, pngDimensions(bytes));
  if (plan === "too-large") return { kind: "error", message: tooLargeMessage(bytes.length) };

  let out = bytes;
  let resized = false;
  if (plan === "resize") {
    const smaller = resizePng(bytes, run, platform);
    // A failed resize is only fatal if the ORIGINAL would not fit anyway — an oversized-but-
    // legal image on a box with no resizer should still paste, just at full cost.
    if (smaller !== null && isPng(smaller)) {
      out = smaller;
      resized = true;
    }
  }
  if (out.length > MAX_IMAGE_BYTES) return { kind: "error", message: tooLargeMessage(out.length) };

  const dims = pngDimensions(out) ?? { width: 0, height: 0 };
  return {
    kind: "image",
    image: {
      data: Buffer.from(out).toString("base64"),
      mime: "image/png",
      bytes: out.length,
      width: dims.width,
      height: dims.height,
      resized,
    },
  };
}

/**
 * Read an image off the clipboard. `{kind:"none"}` means "not an image" — the caller pastes
 * text instead, so a plain Ctrl+V is unchanged.
 */
export function readClipboardImage(
  run: Runner = defaultRun,
  platform: string = process.platform,
): ClipboardRead {
  return platform === "darwin" ? readDarwin(run) : readLinux(run);
}
