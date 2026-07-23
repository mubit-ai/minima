import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../src/agent/tools.ts";
import { globTool } from "../src/tools/glob.ts";

const RG = Bun.which("rg");

let tmp = "";
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

function newTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), "minima-glob-"));
  return tmp;
}

async function run(tool: ReturnType<typeof globTool>, args: Record<string, unknown>) {
  const parsed = tool.parameters.validate(args);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return tool.execute("t1", parsed.value, null, null);
}

function body(res: ToolResult): string {
  return (res.content[0] as { text: string }).text;
}

function manyFilesTree(): string {
  const d = newTmp();
  for (let i = 249; i >= 0; i--) {
    writeFileSync(join(d, `f${String(i).padStart(3, "0")}.txt`), "x");
  }
  return d;
}

function ignoreTree(): string {
  const d = newTmp();
  mkdirSync(join(d, ".git"));
  writeFileSync(join(d, ".gitignore"), "dist/\n");
  mkdirSync(join(d, "dist"));
  writeFileSync(join(d, "dist", "out.js"), "x");
  mkdirSync(join(d, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(d, "node_modules", "pkg", "x.js"), "x");
  writeFileSync(join(d, "keep.txt"), "x");
  return d;
}

function assertSortedBeforeCap(res: ToolResult) {
  const b = body(res);
  const shown = b.split("\n").filter((l) => l.endsWith(".txt"));
  expect(shown.length).toBe(200);
  expect(shown[0]).toBe("f000.txt");
  expect(shown[199]).toBe("f199.txt");
  expect(b).toContain("showing first 200 of 250 matches");
  expect(res.details?.count).toBe(250);
  expect(res.details?.truncated).toBe(true);
  expect(res.details?.shown_lines).toBe(200);
  expect(res.details?.total_lines).toBe(250);
}

describe("glob sort-before-cap", () => {
  test.if(RG !== null)("L1a: rg path sorts the full set before the cap and says so", async () => {
    const d = manyFilesTree();
    const res = await run(globTool(), { pattern: "*.txt", path: d });
    assertSortedBeforeCap(res);
  });

  test("L1b: fallback path sorts the full set before the cap and says so", async () => {
    const d = manyFilesTree();
    const res = await run(globTool({ rgCmd: null }), { pattern: "*.txt", path: d });
    assertSortedBeforeCap(res);
  });
});

describe("glob ignore filtering", () => {
  test.if(RG !== null)("L2: rg path drops .gitignore'd dirs and node_modules", async () => {
    const d = ignoreTree();
    const res = await run(globTool(), { pattern: "**/*", path: d });
    const b = body(res);
    expect(b.split("\n")[0]).toBe("keep.txt");
    expect(b).not.toContain("dist/out.js");
    expect(b).not.toContain("node_modules");
    // the exclusion is announced on the partial-match path, not only on zero matches
    expect(b).toContain("include_ignored=true");
  });

  test("L3: fallback excludes node_modules; dist/ present (documented asymmetry)", async () => {
    const d = ignoreTree();
    const res = await run(globTool({ rgCmd: null }), { pattern: "**/*", path: d });
    const b = body(res);
    expect(b).toContain("keep.txt");
    expect(b).toContain("dist/out.js");
    expect(b).not.toContain("node_modules");
  });

  test("L4: include_ignored=true includes node_modules and dotfiles", async () => {
    const d = ignoreTree();
    const res = await run(globTool(), {
      pattern: "**/*",
      path: d,
      include_ignored: true,
    });
    const b = body(res);
    expect(b).toContain("node_modules/pkg/x.js");
    expect(b).toContain(".gitignore");
    expect(b).toContain("dist/out.js");
  });
});

describe("glob pattern semantics", () => {
  test.if(RG !== null)("L5a: *.ts stays top-level on the rg path", async () => {
    const d = newTmp();
    writeFileSync(join(d, "a.ts"), "x");
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "sub", "b.ts"), "x");
    const res = await run(globTool(), { pattern: "*.ts", path: d });
    expect(body(res).split("\n")[0]).toBe("a.ts");
    expect(body(res)).not.toContain("sub/b.ts");
  });

  test("L5b: *.ts stays top-level on the fallback path", async () => {
    const d = newTmp();
    writeFileSync(join(d, "a.ts"), "x");
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "sub", "b.ts"), "x");
    const res = await run(globTool({ rgCmd: null }), { pattern: "*.ts", path: d });
    expect(body(res)).toBe("a.ts");
  });
});

describe("glob zero matches", () => {
  test.if(RG !== null)("L6: rg path hints include_ignored on zero matches", async () => {
    const d = newTmp();
    writeFileSync(join(d, "a.txt"), "x");
    const res = await run(globTool(), { pattern: "*.zzz", path: d });
    expect(body(res)).toContain("include_ignored");
  });
});

// Review fixes: fake-rg scripts pin the rg-engine branches deterministically on machines
// without ripgrep (the rgCmd seam forces the binary).
describe("glob rg engine via fake rg", () => {
  test("L7: non-empty rg results carry the exclusion note", async () => {
    const d = newTmp();
    writeFileSync(join(d, "keep.txt"), "x");
    const fake = join(d, "fake-rg.sh");
    writeFileSync(fake, "#!/bin/sh\nprintf 'keep.txt\\n'\nexit 0\n", { mode: 0o755 });
    const res = await run(globTool({ rgCmd: fake }), { pattern: "*.txt", path: d });
    const b = body(res);
    expect(b.split("\n")[0]).toBe("keep.txt");
    expect(b).toContain("include_ignored=true");
  });

  test("L8: rg failure falls back to the scan engine instead of reporting no matches", async () => {
    const d = newTmp();
    writeFileSync(join(d, "real.txt"), "x");
    const fake = join(d, "fake-rg.sh");
    writeFileSync(fake, "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    const res = await run(globTool({ rgCmd: fake }), { pattern: "*.txt", path: d });
    const b = body(res);
    expect(b).toContain("real.txt");
    expect(b).not.toContain("include_ignored=true");
  });

  test("L9: rg is spawned with --no-config", async () => {
    const d = newTmp();
    writeFileSync(join(d, "keep.txt"), "x");
    const fake = join(d, "fake-rg.sh");
    const argsFile = join(d, "args.txt");
    writeFileSync(fake, `#!/bin/sh\necho "$@" > ${JSON.stringify(argsFile)}\nprintf 'keep.txt\\n'\n`, {
      mode: 0o755,
    });
    await run(globTool({ rgCmd: fake }), { pattern: "*.txt", path: d });
    expect(readFileSync(argsFile, "utf8")).toContain("--no-config");
  });

  test("L10: leading ./ patterns match on both engines", async () => {
    const d = newTmp();
    mkdirSync(join(d, "src"));
    writeFileSync(join(d, "src", "a.ts"), "x");
    const fake = join(d, "fake-rg.sh");
    writeFileSync(fake, "#!/bin/sh\nprintf 'src/a.ts\\n'\nexit 0\n", { mode: 0o755 });
    const viaRg = await run(globTool({ rgCmd: fake }), { pattern: "./src/*.ts", path: d });
    const viaScan = await run(globTool({ rgCmd: null }), { pattern: "./src/*.ts", path: d });
    expect(body(viaRg)).toContain("src/a.ts");
    expect(body(viaScan)).toContain("src/a.ts");
  });
});
