/**
 * User-defined agent types: frontmatter parsing, the on-disk registry, delegation-field
 * resolution, authoring-time validation, the task tool's advertised menu, the `## Role`
 * prompt section, the plan-step preset, and the in-progress step's routing pool.
 *
 * Hermetic: temp dirs + MINIMA_HARNESS_DIR for the global seam, mock fetch + faux provider
 * for anything that spawns. No network, no spend, no reads of the developer's real home.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssistantMessage,
  type FauxRegistration,
  type Model,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
} from "../src/ai/index.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  type AgentType,
  type AgentTypeRegistry,
  agentTypePlanPreset,
  applyAgentType,
  loadAgentTypes,
  parseAgentType,
  parseFrontmatter,
  scaffoldAgentType,
  spawnableToolNames,
} from "../src/minima/agent_types.ts";
import {
  ConstJudge,
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";
import { finalizePlan } from "../src/minima/plan_finalize.ts";
import { type BigPlanSynthesis, PlanSessionStore } from "../src/minima/plan_session.ts";
import { createSpawn, delegationPrompt } from "../src/minima/spawn.ts";
import { KNOWN_TOOLS } from "../src/minima/tool_permissions.ts";
import { builtinTools } from "../src/tools/builtin.ts";
import {
  type Delegation,
  type SpawnContext,
  taskTool,
  validateDelegations,
} from "../src/tools/task.ts";
import { newAgentDraft, wizardAdvance } from "../src/tui/agent_wizard.ts";
import { agentTypeMatches } from "../src/tui/app.tsx";
import { decideBusySubmit } from "../src/tui/prompt_queue.ts";

const SPAWNABLE = spawnableToolNames();

function registry(...types: AgentType[]): AgentTypeRegistry {
  return { types: new Map(types.map((t) => [t.name, t])), warnings: [] };
}

const REVIEWER: AgentType = {
  name: "reviewer",
  description: "Reviews a diff. Read-only.",
  prompt: "You review code for correctness only. Never propose refactors.",
  tools: ["read", "grep"],
  candidates: ["claude-x"],
  effort: "light",
  budget_usd: 0.25,
};

// ------------------------------------------------------------------ parseFrontmatter

describe("parseFrontmatter", () => {
  test("no fence — everything is body", () => {
    expect(parseFrontmatter("# hi\nbody\n")).toEqual({
      meta: {},
      body: "# hi\nbody\n",
      malformed: false,
    });
  });

  test("a well-formed fence yields typed values and the remaining body", () => {
    const r = parseFrontmatter("---\nname: x\ncount: 3\nlist: [a, b]\n---\nbody\n");
    expect(r.meta).toEqual({ name: "x", count: 3, list: ["a", "b"] });
    expect(r.body).toBe("body\n");
  });

  test("a `---` horizontal rule inside the body is NOT a fence", () => {
    const src = "# hi\n\n---\n\nmore\n";
    expect(parseFrontmatter(src)).toEqual({ meta: {}, body: src, malformed: false });
  });

  test("CRLF line endings parse", () => {
    const r = parseFrontmatter("---\r\nname: x\r\n---\r\nbody\r\n");
    expect(r.meta).toEqual({ name: "x" });
    expect(r.body).toBe("body\r\n");
  });

  test("malformed YAML fails closed to no-frontmatter rather than throwing", () => {
    const src = "---\nname: [1,\n---\nbody\n";
    const r = parseFrontmatter(src);
    expect(r.meta).toEqual({});
    expect(r.malformed).toBe(true);
  });

  test("a scalar or list document is not a map — meta stays empty AND malformed is set", () => {
    for (const src of ["---\njustastring\n---\nbody\n", "---\n- a\n- b\n---\nbody\n"]) {
      const r = parseFrontmatter(src);
      expect(r.meta).toEqual({});
      expect(r.malformed).toBe(true);
    }
  });

  test("an empty fence is a fence (empty meta, body after it)", () => {
    expect(parseFrontmatter("---\n---\nbody\n")).toEqual({
      meta: {},
      body: "body\n",
      malformed: false,
    });
  });

  test("a fence not at byte 0 is body text", () => {
    const src = "\n---\nname: x\n---\nbody\n";
    expect(parseFrontmatter(src)).toEqual({ meta: {}, body: src, malformed: false });
  });

  test("a document that is only frontmatter yields an empty body", () => {
    expect(parseFrontmatter("---\nname: x\n---\n")).toEqual({
      meta: { name: "x" },
      body: "",
      malformed: false,
    });
  });
});

// ------------------------------------------------------------------ parseAgentType

describe("parseAgentType", () => {
  const parse = (file: string, src: string) => parseAgentType(file, src, { spawnable: SPAWNABLE });

  test("full definition — every field lands, no warnings", () => {
    const { type, warnings } = parse(
      "reviewer.md",
      [
        "---",
        "name: reviewer",
        "description: Reviews a diff.",
        "tools: [read, grep]",
        "candidates: [claude-x, gpt-x]",
        "effort: light",
        "budget_usd: 0.25",
        "isolation: workdir",
        "---",
        "You review code.",
      ].join("\n"),
    );
    expect(warnings).toEqual([]);
    expect(type).toEqual({
      name: "reviewer",
      description: "Reviews a diff.",
      prompt: "You review code.",
      tools: ["read", "grep"],
      candidates: ["claude-x", "gpt-x"],
      effort: "light",
      budget_usd: 0.25,
      isolation: "workdir",
    });
  });

  test("the filename is the name when frontmatter omits one, and the name is lowercased", () => {
    expect(parse("Fixer.md", "---\ndescription: d\n---\nbody").type?.name).toBe("fixer");
    expect(parse("x.md", "---\nname: ReViewer\ndescription: d\n---\nbody").type?.name).toBe(
      "reviewer",
    );
  });

  test("an invalid name is rejected outright", () => {
    for (const bad of ["my agent", "-lead", "a/b", ""]) {
      const { type, warnings } = parse(`${bad}.md`, "---\ndescription: d\n---\nbody");
      expect(type).toBeNull();
      expect(warnings.join(" ")).toContain("invalid agent name");
    }
  });

  test("an unknown frontmatter key warns but does not reject (typo catcher)", () => {
    const { type, warnings } = parse(
      "a.md",
      "---\nname: a\ndescription: d\nmodel: claude-x\n---\nbody",
    );
    expect(type).not.toBeNull();
    expect(warnings.join(" ")).toContain('unknown frontmatter key "model"');
  });

  test("a missing description warns — the lead picks types by description", () => {
    const { type, warnings } = parse("a.md", "---\nname: a\n---\nbody");
    expect(type?.description).toBe("");
    expect(warnings.join(" ")).toContain("no \"description\"");
  });

  test("an unknown tool name warns and is dropped; the valid ones survive", () => {
    const { type, warnings } = parse(
      "a.md",
      "---\nname: a\ndescription: d\ntools: [read, bogus, GREP]\n---\nbody",
    );
    expect(type?.tools).toEqual(["read", "grep"]);
    expect(warnings.join(" ")).toContain("unknown tool");
    expect(warnings.join(" ")).toContain("bogus");
  });

  test("an allowlist of ONLY unknown tools rejects the type — it would spawn a toolless agent", () => {
    const { type, warnings } = parse(
      "a.md",
      "---\nname: a\ndescription: d\ntools: [bogus, alsobogus]\n---\nbody",
    );
    expect(type).toBeNull();
    expect(warnings.join(" ")).toContain("no usable tool");
  });

  test("`task` is not spawnable — a type cannot grant a child the ability to delegate", () => {
    expect(SPAWNABLE.has("task")).toBe(false);
    const { type } = parse("a.md", "---\nname: a\ndescription: d\ntools: [read, task]\n---\nbody");
    expect(type?.tools).toEqual(["read"]);
  });

  test("non-list tools/candidates warn and are ignored", () => {
    const a = parse("a.md", "---\nname: a\ndescription: d\ntools: read\n---\nbody");
    expect(a.type?.tools).toBeUndefined();
    expect(a.warnings.join(" ")).toContain('"tools" must be a list');
    const b = parse("b.md", "---\nname: b\ndescription: d\ncandidates: claude-x\n---\nbody");
    expect(b.type?.candidates).toBeUndefined();
    expect(b.warnings.join(" ")).toContain('"candidates" must be a list');
  });

  test("candidates keep their case — model ids are case-sensitive", () => {
    const { type } = parse(
      "a.md",
      "---\nname: a\ndescription: d\ncandidates: [Claude-X, ' gpt-x ']\n---\nbody",
    );
    expect(type?.candidates).toEqual(["Claude-X", "gpt-x"]);
  });

  test("an invalid effort / isolation / budget warns and is ignored, not fatal", () => {
    const { type, warnings } = parse(
      "a.md",
      [
        "---",
        "name: a",
        "description: d",
        "effort: extreme",
        "isolation: chroot",
        "budget_usd: -1",
        "---",
        "body",
      ].join("\n"),
    );
    expect(type).not.toBeNull();
    expect(type?.effort).toBeUndefined();
    expect(type?.isolation).toBeUndefined();
    expect(type?.budget_usd).toBeUndefined();
    const joined = warnings.join(" ");
    expect(joined).toContain('"effort" must be');
    expect(joined).toContain('"isolation" must be');
    expect(joined).toContain('"budget_usd" must be');
  });

  test("budget_usd of 0 is rejected — a zero cap is a stuck agent, not a cheap one", () => {
    const { type } = parse("a.md", "---\nname: a\ndescription: d\nbudget_usd: 0\n---\nbody");
    expect(type?.budget_usd).toBeUndefined();
  });

  test("a numeric-string budget is accepted", () => {
    const { type } = parse("a.md", "---\nname: a\ndescription: d\nbudget_usd: '0.5'\n---\nbody");
    expect(type?.budget_usd).toBe(0.5);
  });

  test("an empty definition (no body, no presets) is skipped", () => {
    const { type, warnings } = parse("a.md", "---\nname: a\ndescription: d\n---\n\n  \n");
    expect(type).toBeNull();
    expect(warnings.join(" ")).toContain("empty definition");
  });

  test("a preset-only definition (no body) is valid", () => {
    const { type } = parse("a.md", "---\nname: a\ndescription: d\ntools: [read]\n---\n");
    expect(type?.prompt).toBe("");
    expect(type?.tools).toEqual(["read"]);
  });

  test("a prompt-only definition (no frontmatter at all) takes its name from the file", () => {
    const { type } = parse("helper.md", "Just a persona, no frontmatter.\n");
    expect(type?.name).toBe("helper");
    expect(type?.prompt).toBe("Just a persona, no frontmatter.");
  });

  test("a prompt-only definition may contain a `---` horizontal rule", () => {
    const { type } = parse("helper.md", "Be helpful.\n\n---\n\nAlways.\n");
    expect(type).not.toBeNull();
    expect(type?.prompt).toContain("---");
  });
});

/**
 * The dangerous direction. A dropped `tools:` leaves tool_allowlist unset, and spawn.ts reads
 * unset as UNRESTRICTED — so any frontmatter that fails to parse the way its author meant
 * would hand a "read-only" agent write/edit/bash and drop its spend cap. Every case here must
 * either parse CORRECTLY or be REFUSED. Silently loading a preset-less type is the bug.
 */
