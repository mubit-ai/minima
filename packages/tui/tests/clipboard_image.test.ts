import { describe, expect, test } from "bun:test";
import { type Runner, readClipboardImage } from "../src/tui/clipboard_image.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_B64 = Buffer.from(PNG).toString("base64");

/** A runner that answers with `bytes` only for the command whose argv[0] is `bin`. */
function runnerFor(bin: string, bytes: Uint8Array): Runner {
  return async (cmd) =>
    cmd[0] === bin ? { ok: true, stdout: bytes } : { ok: false, stdout: new Uint8Array() };
}

describe("readClipboardImage", () => {
  test("macOS: pngpaste stdout → base64", async () => {
    const img = await readClipboardImage({ platform: "darwin", run: runnerFor("pngpaste", PNG) });
    expect(img).not.toBeNull();
    expect(img?.data).toBe(PNG_B64);
    expect(img?.mime).toBe("image/png");
    expect(img?.bytes).toBe(PNG.length);
  });

  test("macOS: no pngpaste image and osascript reports none → null (no throw)", async () => {
    const run: Runner = async (cmd) =>
      cmd[0] === "osascript"
        ? { ok: true, stdout: new TextEncoder().encode("none\n") }
        : { ok: false, stdout: new Uint8Array() };
    const img = await readClipboardImage({ platform: "darwin", run });
    expect(img).toBeNull();
  });

  test("Linux: wl-paste (Wayland) stdout → base64", async () => {
    const img = await readClipboardImage({ platform: "linux", run: runnerFor("wl-paste", PNG) });
    expect(img?.data).toBe(PNG_B64);
  });

  test("Linux: falls back to xclip (X11) when wl-paste is absent", async () => {
    const img = await readClipboardImage({ platform: "linux", run: runnerFor("xclip", PNG) });
    expect(img?.data).toBe(PNG_B64);
  });

  test("Linux: no clipboard tooling → null", async () => {
    const run: Runner = async () => ({ ok: false, stdout: new Uint8Array() });
    expect(await readClipboardImage({ platform: "linux", run })).toBeNull();
  });

  test("Windows: PowerShell emits base64 text", async () => {
    const run: Runner = async () => ({ ok: true, stdout: new TextEncoder().encode(`${PNG_B64}\n`) });
    const img = await readClipboardImage({ platform: "win32", run });
    expect(img?.data).toBe(PNG_B64);
    expect(img?.bytes).toBe(PNG.length);
  });

  test("unsupported platform → null", async () => {
    const run: Runner = async () => ({ ok: true, stdout: PNG });
    expect(await readClipboardImage({ platform: "freebsd" as NodeJS.Platform, run })).toBeNull();
  });

  test("rejects pathologically large blobs (>5MB)", async () => {
    const huge = new Uint8Array(6 * 1024 * 1024);
    const img = await readClipboardImage({ platform: "darwin", run: runnerFor("pngpaste", huge) });
    expect(img).toBeNull();
  });

  test("empty stdout → null", async () => {
    const img = await readClipboardImage({
      platform: "darwin",
      run: runnerFor("pngpaste", new Uint8Array()),
    });
    expect(img).toBeNull();
  });
});
