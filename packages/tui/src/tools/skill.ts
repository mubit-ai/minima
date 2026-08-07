import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import type { DiscoveredSkill } from "../skills.ts";
import { objectSchema } from "./schema.ts";

/**
 * Per-skill cap on the listed description. The listing ships in the tool schema on EVERY
 * request, and a generated skill's description is whatever its generator scraped — Skill
 * Seekers writes one from the source document. Unbounded, one verbose skill taxes every turn.
 */
const DESC_CAP = 240;

export function skillTool(skills: DiscoveredSkill[]): AgentTool {
  const listing = skills
    .map((s) => {
      const d = s.description.replaceAll(/\s+/g, " ").trim();
      return `- ${s.name} — ${d.length > DESC_CAP ? `${d.slice(0, DESC_CAP - 1).trimEnd()}…` : d}`;
    })
    .join("\n");
  return {
    name: "skill",
    description: `Load a skill: a pack of instructions for a specific kind of task. When a listed skill matches the task at hand, call this BEFORE doing the work and follow the loaded instructions. Support files referenced by a skill live in its directory — read them with the read tool.\n\nAvailable skills:\n${listing}`,
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
            `Skill "${skill.name}" (directory: ${skill.dir})\nFollow these instructions. Relative paths resolve against the directory above.\n\n${skill.body}`,
          ),
        ],
        details: { skill: skill.name, dir: skill.dir },
      };
    },
  };
}