describe("parseAgentType — malformed frontmatter must never fail open", () => {
  const parse = (file: string, src: string) => parseAgentType(file, src, { spawnable: SPAWNABLE });
  const FULL = "tools: [read, grep]\nbudget_usd: 0.25\n";

  test("a `---` line inside a block scalar does NOT truncate the frontmatter", () => {
    const { type, warnings } = parse(
      "r.md",
      `---\nname: r\ndescription: |\n  Reviews a diff.\n  ---\n  Read-only.\n${FULL}---\npersona\n`,
    );
    expect(warnings).toEqual([]);
    expect(type?.tools).toEqual(["read", "grep"]);
    expect(type?.budget_usd).toBe(0.25);
    expect(type?.prompt).toBe("persona");
  });

  test("a UTF-8 BOM before the fence still parses (Windows editors write one)", () => {
    const { type, warnings } = parse("r.md", `﻿---\nname: r\ndescription: d\n${FULL}---\np\n`);
    expect(warnings).toEqual([]);
    expect(type?.tools).toEqual(["read", "grep"]);
  });

  const refused: [string, string][] = [
    ["a leading blank line", `\n---\nname: r\ndescription: d\n${FULL}---\np\n`],
    ["a leading space", ` ---\nname: r\ndescription: d\n${FULL}---\np\n`],
    ["an unclosed fence", `---\nname: r\ndescription: d\n${FULL}p with no closing fence\n`],
    ["unparseable YAML", `---\nname: [1,\n${FULL}---\np\n`],
    // Bun.YAML reads a bare `---` as a document separator and returns an ARRAY, not a map.
    ["a value ending in ---", `---\nname: r\ndescription: foo ---\n${FULL}---\np\n`],
    ["a scalar document", "---\njustastring\n---\np\n"],
  ];
  for (const [label, src] of refused) {
    test(`${label} REFUSES the definition instead of loading it unrestricted`, () => {
      const { type, warnings } = parse("r.md", src);
      expect(type).toBeNull();
      expect(warnings.join(" ")).toContain("was NOT loaded");
    });
  }

  test("the refusal message tells the author what to check", () => {
    const { warnings } = parse("r.md", `\n---\nname: r\n${FULL}---\np\n`);
    expect(warnings.join(" ")).toContain("`---` on line 1");
  });

  test("a refused definition is a HARD failure downstream, not a silent unrestricted agent", () => {
    // Walk the real chain: refusing at load means the name is absent from the registry, and
    // absent means validateDelegations rejects any delegation that asks for it. So the run
    // stops with a message naming the file, rather than quietly spawning a wide-open child.
    const { type } = parse("r.md", `\n---\nname: r\ndescription: d\n${FULL}---\np\n`);
    expect(type).toBeNull();
    const known = new Set<string>(); // what loadAgentTypes would have produced
    const v = validateDelegations(
      [{ step_id: "s", objective: "o", output_format: "f", boundaries: "b", agent_type: "r" }],
      { agentTypes: known },
    );
    expect(v.ok).toBe(false);
  });
});

