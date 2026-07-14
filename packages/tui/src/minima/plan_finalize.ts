/**
 * finalizePlan — the /plan finalize core, extracted from the TUI closure so the exit_plan
 * tool and the slash command share ONE path: resolve open questions (fail-open), distil the
 * planning conversation into a ground-truth synthesis (fail-open), run the A6 poka-yoke
 * audit (blockers refuse unless force), write GROUND_TRUTH.md DIRECTLY (not via the agent
 * tool loop — plan mode's read-only block must not apply to the harness's own artifact),
 * and seed the check-engine ledger. Mode exit and message pushes stay with the callers.
 */

import type { Message } from "../ai/types.ts";
import type { Model } from "../ai/types.ts";
import { errText } from "../errtext.ts";
import { answerOpenQuestions, synthesizeGroundTruth } from "./plan_council.ts";
import { formatFindings, hasBlockers, synthAuditFindings } from "./plan_lint.ts";
import type { GroundTruthSynthesis, PlanSessionStore } from "./plan_session.ts";

export interface PlanFinalizeDb {
  seedPlanFromSteps(
    sessionId: string,
    title: string | null,
    steps: { content: string; verify?: string | null; tools?: string[] | null }[],
  ): { planId: string; stepIds: string[] };
}

export interface PlanFinalizeDeps {
  /** null → skip question-resolution and synthesis (deterministic toGroundTruth(null)). */
  metaModel: Model | null;
  signal: AbortSignal | null;
  force: boolean;
  transcript: string;
  outPath: string;
  db: PlanFinalizeDb | null;
  runId: string | null;
  write?: (path: string, content: string) => Promise<unknown>;
  answerQuestions?: typeof answerOpenQuestions;
  synthesize?: typeof synthesizeGroundTruth;
}

export type PlanFinalizeOutcome =
  | { kind: "blocked"; message: string }
  | { kind: "write-failed"; message: string }
  | { kind: "ok"; md: string; outPath: string; seededCount: number; auditNote: string };

/** The planning conversation as a labelled transcript (user/planner turns only). */
export function buildPlanTranscript(messages: Message[]): string {
  return messages
    .filter((msg) => msg.role === "user" || msg.role === "assistant")
    .map((msg) => {
      const body = msg.textContent.trim();
      return body ? `${msg.role === "user" ? "User" : "Planner"}: ${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export async function finalizePlan(
  store: PlanSessionStore,
  deps: PlanFinalizeDeps,
): Promise<PlanFinalizeOutcome> {
  const write = deps.write ?? ((path, content) => Bun.write(path, content));
  const answerQuestions = deps.answerQuestions ?? answerOpenQuestions;
  const synthesize = deps.synthesize ?? synthesizeGroundTruth;

  // Auto-resolve any lingering open questions with a reasonable default so the ground
  // truth is complete and decisive. Fail-open: a flaky model just leaves them unanswered.
  if (deps.metaModel) {
    try {
      const resolved = await answerQuestions(store.session, {
        metaModel: deps.metaModel,
        signal: deps.signal,
      });
      for (const r of resolved) {
        store.answerQuestion(r.question, r.answer, "council", r.rationale);
      }
    } catch {
      // fail-open
    }
  }

  // Distil the WHOLE planning conversation (not just accumulated council state) into a
  // detailed, structured ground truth. Fail-open: on any error the deterministic assembly
  // (toGroundTruth(null) → toMarkdown()) is used instead so finalize always writes a doc.
  let synth: GroundTruthSynthesis | null = null;
  if (deps.metaModel) {
    try {
      synth = await synthesize(store.session, deps.transcript, {
        metaModel: deps.metaModel,
        signal: deps.signal,
      });
    } catch {
      // fail-open
    }
  }

  // A6 poka-yoke audit: statically lint the finalized plan against the characteristics of a
  // good plan. Blocker-severity findings (a fabricated always-passing check, a typo'd tool
  // allowlist, an empty plan) REFUSE finalize unless forced; warns/infos are advisory and
  // surfaced in the success note. An empty approach still lints (so the empty-plan blocker
  // fires); only a null synth (synthesis failed) skips the audit.
  const auditFindings = synthAuditFindings(synth ? synth.approach : null);
  if (hasBlockers(auditFindings) && !deps.force) {
    return {
      kind: "blocked",
      message: `${formatFindings(auditFindings)}\n\nFinalize refused — fix the blocker(s) above, or re-run \`/plan finalize --force\` to override. The plan was not written and plan mode stays ON.`,
    };
  }

  const md = store.toGroundTruth(synth);
  try {
    await write(deps.outPath, md);
  } catch (exc) {
    return { kind: "write-failed", message: `Failed to write ${deps.outPath}: ${errText(exc)}` };
  }

  // Bridge the approved plan into the check-engine ledger: seed each implementation step
  // (with its verify) as a pending, user-origin plan step so execution inherits the
  // deliberated verifiable steps instead of re-inventing them. Fail-open: seeding is
  // bookkeeping and must never block finalize.
  let seededCount = 0;
  if (deps.db && deps.runId && synth && synth.approach.length > 0) {
    try {
      const seedSteps = synth.approach
        .map((st) => ({ content: st.action.trim(), verify: st.verify, tools: st.tools }))
        .filter((st) => st.content.length > 0);
      if (seedSteps.length > 0) {
        seededCount = deps.db.seedPlanFromSteps(deps.runId, synth.title || null, seedSteps).stepIds
          .length;
      }
    } catch {
      // fail-open
    }
  }

  const auditNote = auditFindings.length > 0 ? `\n\n${formatFindings(auditFindings)}` : "";
  return { kind: "ok", md, outPath: deps.outPath, seededCount, auditNote };
}
