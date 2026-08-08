import { describe, expect, test } from "bun:test";

import { AssistantMessage } from "../src/ai/types.ts";
import type { Model } from "../src/ai/types.ts";
import type { QuestionParams } from "../src/tools/question.ts";
import {
  type CommandRunner,
  type PrProposal,
  compareUrl,
  fallbackProposal,
  parsePrArgs,
  parsePrProposal,
  runPr,
  sanitizeBranch,
  uniqueBranch,
} from "../src/tui/pr.ts";
import { readSource } from "./_source.ts";

const FALLBACK: PrProposal = { branch: "fb", commit: "fb commit", title: "fb title", body: "fb" };

const MODEL = { id: "faux/meta", api: "faux" } as unknown as Model;

/** A git/gh stub: records every command, answers from a prefix table. */
function fakeRunner(table: Record<string, { ok?: boolean; out?: string; err?: string }>): {
  run: CommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: CommandRunner = async (cmd) => {
    calls.push(cmd);
    // Match on whole arguments only — "…refs/heads/feat/pr" must not answer for "…feat/pr-2".
    const line = cmd.join(" ");
    const key = Object.keys(table)
      .filter((k) => line === k || line.startsWith(`${k} `))
      .sort((a, b) => b.length - a.length)[0];
    const hit = key ? table[key]! : {};
    return { ok: hit.ok ?? true, out: hit.out ?? "", err: hit.err ?? "" };
  };
  return { run, calls };
}

/** The default "dirty branch with a commit ahead of origin/main" repo. */
const REPO = {
  "git symbolic-ref": { out: "origin/main" },
  "git rev-parse --verify --quiet origin/main": { out: "abc123" },
  "git rev-parse --abbrev-ref HEAD": { out: "feature-x" },
  "git diff origin/main": { out: "diff --git a/x.ts b/x.ts\n+hello" },
  "git status --porcelain": { out: " M x.ts" },
  "git log --oneline": { out: "deadbee earlier work" },
};

const completeOk = (json: string) =>
  (async () =>
    new AssistantMessage({
      content: json,
      usage: { cost: { total: 0.001 } },
    } as never)) as never;

const askYes = async (_p: QuestionParams) => "Create the PR";
const askNo = async (_p: QuestionParams) => "Cancel";

const names = (calls: string[][]) => calls.map((c) => c.slice(0, 3).join(" "));

describe("pr arg + proposal parsing", () => {
  test("parsePrArgs takes the first token only", () => {
    expect(parsePrArgs("").base).toBeNull();
    expect(parsePrArgs("   ").base).toBeNull();
    expect(parsePrArgs("main").base).toBe("main");
    expect(parsePrArgs("  release/1.2   junk ").base).toBe("release/1.2");
  });

  test("sanitizeBranch keeps the branch inside the safe ref alphabet", () => {
    expect(sanitizeBranch("feat/Add PR Command", "fb")).toBe("feat/add-pr-command");
    expect(sanitizeBranch("; rm -rf /", "fb")).toBe("rm-rf");
    expect(sanitizeBranch("", "fb")).toBe("fb");
    expect(sanitizeBranch("///---///", "fb")).toBe("fb");
    expect(sanitizeBranch("x".repeat(200), "fb").length).toBeLessThanOrEqual(60);
  });

  test("parsePrProposal survives prose around the JSON and falls back on junk", () => {
    const good = parsePrProposal(
      'Sure!\n{"branch":"feat/x","commit":"feat: x","title":"Add x","body":"why"}\nDone.',
      FALLBACK,
    );
    expect(good).toEqual({ branch: "feat/x", commit: "feat: x", title: "Add x", body: "why" });
    expect(parsePrProposal("no json here", FALLBACK)).toEqual(FALLBACK);
    expect(parsePrProposal("{not: valid", FALLBACK)).toEqual(FALLBACK);
    // Partial objects keep the fallback per missing field.
    expect(parsePrProposal('{"branch":"feat/y"}', FALLBACK)).toEqual({
      ...FALLBACK,
      branch: "feat/y",
    });
  });

  test("fallbackProposal stamps a dated branch", () => {
    const p = fallbackProposal(new Date(2026, 7, 5, 14, 32), ["a.ts"]);
    expect(p.branch).toBe("minima/20260805-1432");
    expect(p.body).toContain("- a.ts");
  });
});