// ------------------------------------------------------------------ loadAgentTypes

describe("loadAgentTypes", () => {
  let root: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "minima-agent-types-"));
    prevEnv = process.env.MINIMA_HARNESS_DIR;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MINIMA_HARNESS_DIR;
    else process.env.MINIMA_HARNESS_DIR = prevEnv;
    rmSync(root, { recursive: true, force: true });
  });

  const writeType = (dir: string, file: string, body: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), body, "utf8");
  };
  const def = (name: string, extra = "") =>
    `---\nname: ${name}\ndescription: ${name} desc\n${extra}---\n${name} persona\n`;

  test("no directories at all — an empty registry with no warnings", () => {
    process.env.MINIMA_HARNESS_DIR = join(root, "nope");
    const reg = loadAgentTypes(join(root, "also-nope"));
    expect(reg.types.size).toBe(0);
    expect(reg.warnings).toEqual([]);
  });

  test("project definitions load from <cwd>/.minima/agents", () => {
    process.env.MINIMA_HARNESS_DIR = join(root, "home");
    writeType(join(root, "repo", ".minima", "agents"), "reviewer.md", def("reviewer"));
    const reg = loadAgentTypes(join(root, "repo"));
    expect([...reg.types.keys()]).toEqual(["reviewer"]);
    expect(reg.types.get("reviewer")?.prompt).toBe("reviewer persona");
  });

  test("global definitions load from $MINIMA_HARNESS_DIR/agents", () => {
    process.env.MINIMA_HARNESS_DIR = join(root, "home");
    writeType(join(root, "home", "agents"), "fixer.md", def("fixer"));
    const reg = loadAgentTypes(join(root, "repo"));
    expect([...reg.types.keys()]).toEqual(["fixer"]);
  });

  test("a project definition SHADOWS a global one of the same name", () => {
    process.env.MINIMA_HARNESS_DIR = join(root, "home");
    writeType(join(root, "home", "agents"), "reviewer.md", def("reviewer"));
    writeType(
      join(root, "repo", ".minima", "agents"),
      "reviewer.md",
      "---\nname: reviewer\ndescription: project version\n---\nproject persona\n",
    );
    const reg = loadAgentTypes(join(root, "repo"));
    expect(reg.types.size).toBe(1);
    expect(reg.types.get("reviewer")?.description).toBe("project version");
  });

  test("non-.md files are ignored; .MD is not", () => {
    process.env.MINIMA_HARNESS_DIR = join(root, "home");
    const dir = join(root, "repo", ".minima", "agents");
    writeType(dir, "a.md", def("a"));
    writeType(dir, "notes.txt", def("b"));
    writeType(dir, "C.MD", def("c"));
    const reg = loadAgentTypes(join(root, "repo"));
    expect([...reg.types.keys()].sort()).toEqual(["a", "c"]);
  });

  test("one broken file does not stop the others, and warns", () => {
    process.env.MINIMA_HARNESS_DIR = join(root, "home");
    const dir = join(root, "repo", ".minima", "agents");
    writeType(dir, "good.md", def("good"));
    writeType(dir, "bad.md", "---\nname: bad\ndescription: d\ntools: [nope]\n---\nbody\n");
    const reg = loadAgentTypes(join(root, "repo"));
    expect([...reg.types.keys()]).toEqual(["good"]);
    expect(reg.warnings.join(" ")).toContain("no usable tool");
  });

  test("a warning names the file it came from", () => {
    process.env.MINIMA_HARNESS_DIR = join(root, "home");
    const dir = join(root, "repo", ".minima", "agents");
    writeType(dir, "a.md", "---\nname: a\n---\nbody\n");
    const reg = loadAgentTypes(join(root, "repo"));
    expect(reg.warnings[0]).toContain(join(dir, "a.md"));
  });

  test("an explicit globalDir overrides the env var", () => {
    process.env.MINIMA_HARNESS_DIR = join(root, "unused");
    writeType(join(root, "elsewhere"), "e.md", def("e"));
    const reg = loadAgentTypes(join(root, "repo"), { globalDir: join(root, "elsewhere") });
    expect([...reg.types.keys()]).toEqual(["e"]);
  });
});

// ------------------------------------------------------------------ applyAgentType

