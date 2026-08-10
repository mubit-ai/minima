# TUI Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code-style SKILL.md packs for the minima TUI: discovered from disk at startup, listed to the model inside a `skill` tool's description, loaded on demand, and invocable by the user as `/<skill-name>`.

**Architecture:** One new pure module `packages/tui/src/skills.ts` (frontmatter parse + four-root discovery + slash-expansion helper), one new tool factory `packages/tui/src/tools/skill.ts` registered through `builtinTools` behind an optional `skills` opt (absent = tool not registered, so sub-agents in `spawn.ts` never get it), and small wiring edits in `src/cli/main.ts` (discover + pass to builtinTools) and `src/tui/app.tsx` (`/skills` command + `/<skill-name>` prompt expansion in `submitLine`).

**Tech Stack:** Bun + TypeScript (strict tsc), `bun:test`, biome. No new dependencies — frontmatter parsing is a ~20-line in-module parser.

**Spec:** `docs/superpowers/specs/2026-07-31-tui-skills-design.md`

## Global Constraints

- All work in `packages/tui/`. Run commands from that directory.
- Tests hermetic: temp dirs via `mkdtempSync(join(tmpdir(), ...))`, no network, no real `$HOME` reads in tests (discovery takes an explicit `home` param).
- No comments in code unless load-bearing (repo convention).
- Gates before every commit: `bun test <new files>`, and in the final task the full `bun test`, `bun run check`, `bun run lint`.
- Discovery precedence (first name wins): `<cwd>/.minima/skills` → `<home>/.minima-harness/skills` → `<cwd>/.claude/skills` → `<home>/.claude/skills`.
- Malformed skills are skipped with a warning string, never thrown.
- Branch: `feat/tui-skills` (already exists, spec committed).

---

### Task 1: Discovery module (`src/skills.ts`)

**Files:**
- Create: `packages/tui/src/skills.ts`
- Test: `packages/tui/tests/skills.test.ts`

**Interfaces:**
- Consumes: nothing project-internal (only `node:fs`, `node:os`, `node:path`).
- Produces (later tasks rely on these exact shapes):

```ts
export interface DiscoveredSkill {
  name: string;
  description: string;
  body: string;   // SKILL.md content with frontmatter stripped, trimmed
  dir: string;    // absolute skill directory
  source: string; // "project" | "global" | "claude-project" | "claude-global"
}
export interface SkillScan {
  skills: DiscoveredSkill[];
  warnings: string[];
}
export function parseSkillMd(text: string):
  | { name: string; description: string; body: string }
  | { error: string };
export function discoverSkills(cwd: string, home?: string): SkillScan; // home defaults to homedir()
```

- [ ] **Step 1: Write the failing tests**

Create `packages/tui/tests/skills.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, parseSkillMd } from "../src/skills.ts";

function writeSkill(root: string, name: string, frontName = name, desc = `${name} desc`) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${frontName}\ndescription: ${desc}\n---\nDo the ${name} thing.\n`,
  );
  return dir;
}

describe("parseSkillMd", () => {
  test("parses name, description, body", () => {
    const r = parseSkillMd("---\nname: deploy\ndescription: Ship it\n---\nStep 1.\nStep 2.\n");
    expect(r).toEqual({ name: "deploy", description: "Ship it", body: "Step 1.\nStep 2." });
  });

  test("ignores unknown frontmatter keys", () => {
    const r = parseSkillMd("---\nname: a\ndescription: b\nallowed-tools: bash\n---\nbody");
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.name).toBe("a");
  });

  test("missing frontmatter -> error", () => {
    expect("error" in parseSkillMd("just a doc")).toBe(true);
  });

  test("missing description -> error", () => {
    expect("error" in parseSkillMd("---\nname: a\n---\nbody")).toBe(true);
  });

  test("name with spaces -> error", () => {
    expect("error" in parseSkillMd("---\nname: two words\ndescription: d\n---\nbody")).toBe(true);
  });
});

