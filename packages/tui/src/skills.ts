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
