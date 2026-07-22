import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatchTool } from "../src/tools/apply_patch.ts";

let dir = "";
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), "minima-patch-async-"));
  return dir;
}

function patch(...body: string[]): string {
  return ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
}

async function run(wd: string, patchText: string) {
  const tool = applyPatchTool({ workdir: wd });
  const parsed = tool.parameters.validate({ patch: patchText });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return tool.execute("c1", parsed.value, null, null);
}

const read = (wd: string, rel: string) => readFileSync(join(wd, rel), "utf8");
const write = (wd: string, rel: string, content: string) => writeFileSync(join(wd, rel), content);
const outText = (res: Awaited<ReturnType<typeof run>>) => (res.content[0] as { text: string }).text;

describe("apply_patch — async IO edges smoke", () => {
  test("multi-file patch round-trips through the pre-read map", async () => {
    const wd = freshDir();
    write(wd, "keep.ts", "a = 1\nb = 2\n");
    write(wd, "moved.ts", "old = true\n");
    write(wd, "gone.ts", "bye\n");
    const res = await run(
      wd,
      patch(
        "*** Add File: fresh.ts",
        "+hello = 1",
        "*** Update File: keep.ts",
        " a = 1",
        "-b = 2",
        "+b = 3",
        "*** Update File: moved.ts",
        "*** Move to: renamed.ts",
        "-old = true",
        "+old = false",
        "*** Delete File: gone.ts",
      ),
    );
    expect(outText(res)).toContain("applied patch (4 change(s))");
    expect(read(wd, "fresh.ts")).toBe("hello = 1\n");
    expect(read(wd, "keep.ts")).toBe("a = 1\nb = 3\n");
    expect(read(wd, "renamed.ts")).toBe("old = false\n");
    expect(existsSync(join(wd, "moved.ts"))).toBe(false);
    expect(existsSync(join(wd, "gone.ts"))).toBe(false);
  });

  test("failing hunk in one file leaves every file untouched", async () => {
    const wd = freshDir();
    write(wd, "ok.ts", "x = 1\n");
    write(wd, "bad.ts", "y = 2\n");
    const res = await run(
      wd,
      patch(
        "*** Update File: ok.ts",
        "-x = 1",
        "+x = 10",
        "*** Update File: bad.ts",
        "-does not exist",
        "+never written",
      ),
    );
    expect(outText(res)).toContain("could not locate hunk context");
    expect(read(wd, "ok.ts")).toBe("x = 1\n");
    expect(read(wd, "bad.ts")).toBe("y = 2\n");
  });
});