describe("applyAgentType", () => {
  const base: Delegation = {
    step_id: "s1",
    objective: "do it",
    output_format: "text",
    boundaries: "none",
  };

  test("no agent_type is the identity, and returns no type", () => {
    const r = applyAgentType(base, registry(REVIEWER));
    expect(r.delegation).toBe(base);
    expect(r.type).toBeNull();
  });

  test("an unknown name is inert, not an error (createSpawn is callable without validation)", () => {
    const r = applyAgentType({ ...base, agent_type: "ghost" }, registry(REVIEWER));
    expect(r.type).toBeNull();
    expect(r.delegation.tool_allowlist).toBeUndefined();
  });

  test("a null/absent registry is inert", () => {
    expect(applyAgentType({ ...base, agent_type: "reviewer" }, null).type).toBeNull();
    expect(applyAgentType({ ...base, agent_type: "reviewer" }, undefined).type).toBeNull();
  });

  test("the name is matched case- and whitespace-insensitively", () => {
    expect(applyAgentType({ ...base, agent_type: "  ReViewer " }, registry(REVIEWER)).type).toBe(
      REVIEWER,
    );
  });

  test("every preset field fills in when the delegation left it unset", () => {
    const { delegation, type } = applyAgentType(
      { ...base, agent_type: "reviewer" },
      registry(REVIEWER),
    );
    expect(type).toBe(REVIEWER);
    expect(delegation.tool_allowlist).toEqual(["read", "grep"]);
    expect(delegation.candidates).toEqual(["claude-x"]);
    expect(delegation.effort).toBe("light");
    expect(delegation.budget_usd).toBe(0.25);
  });

  test("an explicitly authored field always beats the preset", () => {
    const { delegation } = applyAgentType(
      {
        ...base,
        agent_type: "reviewer",
        tool_allowlist: ["bash"],
        candidates: ["gpt-x"],
        effort: "deep",
        budget_usd: 5,
        isolation: "workdir",
      },
      registry(REVIEWER),
    );
    expect(delegation.tool_allowlist).toEqual(["bash"]);
    expect(delegation.candidates).toEqual(["gpt-x"]);
    expect(delegation.effort).toBe("deep");
    expect(delegation.budget_usd).toBe(5);
    expect(delegation.isolation).toBe("workdir");
  });

  test("an EMPTY array counts as unset — `tool_allowlist: []` must not unlock a read-only type", () => {
    const { delegation } = applyAgentType(
      { ...base, agent_type: "reviewer", tool_allowlist: [], candidates: [] },
      registry(REVIEWER),
    );
    expect(delegation.tool_allowlist).toEqual(["read", "grep"]);
    expect(delegation.candidates).toEqual(["claude-x"]);
  });

  test("an explicit budget_usd of 0 is a real value and wins over the preset", () => {
    const { delegation } = applyAgentType(
      { ...base, agent_type: "reviewer", budget_usd: 0 },
      registry(REVIEWER),
    );
    expect(delegation.budget_usd).toBe(0);
  });

  test("the contract fields are never touched", () => {
    const { delegation } = applyAgentType({ ...base, agent_type: "reviewer" }, registry(REVIEWER));
    expect(delegation.objective).toBe("do it");
    expect(delegation.output_format).toBe("text");
    expect(delegation.boundaries).toBe("none");
    expect(delegation.step_id).toBe("s1");
  });

  test("a type with no presets changes nothing but still resolves (persona only)", () => {
    const persona: AgentType = { name: "p", description: "d", prompt: "be nice" };
    const { delegation, type } = applyAgentType({ ...base, agent_type: "p" }, registry(persona));
    expect(type).toBe(persona);
    expect(delegation.tool_allowlist).toBeUndefined();
    expect(delegation.effort).toBeUndefined();
  });
});

// ------------------------------------------------------------------ agentTypePlanPreset

describe("agentTypePlanPreset", () => {
  test("fills a step's tools + candidates, and nothing else", () => {
    const preset = agentTypePlanPreset({ agent_type: "reviewer" }, registry(REVIEWER));
    expect(preset).toEqual({ tools: ["read", "grep"], candidates: ["claude-x"] });
  });

  test("effort/budget/isolation are deliberately NOT applied — the LEAD runs the step", () => {
    const preset = agentTypePlanPreset({ agent_type: "reviewer" }, registry(REVIEWER)) as Record<
      string,
      unknown
    >;
    expect(preset.effort).toBeUndefined();
    expect(preset.budget_usd).toBeUndefined();
    expect(preset.isolation).toBeUndefined();
  });

  test("authored step fields win; an unknown or absent type is inert", () => {
    expect(
      agentTypePlanPreset({ agent_type: "reviewer", tools: ["bash"] }, registry(REVIEWER)),
    ).toEqual({ candidates: ["claude-x"] });
    expect(agentTypePlanPreset({ agent_type: "ghost" }, registry(REVIEWER))).toEqual({});
    expect(agentTypePlanPreset({}, registry(REVIEWER))).toEqual({});
  });
});

// ------------------------------------------------------------------ validateDelegations

