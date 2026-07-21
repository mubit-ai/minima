/**
 * A6 — per-step tool allowlist (task permissions).
 *
 * A plan step may declare a `tools` allowlist (JSON string[] on `plan_steps.tools`): the minimal
 * set of tools that step is permitted to call. While such a step is in progress, the dispatcher
 * HARD-BLOCKS any call to a MUTATING/expensive tool that is not on the list — enforcement in the
 * dispatcher, not the prompt (the model can't talk its way past a code block). This narrows the
 * blast radius of a step to exactly the tools its author scoped it to: a "write the docs" step that
 * declares `["edit"]` can never `bash rm -rf` or delegate a `task`.
 *
 * PURE + total: every function is safe on malformed input. The DB seam is threaded by the caller
 * (big_plan.ts reads the in-progress step); this module only decides.
 *
 * Design rules:
 *  - NULL / "[]" allowlist → UNRESTRICTED (the historical behavior — a step with no authored
 *    allowlist behaves exactly as before; A6 is opt-in per step).
 *  - {@link ALWAYS_ALLOWED} tools are NEVER blocked: the harness-control tools (todowrite —
 *    updating the plan / marking a step done runs the gate; question — asking the user) and the
 *    read-only inspection tools (read/ls/glob/grep — a read can't cause a mistake). Blocking any of
 *    these would wedge a run, not prevent an error. The allowlist meaningfully gates the mutating
 *    and side-effecting tools (write/edit/apply_patch/bash/task/web_fetch/web_search).
 *  - Fail-open on any infrastructure error (handled by the caller): a broken read never blocks a turn.
 */

/** Every tool the harness ships. Used to validate an authored allowlist (a typo is a real bug). */
export const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "bash",
  "ls",
  "glob",
  "grep",
  "todowrite",
  "web_fetch",
  "web_search",
  "task",
  "question",
]);

/**
 * Tools a per-step allowlist can NEVER block, regardless of what the step declared:
 *  - `todowrite` / `question`: harness control — blocking them would wedge the run (the agent could
 *    not update the plan, mark the step done, or ask for help).
 *  - `read` / `ls` / `glob` / `grep`: read-only inspection — a read cannot cause a mistake, so
 *    gating it only produces false blocks. The allowlist's job is to fence MUTATION, not reading.
 */
export const ALWAYS_ALLOWED: ReadonlySet<string> = new Set([
  "todowrite",
  "question",
  "read",
  "ls",
  "glob",
  "grep",
]);

/** The gated tools — the complement of {@link ALWAYS_ALLOWED} within {@link KNOWN_TOOLS}. A per-step
 *  allowlist only ever restricts these; used by the plan lint to reason about a step's needs. */
export const GATED_TOOLS: ReadonlySet<string> = new Set(
  [...KNOWN_TOOLS].filter((t) => !ALWAYS_ALLOWED.has(t)),
);

/**
 * Parse a `plan_steps.tools` JSON string into a normalized allowlist, or null when the step is
 * unrestricted (NULL column, empty array, or unparseable — fail-open to "no restriction"). Total.
 */
export function parseStepTools(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const clean = parsed
    .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
    .filter(Boolean);
  return clean.length > 0 ? clean : null;
}

/** The decision: may `toolName` run while a step whose allowlist is `allow` is in progress? */
export interface AllowlistDecision {
  block: boolean;
  /** Present only when `block` is true — the message returned to the model. */
  reason?: string;
}

const ALLOW: AllowlistDecision = { block: false };

/**
 * Decide whether a tool call is permitted under a step's allowlist. `allow` is the parsed list
 * ({@link parseStepTools}); a null/empty list is unrestricted → always allowed. An
 * {@link ALWAYS_ALLOWED} tool is always allowed. Otherwise the tool must appear (case-insensitively)
 * in the list, or the call is blocked with a reason naming the permitted set. Total.
 */
export function stepAllowlistDecision(
  toolName: string,
  allow: readonly string[] | null,
  stepContent?: string | null,
): AllowlistDecision {
  if (!allow || allow.length === 0) return ALLOW;
  const name = (toolName ?? "").trim().toLowerCase();
  if (!name || ALWAYS_ALLOWED.has(name)) return ALLOW;
  if (allow.includes(name)) return ALLOW;
  const where = stepContent?.trim() ? ` for the current step ("${stepContent.trim()}")` : "";
  const permitted = [...allow].join(", ");
  const reason = [
    `Tool \`${name}\` is not on the allowlist${where}. This step is scoped to: ${permitted}`,
    "(read-only tools read/ls/glob/grep and todowrite/question are always allowed).",
    "The call was refused before executing. Do this step's work with the permitted tools,",
    `or if the step genuinely needs \`${name}\`, widen its allowlist with todowrite`,
    "(resend the task with the tool added to its `tools`).",
  ].join(" ");
  return { block: true, reason };
}
