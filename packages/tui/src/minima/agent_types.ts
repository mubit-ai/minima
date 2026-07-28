/**
 * User-defined agent types — named presets for a delegation.
 *
 * An "agent type" is NOT a new execution path: it is a named bundle of fields the
 * {@link Delegation} contract already carries (tool_allowlist, candidates, effort,
 * budget_usd, isolation) plus a persona paragraph. A type is resolved to a plain
 * Delegation before any existing spawn code runs, so the tool filter, the per-step
 * candidate pool, the budget stop and the timeout are all the SAME code paths as an
 * un-typed delegation.
 *
 * Definitions are markdown files with YAML frontmatter:
 *   ~/.minima-harness/agents/*.md   (global, all repos)
 *   <cwd>/.minima/agents/*.md       (project, git-committable — shadows global by name)
 *
 *   ---
 *   name: reviewer
 *   description: Reviews a diff for correctness. Read-only.
 *   tools: [read, grep, glob, bash]
 *   candidates: [gemini-2.5-flash]
 *   effort: light
 *   budget_usd: 0.25
 *   ---
 *   You review code for correctness only. Never propose refactors.
 *
 * Precedence is always EXPLICIT DELEGATION FIELD > AGENT TYPE > HARNESS DEFAULT: a type
 * fills in only what the caller left unset, so naming a type can never override what the
 * lead actually authored for this one subtask.
 *
 * Three invariants a type may NOT touch, because createSpawn owns them for correctness:
 * `pinned` (a pool is never a pin — propensity integrity), `bigPlan` (children are
 * plan-blind by design; an inheriting child would poison the shared gates ledger), and the
 * exclusion of `task` from a child's toolset (the depth cap is the dispatcher's, not the
 * user's). A type is tools + model pool + persona + budget, nothing more.
 *
 * Validation happens at LOAD, not at spawn, and every rejection surfaces as a warning the
 * caller prints once at startup. That is load-bearing in BOTH directions:
 *  - `spawn.ts` intersects the allowlist silently, so a typo'd tool name would otherwise
 *    quietly produce a weaker agent than the author described;
 *  - and, worse, an allowlist that never parses at all fails OPEN — `tool_allowlist` stays
 *    unset, which `spawn.ts` reads as UNRESTRICTED. A "read-only reviewer" whose frontmatter
 *    is subtly broken would spawn with `write`/`edit`/`bash` and no spend cap. So a file whose
 *    frontmatter did not parse as a YAML map is REFUSED outright, never partially loaded.
 *
 * Total: a malformed file is skipped with a warning, never thrown. No files on disk ⇒ an
 * empty registry ⇒ {@link applyAgentType} is the identity function and the harness behaves
 * byte-identically to before this module existed.
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { builtinTools } from "../tools/builtin.ts";
import type { Delegation } from "../tools/task.ts";

export interface AgentType {
  /** Lowercase, [a-z0-9_-]. The name a delegation's `agent_type` refers to. */
  name: string;
  /** One line. This is what the lead agent reads to decide which type fits a subtask. */
  description: string;
  /** The markdown body — rendered as the child's `## Role` section. May be empty. */
  prompt: string;
  tools?: string[];
  candidates?: string[];
  effort?: "light" | "standard" | "deep";
  budget_usd?: number;
  isolation?: "workdir" | "inherit";
  /** Absolute path of the file this came from (diagnostics only). */
  source?: string;
}

export interface AgentTypeRegistry {
  /** Keyed by lowercase name. */
  types: Map<string, AgentType>;
  /** Human-readable load problems — printed once at startup, never thrown. */
  warnings: string[];
}

const EFFORTS = new Set(["light", "standard", "deep"]);
const ISOLATIONS = new Set(["workdir", "inherit"]);
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const KNOWN_KEYS = new Set([
  "name",
  "description",
  "tools",
  "candidates",
  "effort",
  "budget_usd",
  "isolation",
]);

/** The tools a CHILD agent can actually receive — derived from the real assembler so this
 *  can never drift (spawn.ts builds exactly this set, minus `task`). */
export function spawnableToolNames(): Set<string> {
  return new Set(builtinTools({ exclude: ["task"] }).map((t) => t.name));
}

