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

describe("listed descriptions are bounded", () => {
  // The listing ships in the tool schema on every request, and a generated skill's
  // description is whatever its generator scraped — it must not be able to tax every turn.
  test("a long description is collapsed and truncated, the body is not", () => {
    const long = {
      name: "scraped",
      description: `${"word ".repeat(400)}\n\nsecond paragraph`,
      body: "x".repeat(5000),
      dir: "/tmp/sk/scraped",
      source: "claude-global",
    };
    const desc = skillTool([long]).description;
    expect(desc).not.toContain("\n\nsecond paragraph");
    expect(desc.split("Available skills:")[1]!.trim().length).toBeLessThan(300);
    expect(desc).toContain("…");
  });

  test("a short description is passed through untouched", () => {
    expect(skillTool(SKILLS).description).toContain("- deploy — Ship to prod");
  });
});
