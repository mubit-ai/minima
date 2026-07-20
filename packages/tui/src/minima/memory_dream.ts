/**
 * Memory dream (B3) — offline consolidation with the label-quality moat: only episodes
 * the deterministic gate spine actually VERIFIED (green-tier, red→green) feed workflow
 * memories. Every published strategy-memory system (ReasoningBank, AWM, Voyager) grades
 * its own episodes with self-judgment; this one distills exclusively from
 * `evidence_source="gate"` history, and the distillation itself is deterministic — pure
 * ledger facts, no LLM call, so a dream costs nothing and never hallucinates a step.
 *
 * Dreams contract (Anthropic): a dream NEVER mutates its input — it only emits NEW
 * candidate rows, always `pending`, for the user to review with /memory (confirm/pin/
 * reject). Reconciliation is skip-only: a candidate similar to ANY existing row
 * (including rejected/invalidated — never resurrect) is dropped, not merged.
 *
 * Replay-with-cheap (Memp strong→weak transfer): once a workflow is confirmed active,
 * (a) B1's projection injects it into every turn's context, and (b) prompts that match
 * its goal route with tags=["procedure:known"] — tags flow into the server's cluster
 * keying, so procedure-present tasks accumulate their own outcome pool and Thompson
 * learns organically that known-procedure work can run on cheaper models. No server
 * change needed.
 */

import type { MemoryRow, MinimaDb, PlanRow } from "../db/minima_db.ts";
import { similarity } from "./memory_scribe.ts";

/** One green-verified closed plan, ready to distill. */
export interface GreenEpisode {
  plan: PlanRow;
  goal: string;
  steps: { content: string; verify: string | null }[];
  gateIds: string[];
  recIds: string[];
}

/**
 * Closed plans whose evidence clears the moat: every step completed, and at least one
 * gate that is deterministic + verified + green (the only origin allowed to feed a
 * workflow). Judge-verified or yellow-tier plans never qualify.
 */
export function mineGreenEpisodes(db: MinimaDb, projectKey: string, limit = 25): GreenEpisode[] {
  const episodes: GreenEpisode[] = [];
  for (const plan of db.listClosedPlans(projectKey, limit)) {
    const steps = db.getPlanSteps(plan.id);
    if (steps.length === 0 || !steps.every((s) => s.status === "completed")) continue;
    const gates = db.getGates(plan.id);
    const green = gates.filter(
      (g) =>
        g.outcome === "verified" && g.verified_by === "deterministic" && g.confidence === "green",
    );
    if (green.length === 0) continue;
    episodes.push({
      plan,
      goal: (plan.title ?? steps[0]?.content ?? "").trim(),
      steps: steps.map((s) => ({ content: (s.content ?? "").trim(), verify: s.verify })),
      gateIds: green.map((g) => g.id),
      recIds: [...new Set(green.map((g) => g.rec_id).filter((r): r is string => Boolean(r)))],
    });
  }
  return episodes;
}

/** Deterministic workflow text: goal, ordered steps, and the verify recipe — verbatim
 * ledger facts (generalization is the reader's job; fabrication is worse than fidelity). */
export function distillWorkflow(ep: GreenEpisode): { content: string; trigger: string } {
  const lines = ep.steps.map(
    (s, i) => `${i + 1}. ${s.content}${s.verify ? ` (verify: \`${s.verify}\`)` : ""}`,
  );
  const goal = ep.goal || "unnamed task";
  return {
    content: `Verified workflow — ${goal}:\n${lines.join("\n")}`,
    trigger: goal,
  };
}

const DREAM_SKIP_SIMILARITY = 0.7;

export interface DreamReport {
  episodes: number;
  added: string[];
  /** Candidates dropped because a similar row already exists (any status — skip-only). */
  skippedExisting: number;
}

/**
 * One dream pass: mine green episodes → distill → write NEW pending rows only. Existing
 * rows are never touched; near-duplicates (vs everything ever written) are dropped.
 */
export function runDream(db: MinimaDb, projectKey: string): DreamReport {
  const report: DreamReport = { episodes: 0, added: [], skippedExisting: 0 };
  const episodes = mineGreenEpisodes(db, projectKey);
  report.episodes = episodes.length;
  if (episodes.length === 0) return report;
  const existing = db.listMemories(projectKey, { includeInvalidated: true, limit: 500 });
  const writtenThisPass: string[] = [];
  for (const ep of episodes) {
    const { content, trigger } = distillWorkflow(ep);
    const isDupe = (rows: { content: string }[]) =>
      rows.some((row) => similarity(content, row.content) >= DREAM_SKIP_SIMILARITY);
    if (isDupe(existing) || isDupe(writtenThisPass.map((c) => ({ content: c })))) {
      report.skippedExisting += 1;
      continue;
    }
    const id = db.insertMemory({
      projectKey,
      kind: "workflow",
      content,
      trigger,
      citations: [...ep.recIds, ...ep.gateIds, ep.plan.id],
      evidenceSource: "gate",
      origin: "scribe",
      status: "pending", // dreams NEVER auto-activate — the user applies the diff
      actor: "dream",
    });
    writtenThisPass.push(content);
    report.added.push(id);
  }
  return report;
}

/** Human-readable diff view of a dream pass for /memory dream. */
export function formatDreamReport(db: MinimaDb, report: DreamReport): string {
  if (report.episodes === 0) {
    return "Dream pass: no green-verified closed plans to distill from yet — finish a plan whose checks go red→green and try again.";
  }
  if (report.added.length === 0) {
    return `Dream pass: ${report.episodes} green episode(s) inspected — nothing new (${report.skippedExisting} already captured).`;
  }
  const lines = report.added.map((id) => {
    const row = db.getMemory(id);
    const first = (row?.content ?? "").split("\n")[0] ?? "";
    return `  + ${id.slice(0, 8)} [workflow] ${first}`;
  });
  return `Dream pass: ${report.added.length} new workflow candidate(s), all pending — review and apply:\n${lines.join(
    "\n",
  )}\nConfirm with /memory confirm <n|id> (or reject). Existing memories were not modified.`;
}

/** Match threshold for tagging a prompt as procedure-backed. */
const PROCEDURE_MATCH_SIMILARITY = 0.3;

/**
 * B3 replay-with-cheap: does a CONFIRMED (active/pinned) workflow cover this task?
 * Matching is goal-vs-task token overlap — cheap, deterministic, and biased toward
 * false negatives (a missed tag costs nothing; a wrong tag pollutes cluster keying).
 */
export function knownProcedureFor(
  db: MinimaDb,
  projectKey: string,
  task: string,
): MemoryRow | null {
  const rows = db.listMemories(projectKey, { statuses: ["active", "pinned"], limit: 100 });
  for (const row of rows) {
    if (row.kind !== "workflow") continue;
    const goal = row.trigger ?? row.content.split("\n")[0] ?? "";
    if (similarity(task, goal) >= PROCEDURE_MATCH_SIMILARITY) return row;
  }
  return null;
}
