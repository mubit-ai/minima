/**
 * Read an image from the OS clipboard as bare base64 (no data-URI prefix — matches
 * ImageContent.data in ai/types.ts). Returns null when the clipboard holds no image, the
 * platform tooling is absent, or anything fails: this feeds the input loop, so it must
 * never throw.
 *
 * Platform tooling (all emit / round-trip PNG):
 *   macOS   — pngpaste if installed, else osascript (write clipboard PNG to a temp file)
 *   Linux   — wl-paste (Wayland) or xclip (X11), image/png target
 *   Windows — PowerShell Get-Clipboard -Format Image -> PNG -> base64
 */

import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Reject pathologically large blobs before they bloat model context / base64. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ClipboardImage {
  /** Bare base64 (no `data:` prefix). */
  data: string;
  /** e.g. "image/png". */
  mime: string;
  /** Decoded byte size. */
  bytes: number;
}

/** Runs a command, capturing stdout bytes. Any failure (missing binary, spawn error,
 * non-zero exit) resolves to `{ ok: false }` — callers treat that as "no image here". */
export type Runner = (cmd: string[]) => Promise<{ ok: boolean; stdout: Uint8Array }>;

/** Test seam: inject a platform + runner so the per-OS paths are exercisable off-host. */
export interface ClipboardDeps {
  platform?: NodeJS.Platform;
  run?: Runner;
}

const spawnRun: Runner = async (cmd) => {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    const code = await proc.exited;
    return { ok: code === 0, stdout: buf };
  } catch {
    return { ok: false, stdout: new Uint8Array() };
  }
};

function encode(bytes: Uint8Array, mime: string): ClipboardImage | null {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  return { data: Buffer.from(bytes).toString("base64"), mime, bytes: bytes.length };
}

async function readMac(run: Runner): Promise<ClipboardImage | null> {
  // pngpaste writes the clipboard PNG straight to stdout; no image => non-zero exit.
  const pp = await run(["pngpaste", "-"]);
  if (pp.ok) {
    const img = encode(pp.stdout, "image/png");
    if (img) return img;
  }
  // Fallback: osascript writes the clipboard PNG to a temp file, then we read it back.
  const tmp = join(tmpdir(), "minima-clip.png");
  const script = [
    "try",
    `set outFile to (POSIX file "${tmp}")`,
    "set pngData to (the clipboard as «class PNGf»)",
    "set fh to (open for access outFile with write permission)",
    "set eof fh to 0",
    "write pngData to fh",
    "close access fh",
    'return "ok"',
    "on error",
    'return "none"',
    "end try",
  ];
  const args = ["osascript"];
  for (const line of script) args.push("-e", line);
  const res = await run(args);
  if (!res.ok || new TextDecoder().decode(res.stdout).trim() !== "ok") return null;
  try {
    const bytes = new Uint8Array(await Bun.file(tmp).arrayBuffer());
    return encode(bytes, "image/png");
  } catch {
    return null;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

async function readLinux(run: Runner): Promise<ClipboardImage | null> {
  const wl = await run(["wl-paste", "--type", "image/png"]); // Wayland
  if (wl.ok) {
    const img = encode(wl.stdout, "image/png");
    if (img) return img;
  }
  const xc = await run(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]); // X11
  if (xc.ok) {
    const img = encode(xc.stdout, "image/png");
    if (img) return img;
  }
  return null;
}

async function readWindows(run: Runner): Promise<ClipboardImage | null> {
  const ps =
    "$img=Get-Clipboard -Format Image; if($img){$ms=New-Object System.IO.MemoryStream; " +
    "$img.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); " +
    "[Convert]::ToBase64String($ms.ToArray())}";
  const res = await run(["powershell", "-NoProfile", "-Command", ps]);
  if (!res.ok) return null;
  const b64 = new TextDecoder().decode(res.stdout).trim();
  if (!b64) return null;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  return { data: b64, mime: "image/png", bytes: bytes.length };
}

export async function readClipboardImage(deps: ClipboardDeps = {}): Promise<ClipboardImage | null> {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? spawnRun;
  try {
    switch (platform) {
      case "darwin":
        return await readMac(run);
      case "linux":
        return await readLinux(run);
      case "win32":
        return await readWindows(run);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
