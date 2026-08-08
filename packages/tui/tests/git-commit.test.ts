/**
 * F9a (MUB-230) — git_commit against a real temporary repository.
 *
 * The seam is the tool's execute path, and every assertion reads real git output
 * (`git log --format=%B` for the message, `git log --format=%ae` for authorship,
 * `git show --stat` for contents) rather than internal state. Trailer construction is
 * deliberately NOT an exported seam: the commit message IS the external behaviour, so
 * these tests only ever see what git recorded.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool } from "../src/agent/tools.ts";
import { configFromEnv } from "../src/minima/config.ts";
import { makeRepoResolver } from "../src/session/checkpoint.ts";
import { type CommitContext, commitChanges, makeCommitDeps } from "../src/session/commit.ts";
import { type CommitDeps, registerGitCommitTool } from "../src/tools/git_commit.ts";
import { checkPermission, createPermissionState } from "../src/tui/permissions.ts";
import { decideBusySubmit } from "../src/tui/prompt_queue.ts";
import { code, readSource } from "./_source.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const USER_EMAIL = "dev@example.test";
const USER_NAME = "Repo Owner";

function git(top: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", top, ...args]);
  return res.stdout.toString();
}

/** mkdtemp + git init + a configured identity + an --allow-empty root commit (checkpoint prior art). */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "minima-commit-"));
  dirs.push(dir);
  Bun.spawnSync(["git", "init", dir]);
  Bun.spawnSync(["git", "-C", dir, "config", "user.email", USER_EMAIL]);
  Bun.spawnSync(["git", "-C", dir, "config", "user.name", USER_NAME]);
  Bun.spawnSync(["git", "-C", dir, "config", "commit.gpgsign", "false"]);
  Bun.spawnSync(["git", "-C", dir, "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

function write(top: string, relPath: string, content: string): void {
  const full = join(top, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/** Install an executable hook that exits `code`, echoing `say` to stderr. */
function hook(top: string, name: string, code: number, say: string): void {
  const path = join(top, ".git", "hooks", name);
  writeFileSync(path, `#!/bin/sh\necho "${say}" >&2\nexit ${code}\n`);
  chmodSync(path, 0o755);
}

function toolFor(
  top: string | null,
  opts: { models?: string[]; runId?: string | null; enabled?: boolean } = {},
): AgentTool | null {
  const tools: AgentTool[] = [];
  const deps: CommitDeps = {
    top: top === null ? () => null : makeRepoResolver(top),
    models: () => opts.models ?? ["claude-sonnet-5"],
    runId: () => (opts.runId === undefined ? "run-abc123" : opts.runId),
  };
  registerGitCommitTool(tools, opts.enabled ?? true, deps);
  return tools.find((t) => t.name === "git_commit") ?? null;
}

function run(
  tool: AgentTool,
  params: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown> }> {
  return tool.execute("call-1", params, null, null).then((r) => ({
    text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
    details: r.details ?? {},
  }));
}

const body = (top: string) => git(top, "log", "-1", "--format=%B");
const subject = (top: string) => git(top, "log", "-1", "--format=%s").trim();
const count = (top: string) => git(top, "rev-list", "--count", "HEAD").trim();

describe("git_commit — a real, well-formed commit", () => {
  test("commits the staged index and reports the sha + stat", async () => {
    const top = tempRepo();
    write(top, "a.txt", "hello\n");
    git(top, "add", "a.txt");

    const tool = toolFor(top)!;
    const { text, details } = await run(tool, { message: "feat: add a" });

    expect(count(top)).toBe("2");
    expect(subject(top)).toBe("feat: add a");
    expect(details.sha).toBe(git(top, "rev-parse", "HEAD").trim());
    expect(text).toContain("a.txt");
    expect(git(top, "show", "--stat", "--format=", "HEAD")).toContain("a.txt");
  });

  test("author stays the user's configured identity — minima@local never reaches real history", async () => {
    const top = tempRepo();
    write(top, "a.txt", "hello\n");
    git(top, "add", "a.txt");

    await run(toolFor(top)!, { message: "feat: add a" });

    expect(git(top, "log", "-1", "--format=%ae").trim()).toBe(USER_EMAIL);
    expect(git(top, "log", "-1", "--format=%an").trim()).toBe(USER_NAME);
    expect(git(top, "log", "-1", "--format=%ce").trim()).toBe(USER_EMAIL);
    expect(git(top, "log", "--format=%ae%n%ce")).not.toContain("minima@local");
  });
});

describe("git_commit — attribution trailers", () => {
  test("one Co-Authored-By per contributing model, deduped, in first-use order", async () => {
    const top = tempRepo();
    write(top, "a.txt", "x\n");
    git(top, "add", "a.txt");

    await run(
      toolFor(top, {
        models: ["claude-sonnet-5", "gpt-5.6", "claude-sonnet-5", "claude-sonnet-5"],
      })!,
      { message: "feat: two models" },
    );

    const lines = body(top)
      .split("\n")
      .filter((l) => l.startsWith("Co-Authored-By:"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("claude-sonnet-5");
    expect(lines[1]).toContain("gpt-5.6");
    // A forge dedupes co-authors by email, so distinct models need distinct addresses.
    expect(new Set(lines.map((l) => l.slice(l.indexOf("<")))).size).toBe(2);
  });

  test("exactly one Minima-Run-Id, pointing at the run", async () => {
    const top = tempRepo();
    write(top, "a.txt", "x\n");
    git(top, "add", "a.txt");

    await run(toolFor(top, { models: ["m1", "m2", "m3"], runId: "run-xyz" })!, {
      message: "feat: many turns",
    });

    const runIds = body(top)
      .split("\n")
      .filter((l) => l.startsWith("Minima-Run-Id:"));
    expect(runIds).toEqual(["Minima-Run-Id: run-xyz"]);
  });

  test("no run id → no Minima-Run-Id trailer (never an empty pointer)", async () => {
    const top = tempRepo();
    write(top, "a.txt", "x\n");
    git(top, "add", "a.txt");

    await run(toolFor(top, { runId: null })!, { message: "feat: no run" });

    expect(body(top)).not.toContain("Minima-Run-Id");
    expect(body(top)).toContain("Co-Authored-By:");
  });

  test("trailers join an existing trailer block rather than starting a second one", async () => {
    const top = tempRepo();
    write(top, "a.txt", "x\n");
    git(top, "add", "a.txt");

    await run(toolFor(top)!, {
      message: "fix: something\n\nA real body paragraph.\n\nSigned-off-by: Dev <dev@example.test>",
    });

    const text = body(top).trimEnd();
    const blocks = text.split(/\n\s*\n/);
    const last = blocks[blocks.length - 1]!.split("\n");
    expect(last[0]).toBe("Signed-off-by: Dev <dev@example.test>");
    expect(last.every((l) => /^[A-Za-z][A-Za-z0-9-]*: /.test(l))).toBe(true);
    expect(text).toContain("A real body paragraph.");
  });

  test("a model the author already credited is not credited twice", async () => {
    const top = tempRepo();
    write(top, "a.txt", "x\n");
    git(top, "add", "a.txt");

    const tool = toolFor(top, { models: ["claude-sonnet-5"] })!;
    const first = await run(tool, { message: "feat: one" });
    const authored = body(top)
      .split("\n")
      .find((l) => l.startsWith("Co-Authored-By:"))!;
    expect(first.text).toBeTruthy();

    write(top, "b.txt", "y\n");
    git(top, "add", "b.txt");
    await run(tool, { message: `feat: two\n\n${authored}` });

    const lines = body(top)
      .split("\n")
      .filter((l) => l.startsWith("Co-Authored-By:"));
    expect(lines).toEqual([authored]);
  });
});

describe("makeCommitDeps — who gets credited", () => {
  const ctx = (over: Partial<CommitContext> = {}): CommitContext => ({
    cwd: process.cwd(),
    db: null,
    getRunId: () => "run-1",
    getLiveModelId: () => null,
    ...over,
  });
  // Only the trailer path is under test here, so the two ledger methods are inert — present to
  // satisfy CommitLedgerDb, never called. The ledger itself is covered in commits-ledger.test.ts.
  const fakeDb = (models: (string | null)[]) => ({
    getRunDecisions: () => models.map((chosen_model) => ({ chosen_model })),
    unattributedRecIds: () => [],
    recordCommit: () => {},
  });

  test("credits the run's routed decisions, oldest first", () => {
    const deps = makeCommitDeps(ctx({ db: fakeDb(["m-first", "m-second"]) }));
    expect(deps.models()).toEqual(["m-first", "m-second"]);
  });

  test("the live model is credited too — its decision row is not written until turn end", () => {
    // The regression this guards: the model that just made the changes being absent from
    // its own commit, because writeDecision runs after the turn it is committing.
    const deps = makeCommitDeps(
      ctx({ db: fakeDb(["m-earlier"]), getLiveModelId: () => "m-current" }),
    );
    expect(deps.models()).toEqual(["m-earlier", "m-current"]);
  });

  test("no db and no run id still credits the live model", () => {
    const deps = makeCommitDeps(ctx({ getRunId: () => null, getLiveModelId: () => "m-only" }));
    expect(deps.models()).toEqual(["m-only"]);
    expect(deps.runId()).toBeNull();
  });

  test("decision rows with no chosen_model are skipped, not credited as blanks", () => {
    const deps = makeCommitDeps(ctx({ db: fakeDb(["m-real", null, ""]) }));
    expect(deps.models()).toEqual(["m-real"]);
  });

  test("the two id namespaces fold to one co-author, not two", async () => {
    // routing_decisions carries Minima's catalogue id, agent state the harness registry id;
    // the spellings drift (minima/mapping.ts exists for that), commonly by a provider prefix.
    const top = tempRepo();
    write(top, "a.txt", "x\n");
    git(top, "add", "a.txt");
    const deps = makeCommitDeps({
      cwd: top,
      db: fakeDb(["anthropic/claude-sonnet-5"]),
      getRunId: () => "run-1",
      getLiveModelId: () => "claude-sonnet-5",
    });
    const tools: AgentTool[] = [];
    registerGitCommitTool(tools, true, deps);
    await run(tools[0]!, { message: "feat: one model, two spellings" });

    const lines = body(top)
      .split("\n")
      .filter((l) => l.startsWith("Co-Authored-By:"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("anthropic/claude-sonnet-5");
  });
});

describe("git_commit — staging is explicit", () => {
  test("named paths commit only those paths; an unnamed dirty file stays out", async () => {
    const top = tempRepo();
    write(top, "wanted.txt", "in\n");
    write(top, "unwanted.txt", "out\n");

    await run(toolFor(top)!, { message: "feat: only wanted", paths: ["wanted.txt"] });

    const stat = git(top, "show", "--stat", "--format=", "HEAD");
    expect(stat).toContain("wanted.txt");
    expect(stat).not.toContain("unwanted.txt");
    expect(git(top, "status", "--porcelain")).toContain("unwanted.txt");
  });

  test("named paths keep the commit partial — unrelated staged work stays staged", async () => {
    const top = tempRepo();
    write(top, "mine.txt", "the model's change\n");
    write(top, "theirs.txt", "the user's own staged work\n");
    git(top, "add", "theirs.txt");

    await run(toolFor(top)!, { message: "feat: only mine", paths: ["mine.txt"] });

    expect(git(top, "show", "--stat", "--format=", "HEAD")).not.toContain("theirs.txt");
    expect(git(top, "diff", "--cached", "--name-only")).toContain("theirs.txt");
  });

  test("paths also arrive as the JSON-array string the schema declares", async () => {
    const top = tempRepo();
    write(top, "one.txt", "1\n");
    write(top, "two.txt", "2\n");

    await run(toolFor(top)!, { message: "feat: json paths", paths: '["one.txt"]' });

    const stat = git(top, "show", "--stat", "--format=", "HEAD");
    expect(stat).toContain("one.txt");
    expect(stat).not.toContain("two.txt");
  });

  test("works in a fresh repo with no root commit yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minima-unborn-"));
    dirs.push(dir);
    Bun.spawnSync(["git", "init", dir]);
    Bun.spawnSync(["git", "-C", dir, "config", "user.email", USER_EMAIL]);
    Bun.spawnSync(["git", "-C", dir, "config", "user.name", USER_NAME]);
    write(dir, "first.txt", "hello\n");

    await run(toolFor(dir)!, { message: "chore: initial", paths: ["first.txt"] });

    expect(count(dir)).toBe("1");
    expect(body(dir)).toContain("Co-Authored-By:");
    expect(git(dir, "log", "-1", "--format=%ae").trim()).toBe(USER_EMAIL);
  });

  test("nothing staged and no paths → a clear error, and no commit", async () => {
    const top = tempRepo();
    write(top, "loose.txt", "not staged\n");

    await expect(run(toolFor(top)!, { message: "feat: nothing" })).rejects.toThrow(
      /nothing staged/i,
    );
    expect(count(top)).toBe("1");
  });

  test("a rejected commit leaves the user's own partial staging intact", async () => {
    const top = tempRepo();
    write(top, "theirs.txt", "v1\n");
    git(top, "add", "theirs.txt");
    git(top, "commit", "-m", "add theirs");
    // The user stages one version of their file, then keeps editing it (git add -p shape).
    write(top, "theirs.txt", "v2-staged\n");
    git(top, "add", "theirs.txt");
    write(top, "theirs.txt", "v3-worktree-only\n");
    write(top, "mine.txt", "the model's new file\n");
    hook(top, "pre-commit", 1, "nope");

    await expect(
      run(toolFor(top)!, { message: "feat: mine", paths: ["mine.txt"] }),
    ).rejects.toThrow(/nope/);

    // Staging a named path must never overwrite the index for a path it was not given.
    expect(git(top, "show", ":theirs.txt")).toBe("v2-staged\n");
    expect(count(top)).toBe("2");
  });

  test("never uses -a: a tracked-but-unstaged edit is not swept in", async () => {
    const top = tempRepo();
    write(top, "tracked.txt", "v1\n");
    git(top, "add", "tracked.txt");
    git(top, "-c", `user.email=${USER_EMAIL}`, "commit", "-m", "add tracked");

    write(top, "tracked.txt", "v2\n"); // modified, NOT staged
    write(top, "staged.txt", "new\n");
    git(top, "add", "staged.txt");

    await run(toolFor(top)!, { message: "feat: staged only" });

    const stat = git(top, "show", "--stat", "--format=", "HEAD");
    expect(stat).toContain("staged.txt");
    expect(stat).not.toContain("tracked.txt");
    expect(git(top, "status", "--porcelain")).toContain("tracked.txt");
  });
});

describe("git_commit — hooks fire", () => {
  test("a pre-commit rejection surfaces as a tool error, not a silent no-op", async () => {
    const top = tempRepo();
    write(top, "a.txt", "x\n");
    git(top, "add", "a.txt");
    hook(top, "pre-commit", 1, "lint failed: tabs everywhere");

    await expect(run(toolFor(top)!, { message: "feat: rejected" })).rejects.toThrow(
      /lint failed: tabs everywhere/,
    );
    expect(count(top)).toBe("1");
  });

  test("a commit-msg rejection surfaces as a tool error", async () => {
    const top = tempRepo();
    write(top, "a.txt", "x\n");
    git(top, "add", "a.txt");
    hook(top, "commit-msg", 1, "message must start with a type");

    await expect(run(toolFor(top)!, { message: "bad message" })).rejects.toThrow(
      /message must start with a type/,
    );
    expect(count(top)).toBe("1");
  });

  test("a passing pre-commit hook lets the commit through", async () => {
    const top = tempRepo();
    write(top, "a.txt", "x\n");
    git(top, "add", "a.txt");
    hook(top, "pre-commit", 0, "lint ok");

    await run(toolFor(top)!, { message: "feat: hooked" });
    expect(count(top)).toBe("2");
  });
});

describe("git_commit — refusals and non-repo reporting", () => {
  test("refuses mid-merge with a clear message", async () => {
    const top = tempRepo();
    write(top, "conflict.txt", "base\n");
    git(top, "add", "conflict.txt");
    git(top, "commit", "-m", "base");
    git(top, "checkout", "-b", "side");
    write(top, "conflict.txt", "side\n");
    git(top, "commit", "-am", "side change");
    git(top, "checkout", "-");
    write(top, "conflict.txt", "main\n");
    git(top, "commit", "-am", "main change");
    git(top, "merge", "side"); // conflicts → MERGE_HEAD present

    write(top, "conflict.txt", "resolved\n");
    git(top, "add", "conflict.txt");

    await expect(run(toolFor(top)!, { message: "fix: resolve" })).rejects.toThrow(/merge/i);
  });

  test("refuses mid-rebase with a clear message", async () => {
    const top = tempRepo();
    write(top, "r.txt", "base\n");
    git(top, "add", "r.txt");
    git(top, "commit", "-m", "base");
    git(top, "checkout", "-b", "topic");
    write(top, "r.txt", "topic\n");
    git(top, "commit", "-am", "topic change");
    git(top, "checkout", "-");
    write(top, "r.txt", "trunk\n");
    git(top, "commit", "-am", "trunk change");
    git(top, "checkout", "topic");
    git(top, "rebase", "-"); // conflicts → rebase-merge/rebase-apply present

    write(top, "r.txt", "resolved\n");
    git(top, "add", "r.txt");

    await expect(run(toolFor(top)!, { message: "fix: resolve" })).rejects.toThrow(/rebase/i);
  });

  test("outside a git repo it reports that plainly rather than throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minima-norepo-"));
    dirs.push(dir);

    const { text, details } = await run(toolFor(null)!, { message: "feat: nowhere" });

    expect(text.toLowerCase()).toContain("not a git repository");
    expect(details.committed).toBe(false);
  });
});

describe("git_commit — registration", () => {
  test("MINIMA_TUI_GIT_COMMIT=0 (enabled=false) registers no tool at all", () => {
    expect(toolFor(tempRepo(), { enabled: false })).toBeNull();
  });

  test("the tool is named git_commit so permissions gate it independently of bash", () => {
    const tool = toolFor(tempRepo())!;
    expect(tool.name).toBe("git_commit");
    expect(tool.parameters.jsonSchema).toBeTruthy();
  });

  test("the tool is permission-gated: not read-only, not a no-prompt UI tool", async () => {
    // checkPermission's own tables decide this — git_commit falls through to the
    // always-prompt branch, and its "always" grant is its own, never bash's.
    const state = createPermissionState("/tmp");
    state.bashGrants.add("git");
    const promptedFor: string[] = [];
    const decision = await checkPermission("git_commit", { message: "feat: x" }, state, (p) => {
      promptedFor.push(p.toolName);
      p.resolve("deny");
    });
    expect(promptedFor).toEqual(["git_commit"]);
    expect(decision?.block).toBe(true);
  });

  test("MINIMA_TUI_GIT_COMMIT is a default-ON config switch", () => {
    const saved = process.env.MINIMA_TUI_GIT_COMMIT;
    try {
      process.env.MINIMA_TUI_GIT_COMMIT = undefined as unknown as string;
      delete process.env.MINIMA_TUI_GIT_COMMIT;
      expect(configFromEnv().gitCommit).toBe(true);
      process.env.MINIMA_TUI_GIT_COMMIT = "0";
      expect(configFromEnv().gitCommit).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.MINIMA_TUI_GIT_COMMIT;
      else process.env.MINIMA_TUI_GIT_COMMIT = saved;
    }
  });
});

describe("git_commit — the two surfaces are one code path (wiring pins)", () => {
  test("main.ts registers the tool behind config.gitCommit with shared deps", () => {
    const src = readSource("cli/main.ts");
    expect(src).toContain(
      code("registerGitCommitTool(agent.agentState.tools, config.gitCommit, commitDeps);"),
    );
    // The SAME deps object reaches the TUI, so /commit cannot drift from the tool.
    expect(src).toContain(code("commitDeps: config.gitCommit ? commitDeps : null,"));
  });

  test("/commit's call shape produces a commit identical to the tool's", async () => {
    // The /commit case itself lives inside app.tsx's handleCommand and cannot be driven
    // without mounting Ink (hence the source pins below). What IS testable for real is the
    // claim that matters: the same deps through the same engine, called the way /commit
    // calls it (message only, no paths), yield the same commit the tool would have made.
    const viaCommand = tempRepo();
    const viaTool = tempRepo();
    for (const top of [viaCommand, viaTool]) {
      write(top, "a.txt", "x\n");
      git(top, "add", "a.txt");
    }
    const depsFor = (top: string): CommitDeps => ({
      top: makeRepoResolver(top),
      models: () => ["m-one", "m-two"],
      runId: () => "run-shared",
    });

    const commandResult = await commitChanges(depsFor(viaCommand), { message: "feat: same" });
    const tools: AgentTool[] = [];
    registerGitCommitTool(tools, true, depsFor(viaTool));
    await run(tools[0]!, { message: "feat: same" });

    expect(commandResult.ok).toBe(true);
    expect(body(viaCommand)).toBe(body(viaTool));
    expect(body(viaCommand)).toContain("Minima-Run-Id: run-shared");
    expect(git(viaCommand, "show", "--stat", "--format=", "HEAD")).toBe(
      git(viaTool, "show", "--stat", "--format=", "HEAD"),
    );
  });

  test("/commit calls the shared engine, and is removed outright when the flag is off", () => {
    const src = readSource("tui/app.tsx");
    expect(src).toContain(code("const result = await commitChanges(commitDeps!, { message });"));
    expect(src).toContain(
      code('if (cmdName === "commit" && !commitDeps) { replyUnknownCommand(name, args); return; }'),
    );
    // D3 renamed the source list to allCommands() so the keymap file can substitute live
    // chords into the descriptions. The guard is unchanged in intent: the flag-off branch
    // still filters /commit out of the one array the picker, tab-complete and /help read.
    expect(src).toContain(
      code(
        '() => (commitDeps ? allCommands() : allCommands().filter((c) => c.name !== "commit")),',
      ),
    );
    expect(src).toContain(code('{ name: "commit",'));
  });

  test("/commit is not dispatchable mid-turn — a commit while the model still edits would race", () => {
    expect(decideBusySubmit("/commit feat: x")).toEqual({ kind: "enqueue" });
  });
});
