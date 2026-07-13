/**
 * A6 — static plan lint + poka-yoke audit.
 *
 * A pure, deterministic pass over a plan's steps that catches mistake-prone patterns BEFORE the
 * agent executes them (poka-yoke = mistake-proofing). It encodes "the characteristics of a good
 * plan" (docs/characteristics_of_a_good_plan.md) as rules over the three things a step carries: its
 * `action`, its `verify` check, and its `tools` allowlist.
 *
 * Two severities matter operationally:
 *  - `blocker` — a mistake serious enough to refuse `/plan finalize` (a fabricated always-passing
 *    check, a typo'd tool that would block the step at runtime, an empty plan). Overridable with
 *    `/plan finalize --force`.
 *  - `warn` / `info` — advisory: surfaced at finalize and via `/audit`, never blocks (matching the
 *    planner bridge's nudge/advise stance).
 *
 * PURE + total: no I/O, no throw. `lintPlan` is the single entry point; the DB/synth adapters keep
 * it usable over both a finalized `SynthPlanStep[]` and the persisted `PlanStepRow[]`.
 */

import type { PlanStepRow } from "../db/minima_db.ts";
import type { SynthPlanStep } from "./plan_session.ts";
import { KNOWN_TOOLS, parseStepTools } from "./tool_permissions.ts";

/** The normalized unit the lint reasons over — an adapter target for synth steps and DB rows. */
export interface LintStep {
  content: string;
  verify: string;
  tools: string[];
}

export type LintSeverity = "blocker" | "warn" | "info";

export interface PlanFinding {
  rule: string;
  severity: LintSeverity;
  message: string;
  /** 0-based step index the finding is about; omitted for plan-level findings (e.g. empty-plan). */
  stepIdx?: number;
}

const SEVERITY_RANK: Record<LintSeverity, number> = { blocker: 0, warn: 1, info: 2 };
const SEVERITY_GLYPH: Record<LintSeverity, string> = { blocker: "🔴", warn: "🟡", info: "🟢" };

/** Normalize a finalized synth plan into lint steps. */
export function stepsFromSynth(approach: readonly SynthPlanStep[]): LintStep[] {
  return approach
    .map((st) => ({
      content: st.action.trim(),
      verify: (st.verify ?? "").trim(),
      tools: (st.tools ?? []).map((t) => t.trim()).filter(Boolean),
    }))
    .filter((st) => st.content.length > 0);
}

/** Normalize persisted plan rows into lint steps (parsing the `tools` JSON column). */
export function stepsFromRows(rows: readonly PlanStepRow[]): LintStep[] {
  return rows.map((r) => ({
    content: (r.content ?? "").trim(),
    verify: (r.verify ?? "").trim(),
    tools: parseStepTools(r.tools) ?? [],
  }));
}

/**
 * A `verify` that provably ALWAYS passes proves nothing — a fabricated green. We flag it only when
 * EVERY chained segment is a no-op (so `echo building && bun test` is fine — the test gates it, but
 * `echo done` or `true` or `echo x && exit 0` is not). Conservative like the tamper markers: a
 * false blocker is annoying, a missed one lets a fake check ship, so the no-op set stays tight.
 */
