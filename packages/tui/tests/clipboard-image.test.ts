import { writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { MAX_IMAGE_BYTES } from "../src/tools/read.ts";
import {
  CLIPBOARD_READ_CAP,
  MAX_IMAGE_EDGE,
  type RunResult,
  type Runner,
  decodeAppleHexData,
  downscalePlan,
  hasImageFlavor,
  isPng,
  parseClipboardInfo,
  pngDimensions,
  readClipboardImage,
} from "../src/tui/clipboard_image.ts";

// Both strings are VERBATIM `osascript -e 'clipboard info'` output captured on macOS 15 — one
// with a screenshot on the pasteboard, one with `printf 'hello world' | pbcopy`. The text case
// is the load-bearing one: if a text clipboard ever advertised an image flavor, Ctrl+V would
// paste an image every time someone copied a word.
const INFO_IMAGE =
  "«class PNGf», 118502, «class AVIF», 13599, «class 8BPS», 758498, GIF picture, 41913, «class jp2 », 113868, JPEG picture, 66232, TIFF picture, 3633934, «class BMP », 3632970, «class TPIC», 438817";
const INFO_TEXT = "«class utf8», 11, «class ut16», 24, string, 11, Unicode text, 22";

/** A PNG that is real where it matters: signature + a well-formed IHDR at the fixed offset. */
function fakePng(width: number, height: number, totalBytes = 24): Uint8Array {
  const b = new Uint8Array(Math.max(24, totalBytes));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(b.buffer);
  view.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return b;
}

const hexOf = (b: Uint8Array): string => Buffer.from(b).toString("hex").toUpperCase();
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

type Reply = { exitCode?: number; stdout?: string | Uint8Array } | null;
type Entry = Reply | ((cmd: string[]) => Reply);

/**
 * Fake Runner over an argv->reply table. An unlisted command THROWS, so a test can never
 * silently pass because production stopped calling what it was supposed to call.
 *
 * `sips` is keyed on the binary alone: its argv embeds pid- and size-derived temp paths, and
 * it communicates through the filesystem rather than stdout — so its entry is a function that
 * writes the resized file where production will look for it, exercising the real
 * write/read/unlink round-trip.
 */
function runner(table: Record<string, Entry>): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = (cmd) => {
    calls.push(cmd.join(" "));
    const key = cmd[0] === "sips" ? "sips" : cmd.join(" ");
    if (!(key in table)) throw new Error(`unexpected command: ${cmd.join(" ")}`);
    const entry = table[key];
    const hit = typeof entry === "function" ? entry(cmd) : entry;
    if (hit === null || hit === undefined) return null;
    const out = hit.stdout ?? "";
    const res: RunResult = {
      exitCode: hit.exitCode ?? 0,
      stdout: typeof out === "string" ? enc(out) : out,
    };
    return res;
  };
  return { run, calls };
}

const INFO_CMD = "osascript -e clipboard info";
const GET_CMD = "osascript -e get the clipboard as «class PNGf»";
const WL_LIST = "wl-paste --list-types";
const WL_GET = "wl-paste --type image/png";
const X_LIST = "xclip -selection clipboard -t TARGETS -o";
const X_GET = "xclip -selection clipboard -t image/png -o";

describe("clipboard flavor parsing", () => {
  test("a screenshot pasteboard reports PNG and its size", () => {
    expect(parseClipboardInfo(INFO_IMAGE)).toEqual({ png: 118502, hasImage: true });
  });

  test("a text pasteboard reports no image at all", () => {
    expect(parseClipboardInfo(INFO_TEXT)).toEqual({ png: undefined, hasImage: false });
  });

  test("an image flavor with no PNG entry is still worth asking for (the pasteboard coerces)", () => {
    const info = parseClipboardInfo("TIFF picture, 3633934, «class 8BPS», 758498");
    expect(info).toEqual({ png: undefined, hasImage: true });
  });

  test("linux TARGETS listings are matched whole-line, not by substring", () => {
    expect(hasImageFlavor("TARGETS\nimage/png\ntext/html")).toBe(true);
    expect(hasImageFlavor("TARGETS\nUTF8_STRING\ntext/plain")).toBe(false);
    // Would be a false positive under a naive `includes("image/png")`.
    expect(hasImageFlavor("TARGETS\ntext/x-image/png-path")).toBe(false);
  });
});

