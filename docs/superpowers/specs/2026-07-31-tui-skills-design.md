# TUI Skills — design

Claude Code-style SKILL.md packs for the minima TUI harness (`packages/tui`): markdown
instruction packs discovered from disk, listed to the model, loaded on demand via a tool,
and invocable by the user as slash commands.

## Discovery

New module `packages/tui/src/skills.ts`. Scans four roots, in precedence order:

1. `<cwd>/.minima/skills/` (project)
2. `~/.minima-harness/skills/` (global)
3. `<cwd>/.claude/skills/` (Claude Code project compat, read-only)
4. `~/.claude/skills/` (Claude Code global compat, read-only)

Each skill is a directory containing a `SKILL.md` whose YAML frontmatter carries `name`
and `description`. All other frontmatter keys are ignored in v1. The first occurrence of a
name wins (project shadows global shadows Claude compat). Discovery runs once at startup;
a malformed skill (missing/unparseable frontmatter, missing name or description) is
skipped with a warning and never fatal. Frontmatter parsing is a minimal in-module parser
for the flat `key: value` block — no YAML dependency.

Skill shape:

```
.minima/skills/deploy/
  SKILL.md          # ---\nname: deploy\ndescription: ...\n---\n<instructions>
  references/…      # optional support files, read by the agent with the read tool
```

## Model side — the `skill` tool

A new tool registered in `src/tools/` following the existing tool pattern. Its
description embeds the discovered skill list as `name — description` lines, so the model
sees what exists at zero extra context cost until a skill is actually loaded. If no skills
were discovered, the tool is not registered at all.

Input: `{ name: string }`. Output: the SKILL.md body (frontmatter stripped) plus the
skill's absolute directory path, so the agent can read support files with the existing
`read` tool. Unknown name → error result listing valid names.

No separate list tool, no caching layer, no reload.

## User side — slash invocation

- `/skills` — lists discovered skills (name, description, source root).
- `/<skill-name> [args]` — if the input does not match a built-in command but matches a
  discovered skill name, it expands into a user prompt instructing the agent to invoke
  the `skill` tool for that skill, with any trailing text passed as arguments. Built-in
  commands always win collisions; a skill named `plan` is reachable only via the tool.

## Out of scope (v1)

- No Minima routing/feedback coupling — loading a skill is prompt injection, not an LLM
  call; nothing is booked to the ledger.
- No `allowed-tools`, `context: fork`, or other frontmatter directives.
- No sandboxing or execution model for skill scripts — the agent uses its normal tools
  under normal permissions.
- No hot-reload — restart picks up new skills.
- No plugin namespacing (`plugin:skill`).

## Testing

Hermetic bun tests (`packages/tui/tests/skills.test.ts`): fixture skill dirs under a temp
dir, asserting discovery across roots, precedence/shadowing, frontmatter parsing,
malformed-skill skip, tool output (body + dir path, frontmatter stripped), unknown-name
error, and `/skills` / `/<name>` dispatch including built-in collision precedence. No
network, no spend.