describe("discoverSkills", () => {
  test("finds skills across all four roots", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sk-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "sk-home-"));
    writeSkill(join(cwd, ".minima", "skills"), "a");
    writeSkill(join(home, ".minima-harness", "skills"), "b");
    writeSkill(join(cwd, ".claude", "skills"), "c");
    writeSkill(join(home, ".claude", "skills"), "d");
    const scan = discoverSkills(cwd, home);
    expect(scan.skills.map((s) => [s.name, s.source])).toEqual([
      ["a", "project"],
      ["b", "global"],
      ["c", "claude-project"],
      ["d", "claude-global"],
    ]);
    expect(scan.warnings).toEqual([]);
  });

  test("first occurrence of a name wins (project shadows claude)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sk-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "sk-home-"));
    writeSkill(join(cwd, ".minima", "skills"), "dup", "dup", "project version");
    writeSkill(join(cwd, ".claude", "skills"), "dup", "dup", "claude version");
    const scan = discoverSkills(cwd, home);
    expect(scan.skills).toHaveLength(1);
    expect(scan.skills[0]?.description).toBe("project version");
  });

  test("frontmatter name wins over directory name", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sk-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "sk-home-"));
    writeSkill(join(cwd, ".minima", "skills"), "dirname", "realname");
    const scan = discoverSkills(cwd, home);
    expect(scan.skills[0]?.name).toBe("realname");
  });

  test("malformed skill -> skipped with warning, others survive", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sk-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "sk-home-"));
    const root = join(cwd, ".minima", "skills");
    writeSkill(root, "good");
    mkdirSync(join(root, "bad"), { recursive: true });
    writeFileSync(join(root, "bad", "SKILL.md"), "no frontmatter here");
    mkdirSync(join(root, "empty"), { recursive: true }); // no SKILL.md at all
    const scan = discoverSkills(cwd, home);
    expect(scan.skills.map((s) => s.name)).toEqual(["good"]);
    expect(scan.warnings).toHaveLength(1);
    expect(scan.warnings[0]).toContain("bad");
  });

  test("no roots exist -> empty scan, no throw", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sk-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "sk-home-"));
    expect(discoverSkills(cwd, home)).toEqual({ skills: [], warnings: [] });
  });

  test("dir is absolute and body is frontmatter-stripped", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sk-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "sk-home-"));
    const dir = writeSkill(join(cwd, ".minima", "skills"), "a");
    const s = discoverSkills(cwd, home).skills[0];
    expect(s?.dir).toBe(dir);
    expect(s?.body).toBe("Do the a thing.");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tui && bun test tests/skills.test.ts`
Expected: FAIL — cannot resolve `../src/skills.ts`.

- [ ] **Step 3: Implement `src/skills.ts`**

```ts
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface DiscoveredSkill {
  name: string;
  description: string;
  body: string;
  dir: string;
  source: string;
}

