import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSkills,
  parseSkillMd,
  skillInvocationPrompt,
  skillsListText,
} from "../src/skills.ts";

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
    expect(r).toEqual({
      name: "deploy",
      description: "Ship it",
      body: "Step 1.\nStep 2.",
      hidden: false,
    });
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

  // Skill Seekers JSON-quotes any value containing ":" or "#" — which is most of the
  // descriptions it generates. Read as bare text they keep their quotes.
  test("double-quoted scalar is unquoted", () => {
    const r = parseSkillMd('---\nname: godot\ndescription: "Godot 4.x: the engine"\n---\nbody');
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.description).toBe("Godot 4.x: the engine");
  });

  test("single-quoted scalar is unquoted", () => {
    const r = parseSkillMd("---\nname: a\ndescription: 'it''s fine'\n---\nbody");
    if (!("error" in r)) expect(r.description).toBe("it's fine");
  });

  // The Anthropic skill convention writes long descriptions as a folded block; read
  // line-wise the description collapses to ">" and the real text is dropped.
  test("folded (>) scalar joins its continuation lines", () => {
    const r = parseSkillMd(
      "---\nname: a\ndescription: >\n  Cuts tokens 65%.\n  Use when: user says caveman.\nhidden: false\n---\nbody",
    );
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.description).toBe("Cuts tokens 65%. Use when: user says caveman.");
      expect(r.hidden).toBe(false);
      expect(r.body).toBe("body");
    }
  });

  test("literal (|) scalar keeps its line breaks", () => {
    const r = parseSkillMd("---\nname: a\ndescription: |\n  one\n  two\n---\nbody");
    if (!("error" in r)) expect(r.description).toBe("one\ntwo");
  });

  test("a folded description does not swallow the next key", () => {
    const r = parseSkillMd("---\ndescription: >\n  wrapped\nname: keep-me\n---\nbody");
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.name).toBe("keep-me");
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

  test("hidden shadow claims the name and hides the lower-precedence skill", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sk-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "sk-home-"));
    const dir = join(home, ".minima-harness", "skills", "dup");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: dup\ndescription: tombstone\nhidden: true\n---\nhidden\n",
    );
    writeSkill(join(home, ".claude", "skills"), "dup");
    writeSkill(join(home, ".claude", "skills"), "kept");
    const scan = discoverSkills(cwd, home);
    expect(scan.skills.map((s) => s.name)).toEqual(["kept"]);
    expect(scan.warnings).toEqual([]);
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

const SK = [
  { name: "deploy", description: "Ship it", body: "b", dir: "/d", source: "project" },
  { name: "plan", description: "Shadowed", body: "b", dir: "/p", source: "claude-project" },
];

describe("skillInvocationPrompt", () => {
  test("known skill -> prompt naming the skill tool", () => {
    const p = skillInvocationPrompt("deploy", "", SK, ["help", "plan"]);
    expect(p).toContain("skill");
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

// The rescan lives in app.tsx's /skills case (React, no headless harness) — pinned at the
// source level like the other app.tsx behaviors, so the wiring can't silently regress.
describe("/skills rescan", () => {
  test("re-runs discovery and re-registers the skill tool", async () => {
    const { readSource } = await import("./_source.ts");
    const app = readSource("tui/app.tsx");
    expect(app).toContain("const scan = discoverSkills(process.cwd());");
    expect(app).toContain("setSkillScan(scan)");
    expect(app).toContain("skillTool(scan.skills)");
    expect(app).toContain('t.name !== "skill"');
  });
});