// Both fences are line-anchored: the opening one at byte 0, the closing one preceded by a
// MANDATORY newline. Without that mandatory `\r?\n`, the lazy body group would close the
// block at the first `---` found anywhere — mid-line inside a value, or indented inside a
// block scalar — silently spilling the rest of the frontmatter into the body. The body group
// is optional so `---\n---\n` (empty frontmatter) still matches.
const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

export interface Frontmatter {
  meta: Record<string, unknown>;
  body: string;
  /**
   * A fence WAS present but its contents did not yield a YAML map — a parse error, or a
   * document that came back as a scalar/array (which is what `Bun.YAML.parse` returns when a
   * bare `---` inside the fence makes it a MULTI-document stream). Distinguishes "this file
   * has no frontmatter" from "this file's frontmatter is broken"; only the second is an
   * error, and it must be one, because a dropped `tools:` fails OPEN downstream.
   */
  malformed: boolean;
}

/**
 * Split YAML frontmatter off a markdown source. Total — never throws. No fence at byte 0
 * yields `{}` meta and the whole input as body; a broken fence additionally sets
 * `malformed`. A `---` horizontal rule inside the BODY is not a fence (the opening pattern
 * is anchored, no `m` flag).
 */
export function parseFrontmatter(src: string): Frontmatter {
  // A UTF-8 BOM (any Windows editor, PowerShell `Out-File`) sits before byte 0's `-` and
  // would otherwise defeat the anchor, turning the whole definition into persona text.
  const text = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  const m = FRONTMATTER.exec(text);
  if (!m) return { meta: {}, body: text, malformed: false };
  const body = text.slice(m[0].length);
  const raw = m[1] ?? "";
  // An empty fence (`---\n---`) is not broken, just pointless — it carries no presets to lose.
  if (!raw.trim()) return { meta: {}, body, malformed: false };
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(raw);
  } catch {
    return { meta: {}, body, malformed: true };
  }
  const isMap = Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed);
  if (!isMap) return { meta: {}, body, malformed: true };
  return { meta: parsed as Record<string, unknown>, body, malformed: false };
}

/** Frontmatter keys, as they look at the start of a line of YAML. */
const PRESET_KEY_LINE = /^(name|description|tools|candidates|effort|budget_usd|isolation)[ \t]*:/m;

/**
 * The name of a preset key found in what should be PROSE — the tell that a file's frontmatter
 * did not parse as intended (fence not at byte 0, a stray `---` closing the block early, YAML
 * the parser rejected). Null when the body is clean.
 *
 * This exists because an unparsed allowlist fails OPEN: `tools` never reaches the AgentType,
 * `applyAgentType` leaves `tool_allowlist` unset, and spawn.ts reads unset as UNRESTRICTED —
 * so a typo in a read-only agent's frontmatter would hand its child `write`, `edit` and `bash`
 * and drop its spend cap, silently. A correctly-parsed definition never has these keys at the
 * start of a body line, so treating one as a hard rejection costs nothing and closes the
 * whole class of silent-widening failures at once.
 */
export function leakedPresetKey(body: string): string | null {
  const m = PRESET_KEY_LINE.exec(body);
  return m ? (m[1] ?? null) : null;
}

function strList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
}

/**
 * Build one AgentType from a file's contents. Returns the type plus any warnings, or `null`
 * when the file is unusable. Every rejection here is a case where CONTINUING would produce an
 * agent the author did not describe: a bad name, an empty definition, an allowlist whose every
 * entry is unknown (a TOOLLESS agent), or frontmatter that did not parse (an UNRESTRICTED one).
 */
