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

/**
 * Unwrap the two scalar forms real skills use beyond a bare word. Skill Seekers JSON-quotes
 * any value containing `:` or `#` (most generated descriptions are sentences with a colon),
 * and the Anthropic skill convention writes long descriptions as a folded block. Read as bare
 * text, the first keeps its quotes and the second collapses to ">" — which is what the model
 * would then see in the skill listing.
 */
function scalar(value: string, continuation: string[]): string {
  if (value === ">" || value === ">-" || value === "|" || value === "|-") {
    // Folded (>) joins lines with spaces; literal (|) keeps them. Either way the indent goes.
    const lines = continuation.map((l) => l.trim());
    return (value[0] === "|" ? lines.join("\n") : lines.join(" ")).trim();
  }
  if (value.length > 1 && value[0] === '"' && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length > 1 && value[0] === "'" && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

export function parseSkillMd(
  text: string,
): { name: string; description: string; body: string; hidden: boolean } | { error: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { error: "missing frontmatter (--- name/description ---)" };
  const fields: Record<string, string> = {};
  const lines = (m[1] ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s/.test(line)) continue; // continuation of the previous key — consumed below
    const c = line.indexOf(":");
    if (c <= 0) continue;
    const continuation: string[] = [];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j] ?? ""); j++) {
      continuation.push(lines[j] ?? "");
    }
    fields[line.slice(0, c).trim()] = scalar(line.slice(c + 1).trim(), continuation);
  }
  const name = fields.name ?? "";
  const description = fields.description ?? "";
  if (!NAME_RE.test(name)) return { error: `invalid or missing name: "${name}"` };
  if (!description) return { error: "missing description" };
  return { name, description, body: (m[2] ?? "").trim(), hidden: fields.hidden === "true" };
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
      if (parsed.hidden) continue;
      const { name, description, body } = parsed;
      skills.push({ name, description, body, dir, source: root.source });
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

// ------------------------------------------------------------------ current scan
/**
 * The scan every consumer reads, in the module-level-store pattern of `agent/modes.ts` and
 * `tui/badge_slot.ts`. main.ts seeds it at startup and `/skills` replaces it on rescan;
 * spawn.ts reads it when it builds a child, so a sub-agent delegated a skill gets the same
 * catalogue the lead sees — including one installed mid-session.
 */
let discovered: DiscoveredSkill[] = [];

export function setDiscoveredSkills(skills: DiscoveredSkill[]): void {
  discovered = skills;
}

export function getDiscoveredSkills(): DiscoveredSkill[] {
  return discovered;
}

export function skillsListText(scan: SkillScan): string {
  const lines = scan.skills.length
    ? scan.skills.map((s) => `  /${s.name.padEnd(16)} ${s.description}  [${s.source}]`)
    : ["  (none found — add .minima/skills/<name>/SKILL.md, then /skills again)"];
  const warnings = scan.warnings.map((w) => `  ⚠ ${w}`);
  return ["Skills:", ...lines, ...warnings].join("\n");
}
