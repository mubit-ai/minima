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