export function parseAgentType(
  fileName: string,
  src: string,
  opts: { spawnable: Set<string>; source?: string } = { spawnable: spawnableToolNames() },
): { type: AgentType | null; warnings: string[] } {
  const where = opts.source ?? fileName;
  const warn: string[] = [];
  const { meta, body, malformed } = parseFrontmatter(src);

  // Frontmatter that did not parse the way the author meant it to. Refuse the file rather
  // than silently running an agent with none of its restrictions — a dropped `tools:` leaves
  // tool_allowlist unset, which spawn.ts reads as UNRESTRICTED. `malformed` catches a broken
  // fence; leakedPresetKey catches the case where the fence never opened at all (a leading
  // blank line or space) and the YAML is sitting in the prose.
  const leaked = malformed ? null : leakedPresetKey(body);
  if (malformed || leaked) {
    return {
      type: null,
      warnings: [
        `${where}: ${
          leaked
            ? `"${leaked}:" appears in the body, so the frontmatter never opened`
            : "the frontmatter is not a YAML map"
        } — the definition was NOT loaded (running it would ignore its tool allowlist and budget cap). Check that the file STARTS with \`---\` on line 1, that it ends with a \`---\` line, and that no line INSIDE the frontmatter is \`---\`.`,
      ],
    };
  }

  const rawName = typeof meta.name === "string" ? meta.name.trim() : "";
  const name = (rawName || fileName.replace(/\.md$/i, "")).toLowerCase();
  if (!NAME_RE.test(name)) {
    return {
      type: null,
      warnings: [`${where}: invalid agent name "${name}" — use [a-z0-9_-], e.g. "reviewer"`],
    };
  }

  for (const key of Object.keys(meta)) {
    if (!KNOWN_KEYS.has(key)) {
      warn.push(`${where}: unknown frontmatter key "${key}" — ignored`);
    }
  }

  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  if (!description) {
    warn.push(`${where}: no "description" — the lead agent picks a type by its description`);
  }
  const prompt = body.trim();

  const type: AgentType = {
    name,
    description,
    prompt,
    ...(opts.source ? { source: opts.source } : {}),
  };

  if (meta.tools !== undefined) {
    const authored = strList(meta.tools);
    if (authored === null) {
      warn.push(`${where}: "tools" must be a list — ignored`);
    } else {
      const lowered = authored.map((t) => t.toLowerCase());
      const unknown = lowered.filter((t) => !opts.spawnable.has(t));
      const valid = lowered.filter((t) => opts.spawnable.has(t));
      if (unknown.length) {
        warn.push(
          `${where}: unknown tool${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} — sub-agents can use: ${[...opts.spawnable].sort().join(", ")}`,
        );
      }
      if (lowered.length > 0 && valid.length === 0) {
        // Every name was bogus. Honoring it would intersect the toolset to nothing and
        // spawn an agent that cannot do anything — refuse the whole type instead.
        return {
          type: null,
          warnings: [...warn, `${where}: no usable tool in "tools" — agent type skipped`],
        };
      }
      if (valid.length) type.tools = valid;
    }
  }

  if (meta.candidates !== undefined) {
    // Model ids stay verbatim + case-sensitive: createSpawn filters them against the live
    // registry at spawn time and falls back to the parent pool when none resolve.
    const ids = strList(meta.candidates);
    if (ids === null) warn.push(`${where}: "candidates" must be a list of model ids — ignored`);
    else if (ids.length) type.candidates = ids;
  }

  if (meta.effort !== undefined) {
    const e = typeof meta.effort === "string" ? meta.effort.trim().toLowerCase() : "";
    if (EFFORTS.has(e)) type.effort = e as AgentType["effort"];
    else warn.push(`${where}: "effort" must be light|standard|deep — ignored`);
  }

  if (meta.budget_usd !== undefined) {
    const n = typeof meta.budget_usd === "number" ? meta.budget_usd : Number(meta.budget_usd);
    if (Number.isFinite(n) && n > 0) type.budget_usd = n;
    else warn.push(`${where}: "budget_usd" must be a positive number — ignored`);
  }

  if (meta.isolation !== undefined) {
    const iso = typeof meta.isolation === "string" ? meta.isolation.trim().toLowerCase() : "";
    if (ISOLATIONS.has(iso)) type.isolation = iso as AgentType["isolation"];
    else warn.push(`${where}: "isolation" must be workdir|inherit — ignored`);
  }

  const hasPreset =
    type.tools !== undefined ||
    type.candidates !== undefined ||
    type.effort !== undefined ||
    type.budget_usd !== undefined ||
    type.isolation !== undefined;
  if (!prompt && !hasPreset) {
    return { type: null, warnings: [...warn, `${where}: empty definition — agent type skipped`] };
  }

  return { type, warnings: warn };
}

