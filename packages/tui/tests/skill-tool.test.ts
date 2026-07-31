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
