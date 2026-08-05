/**
 * `git_commit` (F9a, MUB-230) — model-initiated commits under their own permission-gated
 * name, rather than hidden inside an opaque bash string. Registration is all this module
 * owns; the commit itself lives in session/commit.ts, which `/commit` calls too so the two
 * surfaces cannot drift.
 *
 * Naming the tool is the point: `git_commit` is allowed or denied on its own, and a user who
 * has granted "always allow `git` commands" to bash has not thereby granted committing.
 */

import type { AgentTool, ToolResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { type CommitDeps, commitChanges } from "../session/commit.ts";
import { objectSchema } from "./schema.ts";

export type { CommitDeps };

/**
 * Paths as the model actually sends them: a real array, the JSON-array string the schema
 * asks for (objectSchema has no array type — todowrite's string-of-JSON contract is the
 * house pattern), or a single bare path. Anything else commits the staged index instead.
 */
function parsePaths(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((p) => String(p));
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((p) => String(p));
    } catch {
      // not JSON after all — fall through and treat it as one path
    }
  }
  return [trimmed];
}

export function gitCommitTool(deps: CommitDeps): AgentTool {
  return {
    name: "git_commit",
    description:
      "Create a git commit in the user's repository. Commits what is already staged, or " +
      "exactly the `paths` you pass — it never stages the whole worktree. The user's " +
      "pre-commit and commit-msg hooks run, and a hook rejection comes back as an error " +
      "with the hook's own output. The commit is authored by the user's git identity; " +
      "co-author attribution for the models that contributed and a run pointer are added " +
      "for you, so do not write Co-Authored-By or Minima-Run-Id trailers yourself. Prefer " +
      "this over `git commit` through bash: only this path is attributed.",
    parameters: objectSchema(
      {
        message: {
          type: "string",
          description:
            "The complete commit message: a concise subject line, then a blank line and a " +
            "body explaining WHY when the change needs one.",
        },
        paths: {
          type: "string",
          description:
            'Optional JSON array of paths to commit, e.g. ["src/a.ts", "src/b.ts"]. ' +
            "Omit to commit whatever is currently staged.",
          default: "",
          coerce: (v) => (Array.isArray(v) ? JSON.stringify(v) : v),
        },
      },
      ["message"],
    ),
    executionMode: "sequential",
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const result = await commitChanges(deps, {
        message: String(params.message ?? ""),
        paths: parsePaths(params.paths),
      });
      if (result.ok) {
        return {
          content: [text(result.report)],
          details: { committed: true, sha: result.sha },
        };
      }
      // Outside a repo there is no action to have failed — report it plainly. Every other
      // failure IS a failed action (a hook rejection, a refusal, git's own error), and
      // throwing is what stamps is_error on the tool result so it cannot read as a no-op.
      if (result.kind === "no-repo") {
        return { content: [text(result.reason)], details: { committed: false } };
      }
      throw new Error(result.reason);
    },
  };
}

/** Registration is the kill switch: MINIMA_TUI_GIT=0 leaves no `git_commit` tool to call. */
export function registerGitCommitTool(
  tools: AgentTool[],
  enabled: boolean,
  deps: CommitDeps,
): void {
  if (!enabled) return;
  tools.push(gitCommitTool(deps));
}