const NOOP_SEGMENT = /^(true|:|exit\s+0|pwd|clear|echo\b.*|printf\b.*|#.*)$/;

function isNonGatingVerify(verify: string): boolean {
  const v = verify.trim();
  if (!v) return false; // "no verify" is a separate (warn) rule, not "non-gating"
  const segments = v
    .split(/&&|\|\||[;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((s) => NOOP_SEGMENT.test(s));
}

/** Vague verbs that, used alone, describe an unverifiable blob of work rather than a concrete step. */
const VAGUE_ONLY = /^(refactor|cleanup|clean\s?up|improve|polish|tidy|fix|update|handle|misc)\b/i;

function isVagueAction(action: string): boolean {
  const words = action.split(/\s+/).filter(Boolean);
  if (words.length < 3) return true; // 1–2 words can't name a concrete, checkable change
  // A short phrase led by a vague verb with no object beyond a word or two ("improve the code").
  return words.length <= 4 && VAGUE_ONLY.test(action);
}

/**
 * Lint a plan against the characteristics of a good plan. Findings are returned most-severe-first
 * (blockers, then warns, then infos), stable within a severity by step order. Total.
 */
export function lintPlan(steps: readonly LintStep[]): PlanFinding[] {
  const findings: PlanFinding[] = [];

  if (steps.length === 0) {
    findings.push({
      rule: "empty-plan",
      severity: "blocker",
      message: "The plan has no implementation steps — nothing to execute or verify.",
    });
    return findings;
  }

  // Cross-step: a verify reused verbatim on multiple steps likely isn't step-specific evidence.
  const verifyCounts = new Map<string, number>();
  for (const s of steps) {
    if (s.verify) verifyCounts.set(s.verify, (verifyCounts.get(s.verify) ?? 0) + 1);
  }

  steps.forEach((step, idx) => {
    const at = `step ${idx + 1}`;

    if (!step.verify) {
      findings.push({
        rule: "no-verify",
        severity: "warn",
        message: `${at} ("${step.content}") has no verify command — decompose it into steps you can check, or accept it as unverified scaffolding.`,
        stepIdx: idx,
      });
    } else if (isNonGatingVerify(step.verify)) {
      findings.push({
        rule: "non-gating-verify",
        severity: "blocker",
        message: `${at} verify \`${step.verify}\` always passes and proves nothing — replace it with a real red→green check (a test, build, or exit code).`,
        stepIdx: idx,
      });
    } else if ((verifyCounts.get(step.verify) ?? 0) > 1) {
      findings.push({
        rule: "duplicate-verify",
        severity: "warn",
        message: `${at} shares its verify \`${step.verify}\` with another step — a shared check rarely proves each step individually; give this step its own.`,
        stepIdx: idx,
      });
    }

    if (isVagueAction(step.content)) {
      findings.push({
        rule: "vague-action",
        severity: "warn",
        message: `${at} ("${step.content}") is too vague to verify — name the concrete change so a check can prove it.`,
        stepIdx: idx,
      });
    }

    const unknown = step.tools.filter((t) => !KNOWN_TOOLS.has(t.toLowerCase()));
    if (unknown.length > 0) {
      findings.push({
        rule: "unknown-tool",
        severity: "blocker",
        message: `${at} allowlists unknown tool${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} — a typo here would block the step at runtime. Use real tool names (read, write, edit, apply_patch, bash, glob, grep, ls, web_search, web_fetch, task).`,
        stepIdx: idx,
      });
    }

    // A checkable step that writes code but scopes no allowlist is unrestricted — advise (never
    // block) authoring a minimal `tools` list so a stray mutation can't slip through.
    if (step.verify && !isNonGatingVerify(step.verify) && step.tools.length === 0) {
      findings.push({
        rule: "no-allowlist",
        severity: "info",
        message: `${at} declares no tool allowlist (unrestricted). Consider scoping it to the tools it needs (e.g. edit, bash) so off-scope tools are blocked.`,
        stepIdx: idx,
      });
    }
  });

  findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.stepIdx ?? -1) - (b.stepIdx ?? -1),
  );
  return findings;
}

/** True when any finding would refuse `/plan finalize` (absent `--force`). */
export function hasBlockers(findings: readonly PlanFinding[]): boolean {
  return findings.some((f) => f.severity === "blocker");
}

/** Render findings as a compact, glyph-prefixed report; a clean plan returns the `clean` line. */
export function formatFindings(
  findings: readonly PlanFinding[],
  clean = "🟢 Plan audit: no issues found.",
): string {
  if (findings.length === 0) return clean;
  const blockers = findings.filter((f) => f.severity === "blocker").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  const infos = findings.filter((f) => f.severity === "info").length;
  const counts = [
    blockers ? `🔴 ${blockers} blocker${blockers === 1 ? "" : "s"}` : "",
    warns ? `🟡 ${warns} warning${warns === 1 ? "" : "s"}` : "",
    infos ? `🟢 ${infos} note${infos === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [`Plan audit: ${counts}`];
  for (const f of findings) lines.push(`  ${SEVERITY_GLYPH[f.severity]} [${f.rule}] ${f.message}`);
  return lines.join("\n");
}