describe("PNG decoding", () => {
  test("AppleScript hex data decodes past the 4-char type code to the PNG magic", () => {
    const png = fakePng(800, 600);
    const decoded = decodeAppleHexData(`«data PNGf${hexOf(png)}»`);
    expect(decoded).not.toBeNull();
    expect(isPng(decoded as Uint8Array)).toBe(true);
    expect(pngDimensions(decoded as Uint8Array)).toEqual({ width: 800, height: 600 });
  });

  test("anything that is not «data XXXX…» decodes to null", () => {
    expect(decodeAppleHexData("execution error: Can't make «class PNGf»")).toBeNull();
    expect(decodeAppleHexData("")).toBeNull();
    expect(decodeAppleHexData("«data PNGf89504E47F»")).toBeNull(); // odd nibble count
  });

  test("dimensions need a real signature and a full IHDR", () => {
    expect(pngDimensions(new Uint8Array(24))).toBeNull();
    expect(pngDimensions(fakePng(10, 10).slice(0, 20))).toBeNull();
  });
});

describe("downscalePlan", () => {
  test("a small in-bounds image is attached untouched", () => {
    expect(downscalePlan(50_000, { width: 800, height: 600 })).toBe("none");
  });

  test("the long edge decides, in either orientation", () => {
    expect(downscalePlan(1000, { width: MAX_IMAGE_EDGE, height: 100 })).toBe("none");
    expect(downscalePlan(1000, { width: MAX_IMAGE_EDGE + 1, height: 100 })).toBe("resize");
    expect(downscalePlan(1000, { width: 100, height: MAX_IMAGE_EDGE + 1 })).toBe("resize");
  });

  test("small dimensions but too many bytes still tries a re-encode", () => {
    expect(downscalePlan(MAX_IMAGE_BYTES + 1, { width: 100, height: 100 })).toBe("resize");
  });

  test("unreadable dimensions fall back to the byte test", () => {
    expect(downscalePlan(50_000, null)).toBe("none");
    expect(downscalePlan(MAX_IMAGE_BYTES + 1, null)).toBe("resize");
  });

  test("absurd sizes are refused before anything is materialized", () => {
    expect(downscalePlan(CLIPBOARD_READ_CAP + 1, { width: 10, height: 10 })).toBe("too-large");
  });
});

