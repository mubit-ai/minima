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
import { formatCriticNote, runPlanCritic } from "./plan_critic.ts";
import { formatFindings, hasBlockers, synthAuditFindings } from "./plan_lint.ts";
import type { GroundTruthSynthesis, PlanSessionStore } from "./plan_session.ts";
import { attachAutoGates, formatAutoGateNote, mineRepoGates } from "./repo_gates.ts";

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
  /** E1 Planning Critic seam (injectable for tests). Runs on the synthesized steps. */
  critic?: typeof runPlanCritic;
  /** Books the critic call's realized spend (meter + budget), like judge spend. */
  onCriticCostUsd?: (usd: number) => void;
  /** E3 auto-gates: where to mine repo checks. Omitted/null = mining disabled — callers
   * opt in explicitly (the TUI passes cwd), so library users and tests are never
   * surprised by an attached command. */
  repoDir?: string | null;
  /** E3 seam (injectable for tests). */
  mineGates?: typeof mineRepoGates;
}

export type PlanFinalizeOutcome =
  | { kind: "blocked"; message: string }
  | { kind: "write-failed"; message: string }
  | {
      kind: "ok";
      md: string;
      outPath: string;
      seededCount: number;
      /** MP18: the seeded steps' verify commands — plan approval IS their consent event. */
      seededVerifies: string[];
      auditNote: string;
      /** metaModel was available but synthesis still failed — the doc is the deterministic
       * assembly, nothing was seeded, and the caller MUST surface it (silence cost the
       * whole plan ledger once). */
      synthFailed: boolean;
      /** E1 Planning Critic findings (advisory, also folded into auditNote). [] = explicit
       * OK; null = critic skipped (no model / unusable reply / error). */
      criticFlags: string[] | null;
    };

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
  // An abort mid-synthesis (Esc while finalize was running) must not half-finalize: nothing
  // was written yet, so refuse and keep plan mode ON — the user retries deliberately.
  if (deps.signal?.aborted) {
    return {
      kind: "blocked",
      message:
        "Finalize aborted before the ground truth was written — plan mode stays ON. " +
        "Run /plan finalize (or approve exit_plan again) to retry.",
    };
  }

  // E3 auto-gates: fill verify-less steps with the repo's OWN check commands (mined from
  // manifests — trusted by construction, never agent-authored oracles). Fast command
  // (typecheck/lint) in-loop; the full test suite on the final step. Attached BEFORE the
  // audit/doc/critic/seed so everything downstream — including the plan the user approves,
  // which is the MP18 consent event for these commands — sees the same checks.
  // MINIMA_TUI_AUTO_GATES=0 opts out.
  let autoGateNote = "";
  if (synth && synth.approach.length > 0 && deps.repoDir) {
    try {
      if (process.env.MINIMA_TUI_AUTO_GATES !== "0") {
        const mine = deps.mineGates ?? mineRepoGates;
        const gates = mine(deps.repoDir);
        if (gates.length > 0) {
          const result = attachAutoGates(
            synth.approach.map((st) => ({ content: st.action, verify: st.verify })),
            gates,
          );
          if (result.attached.length > 0) {
            synth.approach = synth.approach.map((st, i) => ({
              ...st,
              verify: result.steps[i]?.verify ?? st.verify,
            }));
            autoGateNote = formatAutoGateNote(result);
          }
        }
      }
    } catch {
      // mining is fail-open — a broken manifest never blocks finalize
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
  const seededVerifies: string[] = [];
  if (deps.db && deps.runId && synth && synth.approach.length > 0) {
    try {
      const seedSteps = synth.approach
        .map((st) => ({ content: st.action.trim(), verify: st.verify, tools: st.tools }))
        .filter((st) => st.content.length > 0);
      if (seedSteps.length > 0) {
        seededCount = deps.db.seedPlanFromSteps(deps.runId, synth.title || null, seedSteps).stepIds
          .length;
        // MP18: the verifies the user just approved WITH the plan — the caller feeds them
        // into the consent store, so the first in_progress todowrite (which carries no
        // verify text of its own) does not dead-end at the execution-time consent check.
        for (const st of seedSteps) {
          const v = (st.verify ?? "").trim();
          if (v) seededVerifies.push(v);
        }
      }
    } catch {
      // fail-open
    }
  }

  // E1 Planning Critic: one cheap completion over the approved steps + their checks —
  // are the verifies discriminative (red before the work)? hidden step dependencies?
  // Advisory only (folded into the note, never a blocker); fail-open like synthesis.
  // Runs AFTER the write so a slow/flaky critic can never cost the plan document.
  let criticFlags: string[] | null = null;
  if (deps.metaModel && synth && synth.approach.length > 0 && !deps.signal?.aborted) {
    const critic = deps.critic ?? runPlanCritic;
    criticFlags = await critic({
      metaModel: deps.metaModel,
      steps: synth.approach.map((st) => ({ action: st.action, verify: st.verify })),
      signal: deps.signal,
      onCostUsd: deps.onCriticCostUsd,
    });
  }

  const auditNote =
    (auditFindings.length > 0 ? `\n\n${formatFindings(auditFindings)}` : "") +
    autoGateNote +
    formatCriticNote(criticFlags);
  return {
    kind: "ok",
    md,
    outPath: deps.outPath,
    seededCount,
    seededVerifies,
    auditNote,
    synthFailed: deps.metaModel != null && synth === null,
    criticFlags,
  };
}