describe("runPr", () => {
  test("happy path: branch, commit, push, gh pr create against the requested base", async () => {
    const { run, calls } = fakeRunner({ ...REPO, gh: { out: "https://github.com/o/r/pull/7" } });
    const out = await runPr({
      top: "/repo",
      base: "main",
      metaModel: MODEL,
      ask: askYes,
      run,
      completeFn: completeOk(
        '{"branch":"feat/pr","commit":"feat: pr","title":"Add /pr","body":"b"}',
      ),
    });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("https://github.com/o/r/pull/7");

    const mutating = names(calls).filter(
      (c) =>
        !c.startsWith("git rev-parse") &&
        !c.startsWith("git diff") &&
        !c.startsWith("git status") &&
        !c.startsWith("git log") &&
        !c.startsWith("git symbolic-ref"),
    );
    expect(mutating).toEqual([
      "git switch -c",
      "git add -A",
      "git commit -m",
      "git push -u",
      "gh pr create",
    ]);

    const gh = calls.find((c) => c[0] === "gh")!;
    expect(gh).toContain("--base");
    expect(gh[gh.indexOf("--base") + 1]).toBe("main");
    expect(gh[gh.indexOf("--head") + 1]).toBe("feat/pr");
    expect(calls.find((c) => c[1] === "switch")).toEqual(["git", "switch", "-c", "feat/pr"]);
  });

  test("an existing branch name is suffixed, before the user is asked", async () => {
    const { run } = fakeRunner({
      ...REPO,
      "git rev-parse --verify --quiet refs/heads/feat/pr": { out: "aaa111" },
      gh: { out: "url" },
    });
    let asked = "";
    const out = await runPr({
      top: "/repo",
      base: "main",
      metaModel: MODEL,
      ask: async (p) => {
        asked = p.question;
        return "Create the PR";
      },
      run,
      completeFn: completeOk('{"branch":"feat/pr","commit":"c","title":"t","body":"b"}'),
    });
    expect(asked).toContain("feat/pr-2");
    expect(out.text).toContain("Pushed feat/pr-2");
  });

  test("uniqueBranch walks until a free name", async () => {
    const taken = new Set(["b", "b-2", "b-3"]);
    expect(await uniqueBranch("b", async (n) => taken.has(n))).toBe("b-4");
    expect(await uniqueBranch("b", async () => false)).toBe("b");
    // Pathological repo: give up rather than spin.
    expect(await uniqueBranch("b", async () => true)).toBe("b");
  });

  test("cancelling runs zero mutating commands", async () => {
    const { run, calls } = fakeRunner(REPO);
    const out = await runPr({
      top: "/repo",
      base: "main",
      metaModel: null,
      ask: askNo,
      run,
    });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("cancelled");
    for (const c of calls) {
      expect(["switch", "add", "commit", "push", "branch"]).not.toContain(c[1]);
      expect(c[0]).not.toBe("gh");
    }
  });

  test("no ask seam (headless) never pushes", async () => {
    const { run, calls } = fakeRunner(REPO);
    const out = await runPr({ top: "/repo", base: "main", metaModel: null, ask: null, run });
    expect(out.isError).toBe(true);
    expect(calls.some((c) => c[1] === "push")).toBe(false);
  });

  test("clean tree with commits ahead: no commit, still pushes", async () => {
    const { run, calls } = fakeRunner({
      ...REPO,
      "git status --porcelain": { out: "" },
      "git diff origin/main": { out: "" },
      gh: { out: "https://github.com/o/r/pull/8" },
    });
    const out = await runPr({ top: "/repo", base: "main", metaModel: null, ask: askYes, run });
    expect(out.isError).toBe(false);
    expect(calls.some((c) => c[1] === "commit")).toBe(false);
    expect(calls.some((c) => c[1] === "push")).toBe(true);
  });

  test("nothing to do is not an error and mutates nothing", async () => {
    const { run, calls } = fakeRunner({
      ...REPO,
      "git diff origin/main": { out: "" },
      "git status --porcelain": { out: "" },
      "git log --oneline": { out: "" },
    });
    const out = await runPr({ top: "/repo", base: "main", metaModel: MODEL, ask: askYes, run });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Nothing to open a PR for");
    expect(calls.some((c) => c[1] === "switch")).toBe(false);
  });

  test("unknown base branch stops before any mutation", async () => {
    const { run, calls } = fakeRunner({
      ...REPO,
      "git rev-parse --verify --quiet origin/nope": { ok: false },
      "git rev-parse --verify --quiet nope": { ok: false },
    });
    const out = await runPr({ top: "/repo", base: "nope", metaModel: null, ask: askYes, run });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("nope");
    expect(calls.some((c) => c[1] === "switch")).toBe(false);
  });

  test("detached HEAD is refused", async () => {
    const { run } = fakeRunner({ ...REPO, "git rev-parse --abbrev-ref HEAD": { out: "HEAD" } });
    const out = await runPr({ top: "/repo", base: "main", metaModel: null, ask: askYes, run });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("detached");
  });

  test("missing gh is not a failure — the branch is pushed either way", async () => {
    const { run } = fakeRunner({ ...REPO, gh: { ok: false, err: "command not found: gh" } });
    const out = await runPr({
      top: "/repo",
      base: "main",
      metaModel: MODEL,
      ask: askYes,
      run,
      completeFn: completeOk('{"branch":"feat/pr","commit":"c","title":"t","body":"b"}'),
    });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Pushed feat/pr");
    expect(out.text).toContain("command not found: gh");
  });

  test("compareUrl only offers a link for real hosted remotes", () => {
    expect(compareUrl("github.com/o/r", "main", "feat/x")).toBe(
      "https://github.com/o/r/compare/main...feat/x?expand=1",
    );
    expect(compareUrl("gitlab.example.com/team/repo", "main", "x")).toContain("https://gitlab");
    // repoIdentity's fallbacks: a bare path or a plain directory get no link at all.
    expect(compareUrl("/tmp/scratch/origin", "main", "x")).toBeNull();
    expect(compareUrl("myrepo", "main", "x")).toBeNull();
  });

  test("failed push reports the branch it left behind", async () => {
    const { run } = fakeRunner({ ...REPO, "git push": { ok: false, err: "no upstream perms" } });
    const out = await runPr({ top: "/repo", base: "main", metaModel: null, ask: askYes, run });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("no upstream perms");
    expect(out.text).toContain("git switch -");
  });

  test("LLM failure falls back to a dated branch and still completes", async () => {
    const { run, calls } = fakeRunner({ ...REPO, gh: { out: "url" } });
    const out = await runPr({
      top: "/repo",
      base: "main",
      metaModel: MODEL,
      ask: askYes,
      run,
      now: new Date(2026, 7, 5, 14, 32),
      completeFn: (async () => {
        throw new Error("provider down");
      }) as never,
    });
    expect(out.isError).toBe(false);
    expect(calls.find((c) => c[1] === "switch")).toEqual([
      "git",
      "switch",
      "-c",
      "minima/20260805-1432",
    ]);
  });

  test("starting on the base branch resets it back to the remote after the push", async () => {
    const { run, calls } = fakeRunner({
      ...REPO,
      "git rev-parse --abbrev-ref HEAD": { out: "main" },
      gh: { out: "url" },
    });
    const out = await runPr({
      top: "/repo",
      base: "main",
      metaModel: null,
      ask: askYes,
      run,
      now: new Date(2026, 7, 5, 14, 32),
    });
    expect(out.text).toContain("Local main reset to origin/main");
    const reset = calls.find((c) => c[1] === "branch")!;
    expect(reset).toEqual(["git", "branch", "-f", "main", "origin/main"]);
    // …and only ever AFTER the push, never before.
    expect(calls.indexOf(reset)).toBeGreaterThan(calls.findIndex((c) => c[1] === "push"));
  });

  test("the confirm prompt shows the branch, base and title before anything runs", async () => {
    let seen: QuestionParams | null = null;
    const { run } = fakeRunner({ ...REPO, gh: { out: "url" } });
    await runPr({
      top: "/repo",
      base: "main",
      metaModel: MODEL,
      ask: async (p) => {
        seen = p;
        return "Cancel";
      },
      run,
      completeFn: completeOk(
        '{"branch":"feat/pr","commit":"feat: pr","title":"Add /pr","body":"b"}',
      ),
    });
    expect(seen!.question).toContain("feat/pr");
    expect(seen!.question).toContain("main");
    expect(seen!.question).toContain("Add /pr");
    // Commits already on the branch ride along, so the preview must say so.
    expect(seen!.question).toContain("Carries: 1 commit(s) already ahead of main");
    expect(seen!.allow_freetext).toBe(false);
  });

  test("model spend is booked through onCostUsd", async () => {
    const { run } = fakeRunner({ ...REPO, gh: { out: "url" } });
    let usd = 0;
    await runPr({
      top: "/repo",
      base: "main",
      metaModel: MODEL,
      ask: askNo,
      run,
      onCostUsd: (v) => {
        usd += v;
      },
      completeFn: completeOk('{"branch":"a","commit":"b","title":"c","body":"d"}'),
    });
    expect(usd).toBeCloseTo(0.001, 6);
  });
});

describe("tui/app.tsx /pr command (source pins)", () => {
  test("registered in COMMANDS and dispatched", () => {
    const src = readSource("tui/app.tsx");
    expect(src).toContain('{ name: "pr", desc:');
    expect(src).toContain('case "pr": {');
    expect(src).toContain("const outcome = await runPr({");
    expect(src).toContain("ask: askUserRef?.current ?? null,");
  });

  test("/pr is NOT mid-turn safe — it mutates the repo, so it must queue", () => {
    const src = readSource("tui/prompt_queue.ts");
    expect(src).not.toContain('"pr"');
  });
});
