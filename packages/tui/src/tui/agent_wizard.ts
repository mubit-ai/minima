/**
 * `/agent make` — the fill-in-the-blanks path to an agent type.
 *
 * The definition format is a markdown file with YAML frontmatter, and the two directories it
 * can live in are the whole discoverability problem. This walks the fields one prompt at a
 * time, validates each answer where a wrong one would silently produce an agent the author did
 * not describe (a bad name never loads; an unknown tool name is dropped by spawn.ts), and hands
 * the finished draft to `scaffoldAgentType` to persist.
 *
 * Pure and synchronous: the TUI owns the draft state and the rendering, this owns the
 * questions, the validation and the order. Everything optional is skippable with a bare Enter.
 */

import { AGENT_NAME_RE, spawnableToolNames } from "../minima/agent_types.ts";

export interface AgentDraft {
  /** Index into {@link WIZARD_FIELDS} — the field being answered right now. */
  step: number;
  name: string;
  description: string;
  role: string;
  /** Unset = unrestricted (every tool except `task`), which is the harness default. */
  tools?: string[];
  budget_usd?: number;
  global: boolean;
}

export const WIZARD_FIELDS = ["name", "description", "role", "tools", "budget", "scope"] as const;

export function newAgentDraft(name = ""): AgentDraft {
  const draft: AgentDraft = { step: 0, name: "", description: "", role: "", global: false };
  // A name given on the command line (`/agent make reviewer`) answers step 0 up front — but only
  // if it is usable, so a typo still gets the validating prompt instead of being silently kept.
  if (AGENT_NAME_RE.test(name.trim().toLowerCase())) {
    draft.name = name.trim().toLowerCase();
    draft.step = 1;
  }
  return draft;
}

/** The prompt for the current field: a one-line question plus what a bare Enter does. */
export function wizardQuestion(d: AgentDraft): string {
  switch (WIZARD_FIELDS[d.step]) {
    case "name":
      return "name — lowercase, e.g. reviewer";
    case "description":
      return "description — one line; this is how the lead agent picks the type";
    case "role":
      return "role — what it does and how it should work (Enter to skip)";
    case "tools":
      return "tools — space-separated allowlist, or Enter for all";
    case "budget":
      return "budget — spend cap in USD per run, e.g. 0.25 (Enter for none)";
    default:
      return "scope — [p] this repo · [g] every repo";
  }
}

/** A second line of help under the question, where the valid answers aren't guessable. */
export function wizardHint(d: AgentDraft): string | null {
  switch (WIZARD_FIELDS[d.step]) {
    case "tools":
      return [...spawnableToolNames()].sort().join(" ");
    case "scope":
      return "p → .minima/agents (committable, shadows global) · g → ~/.minima-harness/agents";
    default:
      return null;
  }
}

export type WizardResult =
  | { kind: "next"; draft: AgentDraft }
  | { kind: "error"; message: string }
  | { kind: "done"; draft: AgentDraft };

/** Apply one answer. The draft is never mutated — the caller swaps in the returned one. */
export function wizardAdvance(d: AgentDraft, raw: string): WizardResult {
  const answer = raw.trim();
  const next = (patch: Partial<AgentDraft>): WizardResult => {
    const draft = { ...d, ...patch, step: d.step + 1 };
    return draft.step >= WIZARD_FIELDS.length ? { kind: "done", draft } : { kind: "next", draft };
  };

  switch (WIZARD_FIELDS[d.step]) {
    case "name": {
      const name = answer.toLowerCase();
      if (!AGENT_NAME_RE.test(name)) {
        return { kind: "error", message: 'lowercase letters, digits, "_" or "-" — e.g. reviewer' };
      }
      return next({ name });
    }
    case "description":
      if (!answer)
        return { kind: "error", message: "a description is required — one line is fine" };
      return next({ description: answer });
    case "role":
      return next({ role: answer });
    case "tools": {
      if (!answer) return next({ tools: undefined });
      const spawnable = spawnableToolNames();
      const wanted = answer.split(/[\s,]+/).filter(Boolean);
      const unknown = wanted.filter((t) => !spawnable.has(t));
      // Rejecting here is the point: spawn.ts intersects the allowlist silently, so a typo
      // would hand over a weaker agent than the author described — or, if EVERY name is wrong,
      // a toolless one.
      if (unknown.length) {
        return {
          kind: "error",
          message: `unknown tool${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
        };
      }
      return next({ tools: wanted });
    }
    case "budget": {
      if (!answer) return next({ budget_usd: undefined });
      const usd = Number(answer.replace(/^\$/, ""));
      if (!Number.isFinite(usd) || usd <= 0) {
        return { kind: "error", message: "a positive dollar amount, e.g. 0.25" };
      }
      return next({ budget_usd: usd });
    }
    default: {
      const c = answer.toLowerCase()[0];
      if (c === "g") return next({ global: true });
      if (c === "p" || !answer) return next({ global: false });
      return { kind: "error", message: "[p] this repo or [g] every repo" };
    }
  }
}

/** What's been answered so far, for the live draft box. */
export function wizardSummary(d: AgentDraft): string[] {
  const rows: string[] = [];
  if (d.step > 0) rows.push(`name         ${d.name}`);
  if (d.step > 1) rows.push(`description  ${d.description}`);
  if (d.step > 2) rows.push(`role         ${d.role || "(none)"}`);
  if (d.step > 3) rows.push(`tools        ${d.tools?.join(" ") ?? "(all)"}`);
  if (d.step > 4) rows.push(`budget       ${d.budget_usd ? `$${d.budget_usd}` : "(none)"}`);
  return rows;
}