/** The global definitions dir, honoring MINIMA_HARNESS_DIR (same seam as perm_grants). */
function globalAgentsDir(): string {
  const base = process.env.MINIMA_HARNESS_DIR?.trim() || join(homedir(), ".minima-harness");
  return join(base, "agents");
}

/**
 * Load every definition, global first then project — so a project file SHADOWS a global one
 * of the same name. Missing directories are normal (the overwhelmingly common case) and
 * produce no warning. Total: any unreadable file or dir degrades to a warning.
 */
export function loadAgentTypes(cwd: string, opts: { globalDir?: string } = {}): AgentTypeRegistry {
  const spawnable = spawnableToolNames();
  const types = new Map<string, AgentType>();
  const warnings: string[] = [];

  for (const dir of [opts.globalDir ?? globalAgentsDir(), resolve(cwd, ".minima", "agents")]) {
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
    } catch {
      continue; // no such dir — the normal case
    }
    for (const file of entries.sort()) {
      const path = join(dir, file);
      let src: string;
      try {
        src = readFileSync(path, "utf8");
      } catch (exc) {
        warnings.push(`${path}: unreadable (${String(exc)})`);
        continue;
      }
      const parsed = parseAgentType(file, src, { spawnable, source: path });
      warnings.push(...parsed.warnings);
      if (parsed.type) types.set(parsed.type.name, parsed.type);
    }
  }
  return { types, warnings };
}

function hasItems(x: unknown): boolean {
  return Array.isArray(x) && x.length > 0;
}

/**
 * Resolve a delegation's `agent_type` into concrete fields. Total and order-independent:
 * an absent or unknown type name is the identity (the authoring-time validator is what
 * rejects a typo; a direct createSpawn caller must not crash on one).
 *
 * A preset fills a field ONLY when the delegation left it unset — an explicitly authored
 * value always wins. An empty array counts as unset: the lead writing `tool_allowlist: []`
 * means "unrestricted", which must not silently unlock a read-only type.
 */
export function applyAgentType(
  d: Delegation,
  registry: AgentTypeRegistry | null | undefined,
): { delegation: Delegation; type: AgentType | null } {
  const key = d.agent_type?.trim().toLowerCase();
  const type = key ? (registry?.types.get(key) ?? null) : null;
  if (!type) return { delegation: d, type: null };
  return {
    delegation: {
      ...d,
      ...(!hasItems(d.tool_allowlist) && hasItems(type.tools)
        ? { tool_allowlist: type.tools }
        : {}),
      ...(!hasItems(d.candidates) && hasItems(type.candidates)
        ? { candidates: type.candidates }
        : {}),
      ...(d.effort === undefined && type.effort ? { effort: type.effort } : {}),
      ...(d.budget_usd === undefined && type.budget_usd !== undefined
        ? { budget_usd: type.budget_usd }
        : {}),
      ...(d.isolation === undefined && type.isolation ? { isolation: type.isolation } : {}),
    },
    type,
  };
}

/**
 * A plan step's view of a type: the two fields a step can actually enforce. `tools` is
 * checked by the dispatcher's per-step allowlist while the step is in progress;
 * `candidates` becomes the step's routing pool. The persona/effort/budget of a type are
 * meaningless for a step (the LEAD executes it in-band, under its own system prompt) and
 * are deliberately NOT applied — a step named after an agent gets that agent's scope, not
 * its identity.
 *
 * Like {@link applyAgentType}, an authored value always wins and an unknown name is inert.
 */
export function agentTypePlanPreset(
  step: { agent_type?: string; tools?: string[]; candidates?: string[] },
  registry: AgentTypeRegistry | null | undefined,
): { tools?: string[]; candidates?: string[] } {
  const key = step.agent_type?.trim().toLowerCase();
  const type = key ? (registry?.types.get(key) ?? null) : null;
  if (!type) return {};
  return {
    ...(!hasItems(step.tools) && hasItems(type.tools) ? { tools: type.tools } : {}),
    ...(!hasItems(step.candidates) && hasItems(type.candidates)
      ? { candidates: type.candidates }
      : {}),
  };
}