describe("validateDelegations — agent_type", () => {
  const d = (over: Partial<Delegation> = {}): Delegation => ({
    step_id: "s1",
    objective: "o",
    output_format: "f",
    boundaries: "b",
    ...over,
  });

  test("a known type passes", () => {
    const r = validateDelegations([d({ agent_type: "reviewer" })], {
      agentTypes: new Set(["reviewer"]),
    });
    expect(r.ok).toBe(true);
  });

  test("an unknown type is REJECTED and the error lists what is available", () => {
    const r = validateDelegations([d({ agent_type: "revewer" })], {
      agentTypes: new Set(["reviewer", "fixer"]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('unknown agent_type "revewer"');
      expect(r.error).toContain("available: fixer, reviewer");
    }
  });

  test("case and whitespace are normalized before the check", () => {
    expect(
      validateDelegations([d({ agent_type: " Reviewer " })], { agentTypes: new Set(["reviewer"]) })
        .ok,
    ).toBe(true);
  });

  test("an empty or non-string agent_type is rejected", () => {
    for (const bad of ["", "   ", 7 as unknown as string, null as unknown as string]) {
      const r = validateDelegations([d({ agent_type: bad })], { agentTypes: new Set(["reviewer"]) });
      expect(r.ok).toBe(false);
    }
  });

  test("no agent_type is always fine", () => {
    expect(validateDelegations([d()], { agentTypes: new Set(["reviewer"]) }).ok).toBe(true);
  });

  test("without a known set the field is not checked (a harness with no types is unchanged)", () => {
    expect(validateDelegations([d({ agent_type: "anything" })]).ok).toBe(true);
  });

  test("the error explains an empty registry rather than printing 'available: '", () => {
    const r = validateDelegations([d({ agent_type: "x" })], { agentTypes: new Set() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no agent types are defined");
  });
});

// ------------------------------------------------------------------ taskTool surface

describe("taskTool — the advertised menu", () => {
  const spawnOk = async (dg: Delegation) => ({
    step_id: dg.step_id,
    childId: "c",
    text: "done",
    costUsd: 0,
    quality: null,
    outcome: "success" as const,
    workdir: null,
  });

  test("with no agent types the tool is byte-identical to before the feature", () => {
    const plain = taskTool({ spawn: spawnOk });
    const empty = taskTool({ spawn: spawnOk, agentTypes: [] });
    expect(empty.description).toBe(plain.description);
    expect(JSON.stringify(empty.parameters)).toBe(JSON.stringify(plain.parameters));
    expect(plain.description).not.toContain("agent_type");
  });

  test("defined types appear in the description with their descriptions", () => {
    const tool = taskTool({
      spawn: spawnOk,
      agentTypes: [
        { name: "reviewer", description: "Reviews a diff." },
        { name: "fixer", description: "" },
      ],
    });
    expect(tool.description).toContain("reviewer: Reviews a diff.");
    expect(tool.description).toContain("fixer: (no description)");
    expect(JSON.stringify(tool.parameters)).toContain("agent_type");
  });

  test("the schema is per-instance — one tool's menu never leaks into another's", () => {
    const withTypes = taskTool({
      spawn: spawnOk,
      agentTypes: [{ name: "reviewer", description: "d" }],
    });
    const without = taskTool({ spawn: spawnOk });
    expect(JSON.stringify(withTypes.parameters)).toContain("agent_type");
    expect(JSON.stringify(without.parameters)).not.toContain("agent_type");
  });

  test("an unknown agent_type in a task call is refused before anything spawns", async () => {
    let spawned = 0;
    const tool = taskTool({
      spawn: async (dg) => {
        spawned++;
        return spawnOk(dg);
      },
      agentTypes: [{ name: "reviewer", description: "d" }],
    });
    const res = await tool.execute(
      "t1",
      {
        delegations: JSON.stringify([
          { step_id: "a", objective: "o", output_format: "f", boundaries: "b", agent_type: "nope" },
        ]),
      },
      null,
      null,
    );
    expect(res.details?.error).toBe(true);
    expect(res.content.map((c) => (c.type === "text" ? c.text : "")).join("")).toContain(
      'unknown agent_type "nope"',
    );
    expect(spawned).toBe(0);
  });
});

// ------------------------------------------------------------------ delegationPrompt

describe("delegationPrompt — the Role section", () => {
  const ctx: SpawnContext = { depth: 1, parentSignal: null, priorResults: [] };
  const d: Delegation = {
    step_id: "s1",
    objective: "review the diff",
    output_format: "a list",
    boundaries: "no writes",
  };

  test("a type's body renders as `## Role` BEFORE the objective", () => {
    const p = delegationPrompt(d, ctx, REVIEWER);
    expect(p).toContain("## Role\nYou review code for correctness only.");
    expect(p.indexOf("## Role")).toBeLessThan(p.indexOf("## Objective"));
  });

  test("the contract and the Rules block survive a persona", () => {
    const p = delegationPrompt(d, ctx, REVIEWER);
    expect(p).toContain("## Objective\nreview the diff");
    expect(p).toContain("## Return exactly\na list");
    expect(p).toContain("## Boundaries (do NOT touch)\nno writes");
    expect(p).toContain("- Read a file before editing it");
    expect(p).toContain("BLOCKED: ");
  });

  test("no type, or a preset-only type, produces no Role section at all", () => {
    expect(delegationPrompt(d, ctx)).not.toContain("## Role");
    expect(delegationPrompt(d, ctx, null)).not.toContain("## Role");
    expect(
      delegationPrompt(d, ctx, { name: "p", description: "d", prompt: "   ", tools: ["read"] }),
    ).not.toContain("## Role");
  });

  /**
   * A pin, not a self-comparison: this is the EXACT prompt a type-less child got before agent
   * types existed. Comparing delegationPrompt to itself would pass even if the whole prompt
   * were replaced, so the literal is the only thing that proves the no-type path is untouched.
   * If this fails, the child's contract changed — update it deliberately, never reflexively.
   */
  test("with no agent type the child's system prompt is byte-for-byte the historical one", () => {
    const expected = [
      "You are a focused sub-agent executing ONE delegated subtask.",
      "## Objective\nreview the diff",
      "## Return exactly\na list",
      "## Boundaries (do NOT touch)\nno writes",
      [
        "## Rules",
        "- Read a file before editing it; never guess contents.",
        "- After changing files, verify (run the relevant test or command) when possible and include the result.",
        "- Boundaries override the objective. If the objective cannot be completed without crossing them, " +
          'change nothing and reply with ONE line starting with "BLOCKED: " followed by the reason.',
      ].join("\n"),
      "Do the work with your tools, then reply with ONLY the requested output.",
    ].join("\n\n");
    expect(delegationPrompt(d, ctx)).toBe(expected);
    expect(delegationPrompt(d, ctx, null)).toBe(expected);
  });

  test("a type ADDS the Role block and changes nothing else", () => {
    const withRole = delegationPrompt(d, ctx, REVIEWER);
    const without = delegationPrompt(d, ctx);
    expect(withRole).toBe(
      without.replace(
        "You are a focused sub-agent executing ONE delegated subtask.\n\n",
        `You are a focused sub-agent executing ONE delegated subtask.\n\n## Role\n${REVIEWER.prompt}\n\n`,
      ),
    );
  });
});

// ------------------------------------------------------------------ createSpawn integration

const FAUX: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Test Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};
const CLAUDE: Model = { ...FAUX, id: "claude-x", provider: "anthropic", api: "anthropic-messages" };
const GPT: Model = { ...FAUX, id: "gpt-x", provider: "openai", api: "openai-completions" };

function mockService() {
  const candidateLists: (string[] | undefined)[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
      const body = init?.body ? JSON.parse(init.body) : {};
      candidateLists.push(body?.constraints?.candidate_models as string[] | undefined);
      const ranked = {
        model_id: "test-faux",
        provider: "faux",
        predicted_success: 0.9,
        est_cost_usd: 0.001,
        score: 0.001,
      };
      return {
        status: 200,
        json: async () => ({
          recommendation_id: `rec-${candidateLists.length}`,
          recommended_model: ranked,
          ranked: [ranked],
          confidence: 0.8,
          decision_basis: "memory",
          threshold_used: 0.5,
          classified_task_type: "code",
          classified_difficulty: "easy",
          catalog_version: "v1",
        }),
      };
    }
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/feedback") {
      return { status: 200, json: async () => ({ accepted: true }) };
    }
    return { status: 404, json: async () => ({ detail: "nope" }) };
  };
  return { fetchLike, candidateLists };
}

/**
 * route() drops candidates whose provider key is absent, so an ambient ANTHROPIC_API_KEY (or
 * its absence) would silently change which pool reaches the wire. Pin both keys for the
 * duration of a routing test and restore whatever was there.
 */
function pinProviderKeys(): () => void {
  const prev: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  process.env.ANTHROPIC_API_KEY = "test-anthropic";
  process.env.OPENAI_API_KEY = "test-openai";
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function leadAgent(fetchLike: ReturnType<typeof mockService>["fetchLike"]): MinimaAgent {
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike as never });
  const config = harnessConfig({
    candidates: ["claude-x", "gpt-x"],
    allowOffline: false,
    minimaApiKey: "k",
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  return new MinimaAgent({
    config,
    router,
    judge: new ConstJudge(0.9),
    meter: new CostMeter(),
    tools: [],
  });
}

describe("createSpawn — an agent type reaches the real child", () => {
  let reg: FauxRegistration;
  let wd: string;
  let restoreKeys: () => void;

  beforeEach(() => {
    restoreKeys = pinProviderKeys();
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    for (const m of [FAUX, CLAUDE, GPT]) registerModel(m);
    reg = registerFauxProvider([FAUX]);
    reg.setResponses([new AssistantMessage({ content: [text("reviewed")] })]);
    wd = mkdtempSync(join(tmpdir(), "minima-agent-types-spawn-"));
  });
  afterEach(() => {
    reg.unregister();
    restoreKeys();
    rmSync(wd, { recursive: true, force: true });
  });

  const ctx: SpawnContext = { depth: 1, parentSignal: null, priorResults: [] };
  const d = (over: Partial<Delegation> = {}): Delegation => ({
    step_id: "s1",
    objective: "review it",
    output_format: "text",
    boundaries: "none",
    ...over,
  });

  test("the type's persona is in the child's system prompt and its pool reaches the wire", async () => {
    const svc = mockService();
    const spawn = createSpawn({
      parent: leadAgent(svc.fetchLike),
      workdir: wd,
      agentTypes: registry(REVIEWER),
    });
    const res = await spawn(d({ agent_type: "reviewer" }), ctx);
    expect(res.outcome).toBe("success");
    expect(svc.candidateLists.at(-1)).toEqual(["claude-x"]);
    const sent = reg.state.requests.at(-1);
    expect(sent?.systemPrompt).toContain("## Role");
    expect(sent?.systemPrompt).toContain("Never propose refactors");
  });

  test("the type's tool allowlist actually scopes the child's toolset", async () => {
    const svc = mockService();
    const spawn = createSpawn({
      parent: leadAgent(svc.fetchLike),
      workdir: wd,
      agentTypes: registry(REVIEWER),
    });
    await spawn(d({ agent_type: "reviewer" }), ctx);
    const names = [...(reg.state.requests.at(-1)?.toolNames ?? [])].sort();
    expect(names).toEqual(["grep", "read"]);
  });

  test("an explicit tool_allowlist on the delegation overrides the type's", async () => {
    const svc = mockService();
    const spawn = createSpawn({
      parent: leadAgent(svc.fetchLike),
      workdir: wd,
      agentTypes: registry(REVIEWER),
    });
    await spawn(d({ agent_type: "reviewer", tool_allowlist: ["ls"] }), ctx);
    expect(reg.state.requests.at(-1)?.toolNames).toEqual(["ls"]);
  });

  test("an unknown type name spawns a plain child rather than throwing", async () => {
    const svc = mockService();
    const spawn = createSpawn({
      parent: leadAgent(svc.fetchLike),
      workdir: wd,
      agentTypes: registry(REVIEWER),
    });
    const res = await spawn(d({ agent_type: "ghost" }), ctx);
    expect(res.outcome).toBe("success");
    expect(reg.state.requests.at(-1)?.systemPrompt).not.toContain("## Role");
  });

  test("no registry at all — an agent_type is simply inert", async () => {
    const svc = mockService();
    const spawn = createSpawn({ parent: leadAgent(svc.fetchLike), workdir: wd });
    const res = await spawn(d({ agent_type: "reviewer" }), ctx);
    expect(res.outcome).toBe("success");
    expect(reg.state.requests.at(-1)?.systemPrompt).not.toContain("## Role");
  });

  test("a type can never make a child plan-aware or let it delegate further", async () => {
    const svc = mockService();
    const parent = leadAgent(svc.fetchLike);
    parent.config.bigPlan = true;
    const wide: AgentType = {
      name: "wide",
      description: "d",
      prompt: "do anything",
      tools: ["read", "write", "edit", "apply_patch", "bash", "ls", "glob", "grep"],
    };
    const spawn = createSpawn({ parent, workdir: wd, agentTypes: registry(wide) });
    await spawn(d({ agent_type: "wide" }), ctx);
    const names = reg.state.requests.at(-1)?.toolNames ?? [];
    expect(names).not.toContain("task");
  });
});

// ------------------------------------------------------------------ plan steps

describe("plan steps — agent_type expands into tools + candidates", () => {
  const META: Model = { ...FAUX, id: "meta-model" };
  const synth = (over: Partial<BigPlanSynthesis> = {}): BigPlanSynthesis => ({
    title: "Ship it",
    goal: "ship",
    overview: "",
    requirements: [],
    constraints: [],
    decisions: [],
    approach: [],
    risks: [],
    successCriteria: [],
    openItems: [],
    ...over,
  });

  const finalize = async (approach: BigPlanSynthesis["approach"], types?: AgentTypeRegistry) => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    let md = "";
    const out = await finalizePlan(new PlanSessionStore("goal"), {
      metaModel: META,
      signal: null,
      force: false,
      transcript: "",
      outPath: "/fake/BigPlan.md",
      db,
      runId,
      write: async (_p, content) => {
        md = content;
      },
      answerQuestions: async () => [],
      synthesize: async () => synth({ approach }),
      critic: async () => null,
      ...(types ? { agentTypes: types } : {}),
    });
    const plan = db.getActivePlan(runId);
    const steps = plan ? db.getPlanSteps(plan.id) : [];
    return { out, md, steps, db };
  };

  test("a step naming a type is seeded with that type's tools and pool", async () => {
    const { out, steps, db } = await finalize(
      [{ action: "review the diff", verify: "bun test", tools: [], agent_type: "reviewer" }],
      registry(REVIEWER),
    );
    expect(out.kind).toBe("ok");
    expect(JSON.parse(steps[0]!.tools ?? "null")).toEqual(["read", "grep"]);
    expect(JSON.parse(steps[0]!.candidates ?? "null")).toEqual(["claude-x"]);
    db.close();
  });

  test("an authored tools list on the step wins over the type's", async () => {
    const { steps, db } = await finalize(
      [{ action: "a", verify: "bun test", tools: ["bash"], agent_type: "reviewer" }],
      registry(REVIEWER),
    );
    expect(JSON.parse(steps[0]!.tools ?? "null")).toEqual(["bash"]);
    expect(JSON.parse(steps[0]!.candidates ?? "null")).toEqual(["claude-x"]);
    db.close();
  });

  test("an unknown type expands to nothing but is still recorded in the doc", async () => {
    const { md, steps, db } = await finalize(
      [{ action: "a", verify: "bun test", tools: [], agent_type: "ghost" }],
      registry(REVIEWER),
    );
    expect(steps[0]!.tools).toBeNull();
    expect(steps[0]!.candidates).toBeNull();
    expect(md).toContain("   - agent: ghost");
    db.close();
  });

  test("BigPlan.md renders the agent line only for steps that have one", async () => {
    const { md, db } = await finalize(
      [
        { action: "reviewed step", verify: "bun test", tools: [], agent_type: "reviewer" },
        { action: "plain step", verify: "bun run check", tools: [] },
      ],
      registry(REVIEWER),
    );
    expect(md).toContain("   - agent: reviewer");
    expect(md).toContain("   - tools: read, grep");
    expect(md).toContain("   - models: claude-x");
    expect((md.match(/- agent:/g) ?? []).length).toBe(1);
    db.close();
  });

  test("with no registry, finalize behaves exactly as before", async () => {
    const { md, steps, db } = await finalize([
      { action: "a", verify: "bun test", tools: [], agent_type: "reviewer" },
    ]);
    expect(steps[0]!.tools).toBeNull();
    expect(steps[0]!.candidates).toBeNull();
    expect(md).toContain("   - agent: reviewer");
    db.close();
  });
});

// ------------------------------------------------------------------ step pool → routing

describe("the in-progress step's pool reaches routing", () => {
  let reg: FauxRegistration;
  let restoreKeys: () => void;

  beforeEach(() => {
    restoreKeys = pinProviderKeys();
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    for (const m of [FAUX, CLAUDE, GPT]) registerModel(m);
    reg = registerFauxProvider([FAUX]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);
  });
  afterEach(() => {
    reg.unregister();
    restoreKeys();
  });

  const withPlan = (
    agent: MinimaAgent,
    stepCandidates: string[] | null,
  ): { db: MinimaDb; runId: string } => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const { planId } = db.seedPlanFromSteps(runId, "t", [
      { content: "step one", verify: "bun test", candidates: stepCandidates },
    ]);
    db.setStepStatus(db.getPlanSteps(planId)[0]!.id, "in_progress");
    agent.db = db;
    agent.runId = runId;
    return { db, runId };
  };

  test("the step's pool is what the server is asked to rank over", async () => {
    const svc = mockService();
    const agent = leadAgent(svc.fetchLike);
    agent.config.bigPlan = true;
    const { db } = withPlan(agent, ["claude-x"]);
    await agent.promptRouted("do the step");
    expect(svc.candidateLists.at(-1)).toEqual(["claude-x"]);
    db.close();
  });

  test("no in-progress step → the config pool, unchanged", async () => {
    const svc = mockService();
    const agent = leadAgent(svc.fetchLike);
    agent.config.bigPlan = true;
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    db.seedPlanFromSteps(runId, "t", [{ content: "pending step", candidates: ["claude-x"] }]);
    agent.db = db;
    agent.runId = runId;
    await agent.promptRouted("no step in progress");
    expect(svc.candidateLists.at(-1)).toEqual(["claude-x", "gpt-x"]);
    db.close();
  });

  test("plan verification OFF → the step pool is never read", async () => {
    const svc = mockService();
    const agent = leadAgent(svc.fetchLike);
    agent.config.bigPlan = false;
    const { db } = withPlan(agent, ["claude-x"]);
    await agent.promptRouted("do the step");
    expect(svc.candidateLists.at(-1)).toEqual(["claude-x", "gpt-x"]);
    db.close();
  });

  test("a pool of ids this build cannot resolve degrades to the config pool", async () => {
    const svc = mockService();
    const agent = leadAgent(svc.fetchLike);
    agent.config.bigPlan = true;
    const { db } = withPlan(agent, ["not-a-real-model"]);
    await agent.promptRouted("do the step");
    expect(svc.candidateLists.at(-1)).toEqual(["claude-x", "gpt-x"]);
    db.close();
  });

  test("a child agent ignores the lead's step pool (children are plan-blind)", async () => {
    const svc = mockService();
    const agent = leadAgent(svc.fetchLike);
    agent.config.bigPlan = true;
    const { db } = withPlan(agent, ["claude-x"]);
    agent.agentId = "child-1";
    await agent.promptRouted("child work");
    expect(svc.candidateLists.at(-1)).toEqual(["claude-x", "gpt-x"]);
    db.close();
  });
});