export interface SkillScan {
  skills: DiscoveredSkill[];
  warnings: string[];
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function parseSkillMd(
  text: string,
): { name: string; description: string; body: string } | { error: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { error: "missing frontmatter (--- name/description ---)" };
  const fields: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const name = fields.name ?? "";
  const description = fields.description ?? "";
  if (!NAME_RE.test(name)) return { error: `invalid or missing name: "${name}"` };
  if (!description) return { error: "missing description" };
  return { name, description, body: (m[2] ?? "").trim() };
}

function skillRoots(cwd: string, home: string): { dir: string; source: string }[] {
  return [
    { dir: resolve(cwd, ".minima", "skills"), source: "project" },
    { dir: resolve(home, ".minima-harness", "skills"), source: "global" },
    { dir: resolve(cwd, ".claude", "skills"), source: "claude-project" },
    { dir: resolve(home, ".claude", "skills"), source: "claude-global" },
  ];
}

export function discoverSkills(cwd: string, home: string = homedir()): SkillScan {
  const skills: DiscoveredSkill[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const root of skillRoots(cwd, home)) {
    let entries: string[];
    try {
      entries = readdirSync(root.dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const dir = resolve(root.dir, entry);
      let raw: string;
      try {
        raw = readFileSync(resolve(dir, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const parsed = parseSkillMd(raw);
      if ("error" in parsed) {
        warnings.push(`skipped ${dir}: ${parsed.error}`);
        continue;
      }
      if (seen.has(parsed.name)) continue;
      seen.add(parsed.name);
      skills.push({ ...parsed, dir, source: root.source });
    }
  }
  return { skills, warnings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/tui && bun test tests/skills.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/skills.ts packages/tui/tests/skills.test.ts
git commit -m "feat(tui): skill discovery — SKILL.md packs from four roots"
```

---

### Task 2: The `skill` tool (`src/tools/skill.ts`) + registry opt

**Files:**
- Create: `packages/tui/src/tools/skill.ts`
- Modify: `packages/tui/src/tools/builtin.ts` (add `skills?` to `BuiltinToolsOptions`, conditionally push the tool)
- Test: `packages/tui/tests/skill-tool.test.ts`

**Interfaces:**
- Consumes: `DiscoveredSkill` from Task 1; `AgentTool`, `errorResult` from `src/agent/tools.ts`; `text` from `src/ai/types.ts`; `objectSchema` from `src/tools/schema.ts`.
- Produces: `export function skillTool(skills: DiscoveredSkill[]): AgentTool` — tool name `"skill"`, required string param `name`. `builtinTools({ skills })` registers it only when `skills` is a non-empty array (sub-agents in `spawn.ts` pass nothing → never get it).

- [ ] **Step 1: Write the failing tests**

Create `packages/tui/tests/skill-tool.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { DiscoveredSkill } from "../src/skills.ts";
import { builtinTools } from "../src/tools/builtin.ts";
import { skillTool } from "../src/tools/skill.ts";

const SKILLS: DiscoveredSkill[] = [
  { name: "deploy", description: "Ship to prod", body: "Run make deploy.", dir: "/tmp/sk/deploy", source: "project" },
  { name: "review", description: "Review a PR", body: "Read the diff.", dir: "/tmp/sk/review", source: "global" },
];

function textOf(r: { content: { type: string; text?: string }[] }): string {
  return r.content.map((b) => ("text" in b ? b.text : "")).join("");
}

describe("skillTool", () => {
  test("description lists every skill name + description", () => {
    const t = skillTool(SKILLS);
    expect(t.name).toBe("skill");
    expect(t.description).toContain("deploy — Ship to prod");
    expect(t.description).toContain("review — Review a PR");
  });

  test("loads a skill: body + dir in the result", async () => {
    const r = await skillTool(SKILLS).execute("tc1", { name: "deploy" }, null, null);
    const out = textOf(r);
    expect(out).toContain("Run make deploy.");
    expect(out).toContain("/tmp/sk/deploy");
    expect(r.details?.error).toBeUndefined();
  });

  test("unknown name -> error result listing valid names", async () => {
    const r = await skillTool(SKILLS).execute("tc2", { name: "nope" }, null, null);
    expect(r.details?.error).toBeDefined();
    expect(textOf(r)).toContain("deploy");
  });
});

describe("builtinTools skills opt", () => {
  test("registered only when skills present and non-empty", () => {
    const names = (opts: Parameters<typeof builtinTools>[0]) =>
      builtinTools(opts).map((t) => t.name);
    expect(names({})).not.toContain("skill");
    expect(names({ skills: [] })).not.toContain("skill");
    expect(names({ skills: SKILLS })).toContain("skill");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tui && bun test tests/skill-tool.test.ts`
Expected: FAIL — cannot resolve `../src/tools/skill.ts`.

- [ ] **Step 3: Implement `src/tools/skill.ts`**

```ts
import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import type { DiscoveredSkill } from "../skills.ts";
import { objectSchema } from "./schema.ts";

export function skillTool(skills: DiscoveredSkill[]): AgentTool {
  const listing = skills.map((s) => `- ${s.name} — ${s.description}`).join("\n");
  return {
    name: "skill",
    description:
      "Load a skill: a pack of instructions for a specific kind of task. When a listed " +
      "skill matches the task at hand, call this BEFORE doing the work and follow the " +
      "loaded instructions. Support files referenced by a skill live in its directory — " +
      `read them with the read tool.\n\nAvailable skills:\n${listing}`,
    parameters: objectSchema(
      { name: { type: "string", description: "Name of the skill to load." } },
      ["name"],
    ),
    async execute(_toolCallId, params): Promise<ToolResult> {
      const name = params.name as string;
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        return errorResult(
          `skill: unknown skill "${name}". Available: ${skills.map((s) => s.name).join(", ")}`,
        );
      }
      return {
        content: [
          text(
            `Skill "${skill.name}" (directory: ${skill.dir})\n` +
              `Follow these instructions. Relative paths resolve against the directory above.\n\n` +
              skill.body,
          ),
        ],
        details: { skill: skill.name, dir: skill.dir },
      };
    },
  };
}
```

- [ ] **Step 4: Wire into `builtinTools`**

In `packages/tui/src/tools/builtin.ts`:

1. Add imports: `import { skillTool } from "./skill.ts";` and `import type { DiscoveredSkill } from "../skills.ts";`
2. Add to `BuiltinToolsOptions` (after `bgJobs?`), with a doc comment matching the style of its siblings:

```ts
  /**
   * Discovered SKILL.md packs. Present and non-empty = the `skill` tool is registered with
   * the list embedded in its description. The LEAD agent's main.ts passes the startup scan;
   * sub-agents (spawn.ts) never pass one, so they run without skills.
   */
  skills?: DiscoveredSkill[];
```

3. In `builtinTools`, next to the existing conditional push:

```ts
  if (opts.bgJobs) all.push(bgJobTool(opts.bgJobs));
  if (opts.skills?.length) all.push(skillTool(opts.skills));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/tui && bun test tests/skill-tool.test.ts tests/skills.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/tui/src/tools/skill.ts packages/tui/src/tools/builtin.ts packages/tui/tests/skill-tool.test.ts
git commit -m "feat(tui): skill tool — on-demand SKILL.md loading via builtinTools opt"
```

---

### Task 3: Slash-expansion helpers (pure, in `src/skills.ts`)

**Files:**
- Modify: `packages/tui/src/skills.ts` (append two functions)
- Test: `packages/tui/tests/skills.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `DiscoveredSkill`, `SkillScan` from Task 1.
- Produces (Task 4 calls exactly these):

```ts
export function skillInvocationPrompt(
  name: string,
  args: string,
  skills: DiscoveredSkill[],
  builtinNames: string[],
): string | null; // null = not a skill invocation (builtin collision or unknown name)
export function skillsListText(scan: SkillScan): string; // /skills output
```

- [ ] **Step 1: Write the failing tests**

Append to `packages/tui/tests/skills.test.ts`:

```ts
import { skillInvocationPrompt, skillsListText } from "../src/skills.ts";

const SK = [
  { name: "deploy", description: "Ship it", body: "b", dir: "/d", source: "project" },
  { name: "plan", description: "Shadowed", body: "b", dir: "/p", source: "claude-project" },
];

describe("skillInvocationPrompt", () => {
  test("known skill -> prompt naming the skill tool", () => {
    const p = skillInvocationPrompt("deploy", "", SK, ["help", "plan"]);
    expect(p).toContain('skill');
    expect(p).toContain('"deploy"');
  });

  test("trailing args are passed through", () => {
    const p = skillInvocationPrompt("deploy", "staging --fast", SK, []);
    expect(p).toContain("staging --fast");
  });

  test("builtin command always wins", () => {
    expect(skillInvocationPrompt("plan", "", SK, ["help", "plan"])).toBeNull();
  });

  test("unknown name -> null", () => {
    expect(skillInvocationPrompt("nope", "", SK, [])).toBeNull();
  });
});

describe("skillsListText", () => {
  test("lists names, descriptions, sources, and warnings", () => {
    const t = skillsListText({ skills: SK, warnings: ["skipped /x: bad"] });
    expect(t).toContain("deploy");
    expect(t).toContain("Ship it");
    expect(t).toContain("project");
    expect(t).toContain("skipped /x: bad");
  });

  test("empty scan explains where skills go", () => {
    expect(skillsListText({ skills: [], warnings: [] })).toContain(".minima/skills");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tui && bun test tests/skills.test.ts`
Expected: FAIL — `skillInvocationPrompt` not exported.

- [ ] **Step 3: Implement (append to `src/skills.ts`)**

```ts
export function skillInvocationPrompt(
  name: string,
  args: string,
  skills: DiscoveredSkill[],
  builtinNames: string[],
): string | null {
  if (builtinNames.includes(name)) return null;
  const skill = skills.find((s) => s.name === name);
  if (!skill) return null;
  const base = `Invoke the "skill" tool with name "${skill.name}", then follow the loaded instructions.`;
  return args ? `${base}\n\nArguments: ${args}` : base;
}

export function skillsListText(scan: SkillScan): string {
  const lines = scan.skills.length
    ? scan.skills.map((s) => `  /${s.name.padEnd(16)} ${s.description}  [${s.source}]`)
    : ["  (none found — add .minima/skills/<name>/SKILL.md and restart)"];
  const warnings = scan.warnings.map((w) => `  ⚠ ${w}`);
  return ["Skills:", ...lines, ...warnings].join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/tui && bun test tests/skills.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/skills.ts packages/tui/tests/skills.test.ts
git commit -m "feat(tui): skill slash-expansion + /skills listing helpers"
```

---

### Task 4: Wiring — `main.ts` registration + `app.tsx` slash commands, full gates

**Files:**
- Modify: `packages/tui/src/cli/main.ts` (`toolsFor`, ~line 566)
- Modify: `packages/tui/src/tui/app.tsx` (`COMMANDS` ~line 296; `submitLine` ~line 4348; `handleCommand` switch before `default:` ~line 4121)

**Interfaces:**
- Consumes: `discoverSkills`, `skillInvocationPrompt`, `skillsListText` (Tasks 1+3); `skills` opt on `builtinTools` (Task 2).
- Produces: user-visible `/skills` and `/<skill-name>`; `skill` tool live on the lead agent.

No new unit test file — the logic here is one-line glue over the pure helpers already tested in Tasks 1–3; the gates are the full suite + typecheck + lint. (An ink render test of `submitLine` would re-test the helpers through a far more brittle harness.)

- [ ] **Step 1: Wire `main.ts`**

In `packages/tui/src/cli/main.ts`, add `import { discoverSkills } from "../skills.ts";` and edit `toolsFor` so the builtinTools call passes the scan:

```ts
  let tools = args.noTools
    ? []
    : builtinTools({
        bigPlan,
        todoState,
        onWebSearchFeeUsd,
        artifacts,
        seen,
        bgJobs,
        skills: discoverSkills(process.cwd()).skills,
      });
```

- [ ] **Step 2: Wire `app.tsx`**

1. Imports: `import { discoverSkills, skillInvocationPrompt, skillsListText } from "../skills.ts";` (plus `useMemo` if not already imported).
2. `COMMANDS` array (~line 296), add:

```ts
  { name: "skills", desc: "List discovered skills (SKILL.md packs)" },
```

3. Inside the `App` component, near the other top-of-component hooks:

```ts
  const skillScan = useMemo(() => discoverSkills(process.cwd()), []);
```

4. In `submitLine` (~line 4348), the slash branch becomes:

```ts
    let prompt = text;
    if (trimmed.startsWith("/")) {
      const firstSpace = trimmed.indexOf(" ");
      const name = firstSpace !== -1 ? trimmed.slice(1, firstSpace) : trimmed.slice(1);
      const args = firstSpace !== -1 ? trimmed.slice(firstSpace + 1).trim() : "";
      const skillPrompt = skillInvocationPrompt(
        name,
        args,
        skillScan.skills,
        COMMANDS.map((c) => c.name),
      );
      if (skillPrompt === null) {
        await handleCommand(name, args);
        return;
      }
      prompt = skillPrompt;
    }
```

Then, further down in the same function, the two places that feed the model switch from `text` to `prompt` (biome's `noParameterAssign` forbids reassigning `text` itself):

- `await handlePlanTurn(text);` → `await handlePlanTurn(prompt);`
- `const expanded = expandAtFiles(text, process.cwd());` → `const expanded = expandAtFiles(prompt, process.cwd());`

The optimistic echo (`setMessages(... { role: "user", text: trimmed })`) stays on `trimmed`, so the user sees the `/<name> …` they typed while the model receives the expanded skill prompt.

5. In `handleCommand`'s switch, immediately before `default:` (~line 4121), add:

```ts
      case "skills": {
        setMessages((m) => [
          ...m,
          { role: "user", text: `/${name}` },
          { role: "tool", toolName: "skills", text: skillsListText(skillScan) },
        ]);
        break;
      }
```

- [ ] **Step 3: Run the full gates**

```bash
cd packages/tui && bun test && bun run check && bun run lint
```

Expected: all pass. If biome objects to formatting, run `bun run format` and re-run lint.

- [ ] **Step 4: Manual smoke (optional but cheap)**

```bash
mkdir -p /tmp/sk-demo/.minima/skills/hello
printf -- '---\nname: hello\ndescription: Say hello\n---\nReply with exactly: hello from the skill\n' > /tmp/sk-demo/.minima/skills/hello/SKILL.md
```

Then from `/tmp/sk-demo`, run the TUI, type `/skills` (expect the listing) and `/hello` (expect the agent to call the `skill` tool).

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/cli/main.ts packages/tui/src/tui/app.tsx
git commit -m "feat(tui): wire skills — /skills list, /<name> invocation, lead-agent skill tool"
```