describe("readClipboardImage — macOS", () => {
  test("a screenshot comes back as a base64 PNG with its dimensions", () => {
    const png = fakePng(1200, 900, 4096);
    const { run, calls } = runner({
      [INFO_CMD]: { stdout: INFO_IMAGE },
      [GET_CMD]: { stdout: `«data PNGf${hexOf(png)}»` },
    });
    const res = readClipboardImage(run, "darwin");
    expect(res.kind).toBe("image");
    if (res.kind !== "image") return;
    expect(res.image).toMatchObject({
      mime: "image/png",
      bytes: 4096,
      width: 1200,
      height: 900,
      resized: false,
    });
    expect(Buffer.from(res.image.data, "base64").subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(calls).toEqual([INFO_CMD, GET_CMD]);
  });

  test("a text clipboard never reaches the extraction call", () => {
    const { run, calls } = runner({ [INFO_CMD]: { stdout: INFO_TEXT } });
    expect(readClipboardImage(run, "darwin")).toEqual({ kind: "none" });
    expect(calls).toEqual([INFO_CMD]); // the expensive second osascript is skipped
  });

  test("an advertised size over the hard cap refuses without extracting", () => {
    const { run, calls } = runner({
      [INFO_CMD]: { stdout: `«class PNGf», ${CLIPBOARD_READ_CAP + 1}` },
    });
    const res = readClipboardImage(run, "darwin");
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toContain("too large");
    expect(calls).toEqual([INFO_CMD]);
  });

  test("a failed coercion is an error, not a silent text paste", () => {
    const { run } = runner({
      [INFO_CMD]: { stdout: INFO_IMAGE },
      [GET_CMD]: { exitCode: 1, stdout: "" },
    });
    expect(readClipboardImage(run, "darwin").kind).toBe("error");
  });

  test("an oversized screenshot is resized through sips and reported as resized", () => {
    const big = fakePng(5120, 2880, 6_000_000);
    const small = fakePng(1568, 882, 400_000);
    const { run } = runner({
      [INFO_CMD]: { stdout: "«class PNGf», 6000000" },
      [GET_CMD]: { stdout: `«data PNGf${hexOf(big)}»` },
      // The temp paths carry the pid and byte count, so match on the fixed prefix instead.
      ...sipsEntry(small),
    });
    const res = readClipboardImage(run, "darwin");
    expect(res.kind).toBe("image");
    if (res.kind !== "image") return;
    expect(res.image).toMatchObject({ bytes: 400_000, width: 1568, resized: true });
  });

  test("an oversized image whose resize fails is refused with the honest byte count", () => {
    const big = fakePng(5120, 2880, 6_000_000);
    const { run } = runner({
      [INFO_CMD]: { stdout: "«class PNGf», 6000000" },
      [GET_CMD]: { stdout: `«data PNGf${hexOf(big)}»` },
      ...sipsEntry(null),
    });
    const res = readClipboardImage(run, "darwin");
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toContain("6000000");
  });

  test("an over-1568px image that already fits is attached in full when no resizer exists", () => {
    const wide = fakePng(2000, 1000, 50_000);
    const { run } = runner({
      [INFO_CMD]: { stdout: "«class PNGf», 50000" },
      [GET_CMD]: { stdout: `«data PNGf${hexOf(wide)}»` },
      ...sipsEntry(null),
    });
    const res = readClipboardImage(run, "darwin");
    expect(res.kind).toBe("image");
    if (res.kind === "image") expect(res.image).toMatchObject({ bytes: 50_000, resized: false });
  });
});

describe("readClipboardImage — linux", () => {
  test("wayland is preferred and returns raw PNG bytes", () => {
    const png = fakePng(640, 480, 2048);
    const { run, calls } = runner({
      [WL_LIST]: { stdout: "text/html\nimage/png\n" },
      [WL_GET]: { stdout: png },
    });
    const res = readClipboardImage(run, "linux");
    expect(res.kind).toBe("image");
    if (res.kind === "image") expect(res.image).toMatchObject({ width: 640, height: 480 });
    expect(calls).toEqual([WL_LIST, WL_GET]);
  });

  test("a missing wl-paste falls through to xclip", () => {
    const png = fakePng(100, 100, 1024);
    const { run, calls } = runner({
      [WL_LIST]: null, // ENOENT
      [X_LIST]: { stdout: "TARGETS\nimage/png\n" },
      [X_GET]: { stdout: png },
    });
    expect(readClipboardImage(run, "linux").kind).toBe("image");
    expect(calls).toEqual([WL_LIST, X_LIST, X_GET]);
  });

  test("no clipboard tool at all is 'none', not an error", () => {
    const { run } = runner({ [WL_LIST]: null, [X_LIST]: null });
    expect(readClipboardImage(run, "linux")).toEqual({ kind: "none" });
  });

  test("a text-only clipboard is 'none'", () => {
    const { run, calls } = runner({ [WL_LIST]: { stdout: "text/plain\nUTF8_STRING\n" } });
    expect(readClipboardImage(run, "linux")).toEqual({ kind: "none" });
    expect(calls).toEqual([WL_LIST]);
  });

  test("bytes that are not a PNG are an error rather than a corrupt attachment", () => {
    const { run } = runner({
      [WL_LIST]: { stdout: "image/png\n" },
      [WL_GET]: { stdout: "<html>not an image</html>" },
    });
    expect(readClipboardImage(run, "linux").kind).toBe("error");
  });

  test("linux resizing goes through ImageMagick on stdin/stdout — no temp file", () => {
    const big = fakePng(4000, 2000, 500_000);
    const small = fakePng(1568, 784, 90_000);
    const { run, calls } = runner({
      [WL_LIST]: { stdout: "image/png\n" },
      [WL_GET]: { stdout: big },
      [`magick png:- -resize ${MAX_IMAGE_EDGE}x${MAX_IMAGE_EDGE}> png:-`]: { stdout: small },
    });
    const res = readClipboardImage(run, "linux");
    expect(res.kind).toBe("image");
    if (res.kind === "image") expect(res.image).toMatchObject({ bytes: 90_000, resized: true });
    expect(calls.some((c) => c.startsWith("sips"))).toBe(false);
  });

  test("`convert` is tried when `magick` is absent", () => {
    const big = fakePng(4000, 2000, 500_000);
    const small = fakePng(1568, 784, 90_000);
    const geom = `${MAX_IMAGE_EDGE}x${MAX_IMAGE_EDGE}>`;
    const { run } = runner({
      [WL_LIST]: { stdout: "image/png\n" },
      [WL_GET]: { stdout: big },
      [`magick png:- -resize ${geom} png:-`]: null,
      [`convert png:- -resize ${geom} png:-`]: { stdout: small },
    });
    const res = readClipboardImage(run, "linux");
    if (res.kind === "image") expect(res.image.resized).toBe(true);
    else throw new Error(`expected an image, got ${res.kind}`);
  });
});

/** `out === null` simulates sips being absent or failing. */
function sipsEntry(out: Uint8Array | null): Record<string, Entry> {
  return {
    sips: (cmd) => {
      if (out === null) return { exitCode: 1 };
      writeFileSync(cmd[cmd.indexOf("--out") + 1] as string, out);
      return { exitCode: 0 };
    },
  };
}