// ------------------------------------------------------------------ guards

describe("guards", () => {
  test("spawnableToolNames is derived from the real assembler, minus task", () => {
    const expected = builtinTools({ exclude: ["task"] }).map((t) => t.name);
    expect([...spawnableToolNames()].sort()).toEqual([...expected].sort());
    expect(spawnableToolNames().has("task")).toBe(false);
  });

  test("KNOWN_TOOLS covers every name builtinTools can emit", () => {
    const emitted = builtinTools({
      bgJobs: { list: () => [] } as never,
    }).map((t) => t.name);
    for (const name of emitted) expect(KNOWN_TOOLS.has(name)).toBe(true);
  });

  test("every spawnable tool is a KNOWN_TOOL — a type's allowlist survives the plan lint", () => {
    for (const name of spawnableToolNames()) expect(KNOWN_TOOLS.has(name)).toBe(true);
  });

  test("/agent <partial> completes names; a name plus a task no longer completes", () => {
    const reg = {
      types: new Map(
        ["reviewer", "refactor", "fixer"].map((name) => [
          name,
          { name, description: `${name} d`, prompt: "" },
        ]),
      ),
      warnings: [],
    };
    const names = (typed: string) => agentTypeMatches(typed, reg)?.map((t) => t.name) ?? null;
    expect(names("/agent ")).toEqual(["fixer", "refactor", "reviewer", "make"]);
    expect(names("/agent re")).toEqual(["refactor", "reviewer"]);
    expect(names("/agent rev")).toEqual(["reviewer"]);
    expect(names("/agent zz")).toEqual([]);
    expect(names("/agent reviewer check the diff")).toBeNull();
    expect(names("/agents")).toBeNull();
    expect(names("/ag")).toBeNull();
    // `make` is offered even with nothing defined — otherwise there is no way in.
    expect(names("/agent m")).toEqual(["make"]);
    expect(agentTypeMatches("/agent ", undefined)?.map((t) => t.name)).toEqual(["make"]);
  });

  test("scaffoldAgentType writes a definition the loader accepts, and never clobbers", () => {
    const cwd = mkdtempSync(join(tmpdir(), "minima-scaffold-"));
    const path = scaffoldAgentType(cwd, "Reviewer");
    expect(path).toBe(join(cwd, ".minima", "agents", "reviewer.md"));

    const reg = loadAgentTypes(cwd, { globalDir: join(cwd, "nope") });
    expect(reg.warnings).toEqual([]);
    expect(reg.types.get("reviewer")?.prompt).toContain("## Role");

    expect(() => scaffoldAgentType(cwd, "reviewer")).toThrow("already exists");
    expect(() => scaffoldAgentType(cwd, "Bad Name")).toThrow("not a usable name");

    const globalDir = join(cwd, "home", "agents");
    scaffoldAgentType(cwd, "fixer", { global: true, globalDir });
    expect(loadAgentTypes(cwd, { globalDir }).types.has("fixer")).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("the /agent make wizard fills every field, validates, and round-trips through the loader", () => {
    const cwd = mkdtempSync(join(tmpdir(), "minima-wizard-"));
    let d = newAgentDraft();
    expect(d.step).toBe(0);

    // Each answer must be usable — a bad one re-asks the SAME field rather than being kept.
    const bad = (input: string) => {
      const r = wizardAdvance(d, input);
      expect(r.kind).toBe("error");
      return r.kind === "error" ? r.message : "";
    };
    const ok = (input: string) => {
      const r = wizardAdvance(d, input);
      if (r.kind === "error") throw new Error(`unexpected error: ${r.message}`);
      d = r.draft;
      return r.kind;
    };

    expect(bad("Not A Name")).toContain("lowercase");
    expect(ok("Reviewer")).toBe("next");
    expect(d.name).toBe("reviewer");
    expect(bad("")).toContain("description is required");
    ok("Reviews a diff: correctness only");
    ok("You review code for correctness. Never propose refactors.");
    expect(bad("read grepp")).toContain("unknown tool: grepp");
    ok("read grep bash");
    expect(d.tools).toEqual(["read", "grep", "bash"]);
    expect(bad("free")).toContain("positive dollar amount");
    ok("$0.25");
    expect(wizardAdvance(d, "p").kind).toBe("done");

    const done = wizardAdvance(d, "p");
    if (done.kind !== "done") throw new Error("expected done");
    scaffoldAgentType(cwd, done.draft.name, {
      global: done.draft.global,
      description: done.draft.description,
      role: done.draft.role,
      tools: done.draft.tools,
      budget_usd: done.draft.budget_usd,
    });

    const reg = loadAgentTypes(cwd, { globalDir: join(cwd, "nope") });
    expect(reg.warnings).toEqual([]);
    const type = reg.types.get("reviewer");
    // The colon in the description is the interesting part: unquoted, it is invalid YAML and
    // would take the whole definition (including the allowlist) down with it.
    expect(type?.description).toBe("Reviews a diff: correctness only");
    expect(type?.tools).toEqual(["read", "grep", "bash"]);
    expect(type?.budget_usd).toBe(0.25);
    expect(type?.prompt).toContain("Never propose refactors");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("the wizard skips optional fields on a bare Enter, and a given name pre-answers step 0", () => {
    let d = newAgentDraft("triage");
    expect(d.step).toBe(1); // name already answered
    const step = (input: string) => {
      const r = wizardAdvance(d, input);
      if (r.kind === "error") throw new Error(r.message);
      d = r.draft;
      return r;
    };
    step("Sorts incoming failures");
    step(""); // role
    step(""); // tools
    step(""); // budget
    const done = wizardAdvance(d, ""); // scope defaults to this repo
    if (done.kind !== "done") throw new Error("expected done");
    expect(done.draft).toMatchObject({
      name: "triage",
      tools: undefined,
      budget_usd: undefined,
      global: false,
    });
    // A garbage name on the command line is NOT silently kept — step 0 still asks.
    expect(newAgentDraft("Not A Name").step).toBe(0);
  });

  test("bare /agent runs mid-turn; /agent <name> <task> queues (it spends money)", () => {
    expect(decideBusySubmit("/agent")).toEqual({ kind: "dispatch", name: "agent", args: "" });
    expect(decideBusySubmit("/agent reviewer check the diff")).toEqual({ kind: "enqueue" });
  });
});
