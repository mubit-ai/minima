/**
 * Default SpawnFn — builds one child MinimaAgent per delegation.
 *
 * Each child gets: its own cost-aware routing (a fresh MinimaAgent over the parent's
 * config → per-node difficulty reaches the server), its own CostMeter, a tool set scoped
 * by the delegation's allowlist and CONFINED to the parent's workdir (M-B), a per-node
 * budget stop (running cost sum via shouldStopAfterTurn), an abort tree (parent abort →
 * child.abort()) plus an effort-scaled wall-clock timeout, and tagged event forwarding so
 * the UI can render a live sub-agent tree. Child rows land in the parent's DB under
 * agentId=childId, so sub-agent spend/decisions demux from the lead's.
 */

import type { AgentEvent } from "../agent/events.ts";
import { AssistantMessage } from "../ai/types.ts";
import { newId } from "../db/minima_db.ts";
import { attachDbSink } from "../db/sink.ts";
import { builtinTools } from "../tools/builtin.ts";
import { extractJson, reaskMessage, validateAgainstSchema } from "../tools/output_schema.ts";
import type { ChildResult, Delegation, SpawnContext, SpawnFn } from "../tools/task.ts";
import type { ToolArtifacts } from "../tools/types.ts";
import { makeBashSteerHook } from "./bash_steer.ts";
import { bigPlanAttributionSink, recordOpaqueMarker } from "./big_plan.ts";
import { MinimaError } from "./errors.ts";
import { CostMeter } from "./meter.ts";
import { MinimaAgent } from "./runtime.ts";

export interface ChildEvent {
  childId: string;
  stepId: string;
  depth: number;
  event: AgentEvent;
}

export interface CreateSpawnOptions {
  parent: MinimaAgent;
  /** Confinement base for the child's FS tools (default: process.cwd()). */
  workdir?: string;
  /** Live sub-agent tree feed (optional). */
  onChildEvent?: (e: ChildEvent) => void;
  /** Wall-clock caps per effort level, ms. */
  timeouts?: { light?: number; standard?: number; deep?: number };
  /** Artifact spill store shared with the lead (P1): children spill to the same dir and
   * their confined read gains the artifact-root allowance. */
  artifacts?: ToolArtifacts;
}

const TURNS_BY_EFFORT = { light: 6, standard: 12, deep: 24 } as const;
const TIMEOUT_BY_EFFORT = { light: 120_000, standard: 300_000, deep: 600_000 } as const;

/** A recommend rejection of the offered candidate pool (HTTP 422 or an explicit
 *  no-candidates detail) — the ONLY route-error class the step-pool retry may absorb. */
export function isNoCandidatesRouteError(exc: unknown): boolean {
  if (exc instanceof MinimaError && exc.status === 422) return true;
  return exc instanceof Error && /no[\s_-]?candidates?/i.test(exc.message);
}

/** Render the delegation contract + dependency results as the child's system prompt. */
export function delegationPrompt(d: Delegation, ctx: SpawnContext): string {
  const lines = [
    "You are a focused sub-agent executing ONE delegated subtask.",
    `## Objective\n${d.objective}`,
    `## Return exactly\n${d.output_format}`,
  ];
  if (d.output_schema) {
    lines.push(
      `## Output schema (STRICT)\nYour final reply MUST be a single JSON value that validates against this JSON Schema. Reply with ONLY the JSON — no prose, no markdown fences.\n\`\`\`json\n${JSON.stringify(
        d.output_schema,
        null,
        2,
      )}\n\`\`\``,
    );
  }
  lines.push(`## Boundaries (do NOT touch)\n${d.boundaries}`);
  if (d.tool_guidance) lines.push(`## Tool guidance\n${d.tool_guidance}`);
  const deps = (d.depends_on ?? [])
    .map((id) => ctx.priorResults.find((r) => r.step_id === id))
    .filter((r): r is ChildResult => Boolean(r));
  if (deps.length) {
    lines.push(
      `## Results from prerequisite steps\n${deps
        .map((r) =>
          r.data !== undefined
            ? `### ${r.step_id} [${r.outcome}] (validated JSON)\n${JSON.stringify(r.data, null, 2)}`
            : `### ${r.step_id} [${r.outcome}]\n${r.text}`,
        )
        .join("\n")}`,
    );
  }
  // Children don't inherit the lead's system prompt, so the operational discipline the
  // lead runs under (read-before-edit, verify-after-change) must be restated here — a
  // live bench showed children editing files without running any verification.
  lines.push(
    [
      "## Rules",
      "- Read a file before editing it; never guess contents.",
      "- After changing files, verify (run the relevant test or command) when possible and include the result.",
      "- Boundaries override the objective. If the objective cannot be completed without crossing them, " +
        'change nothing and reply with ONE line starting with "BLOCKED: " followed by the reason.',
    ].join("\n"),
  );
  lines.push("Do the work with your tools, then reply with ONLY the requested output.");
  return lines.join("\n\n");
}

export function createSpawn(opts: CreateSpawnOptions): SpawnFn {
  const parent = opts.parent;

  return async (d: Delegation, ctx: SpawnContext): Promise<ChildResult> => {
    const childId = `${d.step_id}-${newId().slice(0, 8)}`;
    const effort = d.effort ?? "standard";

    // Typed outputs (W4.3): enforce a schema only when the flag is on AND the delegation
    // carries one. Flag-off (or schema-less) strips the field before prompt-building so the
    // schema-less path builds the byte-identical prompt/agent.
    const typed = parent.config.typedTask === true && d.output_schema != null;
    const promptDelegation = typed ? d : { ...d, output_schema: undefined };

    // Resolve per-child workdir: "workdir" isolation gets a fresh git worktree so
    // parallel children editing the same files can't clobber each other's writes.
    const origWorkdir = opts.workdir ?? process.cwd();
    let childWorkdir = origWorkdir;
    let worktreePath: string | null = null;
    let dirtyWarning: string | null = null;

    if (d.isolation === "workdir") {
      worktreePath = `/tmp/minima-wt-${childId}`;
      try {
        const statusProc = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: origWorkdir });
        if (statusProc.stdout.toString().trim()) {
          dirtyWarning =
            "note: worktree created from dirty working tree — uncommitted changes are not visible to this child";
        }
        const addProc = Bun.spawnSync(["git", "worktree", "add", worktreePath, "HEAD"], {
          cwd: origWorkdir,
        });
        if (addProc.exitCode === 0) {
          childWorkdir = worktreePath;
        } else {
          worktreePath = null; // fallback: run in parent workdir
        }
      } catch {
        worktreePath = null;
      }
    }

    let tools = builtinTools({
      workdir: childWorkdir,
      exclude: ["task"],
      artifacts: opts.artifacts,
    });
    if (d.tool_allowlist?.length) {
      const allowed = new Set(d.tool_allowlist);
      tools = tools.filter((t) => allowed.has(t.name));
    }

    // Per-step candidate pool (dispatcher enforcement, never prompt text): keep only ids the
    // model registry resolves; empty-after-filter falls back to the parent pool. Applied as
    // pre-request candidate assembly via config.candidates — `pinned` stays false so the
    // child still routes (a pool is never a pin).
    const requestedPool = (d.candidates ?? [])
      .map((c) => (typeof c === "string" ? c.trim() : ""))
      .filter(Boolean);
    const stepPool = requestedPool.filter((id) => parent.mapping.resolve("", id) !== undefined);
    const poolApplied = stepPool.length > 0;

    // Per-node budget: stop the child gracefully once its realized spend hits its slice.
    let spent = 0;
    const budget = d.budget_usd;
    const child = new MinimaAgent({
      // bigPlan never inherits: children have no plan hooks (lead-only by design), so an
      // inheriting child would get plan-verification guidance + the LEAD's plan projection in its prompts
      // and consult the shared gates ledger in its feedback — cross-agent poisoning.
      config: {
        ...parent.config,
        pinned: false,
        bigPlan: false,
        ...(poolApplied ? { candidates: stepPool } : {}),
      },
      // Share the parent's router (same client/transport/auth) — rebuilding one from
      // config would bypass injected transports and re-do auth per child.
      router: parent.router,
      mapping: parent.mapping,
      judge: parent.judge,
      meter: new CostMeter(),
      tools,
      maxTurns: TURNS_BY_EFFORT[effort],
      systemPrompt: delegationPrompt(promptDelegation, ctx),
      shouldStopAfterTurn:
        budget !== undefined
          ? async (assistant: AssistantMessage) => {
              spent += assistant.usage.cost.total;
              return spent >= budget;
            }
          : undefined,
    });
    // Child rows demux from the lead's in the shared DB.
    child.db = parent.db;
    child.runId = parent.runId;
    child.agentId = childId;
    child.memory = parent.memory;
    // Hook-order contract (P2): bash-steer registers FIRST on the child's beforeToolCall
    // stack too — first block wins (same contract as main.ts's lead-agent registration).
    child.addBeforeToolCall(makeBashSteerHook(parent.config));

    const unsubscribe = opts.onChildEvent
      ? child.subscribe((event) =>
          opts.onChildEvent?.({ childId, stepId: d.step_id, depth: ctx.depth, event }),
        )
      : null;
    const sink =
      parent.db && parent.runId
        ? attachDbSink(child, parent.db, { runId: parent.runId, agentId: childId })
        : null;
    // Plan write attribution (file_changes ONLY — children never touch gates/baselines/plans):
    // a shared-workdir child's writes land attributed to agent_id=childId; a worktree child's
    // edits are invisible here AND its bash can still reach the parent repo via absolute
    // paths, so it leaves one opaque marker instead — Factors.blind caps the tier at yellow
    // (signal lost, never a false green).
    if (parent.config.bigPlan && parent.db && parent.runId) {
      if (worktreePath) {
        try {
          recordOpaqueMarker(parent.db, parent.runId, `subagent:${childId} (worktree)`, childId);
        } catch {
          // fail-open bookkeeping
        }
      } else {
        child.addAfterToolCall(bigPlanAttributionSink(parent, childId));
      }
    }

    // Abort tree: parent abort → child abort; plus an effort-scaled wall-clock cap.
    let timedOut = false;
    const onAbort = () => child.abort();
    ctx.parentSignal?.addEventListener("abort", onAbort);
    const timeoutMs = opts.timeouts?.[effort] ?? TIMEOUT_BY_EFFORT[effort];
    const timer = setTimeout(() => {
      timedOut = true;
      child.abort();
    }, timeoutMs);

    let runError: unknown = null;
    // Typed enforcement bookkeeping (W4.3): `validated` present iff the schema was enforced
    // and the reply passed; `typedFailure` set iff enforcement ran and the reply is still
    // invalid after the single re-ask (or a re-ask was skipped by an exhausted budget).
    let validated: { has: true; value: unknown } | { has: false } = { has: false };
    let typedFailure: string | null = null;
    try {
      try {
        await child.promptRouted(d.objective, {
          difficulty: d.difficulty,
          tags: ["phase:subtask"],
        });
      } catch (exc) {
        // Route-failure fallback: a step pool the server cannot satisfy (422/no-candidates)
        // degrades to the parent pool — retried ONCE; any other error (or a second failure)
        // surfaces as this child's failure.
        if (poolApplied && isNoCandidatesRouteError(exc)) {
          child.config.candidates = [...parent.config.candidates];
          await child.promptRouted(d.objective, {
            difficulty: d.difficulty,
            tags: ["phase:subtask"],
          });
        } else {
          throw exc;
        }
      }

      // Schema enforcement runs dispatcher-side (createSpawn owns the live child that
      // executeDag never sees), inside this try so the effort timer / abort / event
      // forwarding / DB sink all cover the re-ask too. Skipped when the first run already
      // failed/timed out/was aborted/replied BLOCKED.
      if (typed && d.output_schema) {
        const schema = d.output_schema;
        const first = lastAssistantOf(child);
        const firstText = first?.textContent ?? "";
        const abortedNow = timedOut || Boolean(ctx.parentSignal?.aborted);
        const failedNow = first?.stop_reason === "error";
        const blockedNow = firstText.trimStart().startsWith("BLOCKED:");
        if (!abortedNow && !failedNow && !blockedNow) {
          const check = validateReply(firstText, schema);
          if (check.ok) {
            validated = { has: true, value: check.value };
          } else if (budget !== undefined && spent >= budget) {
            typedFailure = `output did not satisfy the schema and the step budget ($${budget}) is exhausted — the re-ask was skipped.\nViolations:\n${check.errors
              .map((e) => `- ${e}`)
              .join("\n")}`;
          } else {
            // The single re-ask: same call shape as the pool-fallback retry, continuing
            // the same conversation (D3: tags stay ["phase:subtask"]).
            await child.promptRouted(reaskMessage(schema, check.errors), {
              difficulty: d.difficulty,
              tags: ["phase:subtask"],
            });
            const second = lastAssistantOf(child);
            const check2 = validateReply(second?.textContent ?? "", schema);
            if (check2.ok) {
              validated = { has: true, value: check2.value };
            } else {
              typedFailure = `output did not satisfy the required schema after one re-ask.\nViolations:\n${check2.errors
                .map((e) => `- ${e}`)
                .join("\n")}\n\nLast reply:\n${truncate(second?.textContent ?? "", 500)}`;
            }
          }
        }
      }
    } catch (exc) {
      runError = exc;
    } finally {
      clearTimeout(timer);
      ctx.parentSignal?.removeEventListener("abort", onAbort);
      sink?.detach();
      unsubscribe?.();
      if (worktreePath) {
        Bun.spawnSync(["git", "worktree", "remove", "--force", worktreePath], { cwd: origWorkdir });
      }
    }

    const last = lastAssistantOf(child);
    const row = child.meter?.rows.at(-1) ?? null;
    const aborted = timedOut || Boolean(ctx.parentSignal?.aborted);
    const failedRun = runError !== null || last?.stop_reason === "error";
    // The delegation prompt tells a child whose objective conflicts with its boundaries
    // to reply "BLOCKED: <reason>". That is a correct refusal, not an accomplishment —
    // without this cap the parent saw outcome=success and could not tell "did it" from
    // "couldn't do it" (the judge is off by default).
    const blocked =
      !aborted && !failedRun && (last?.textContent ?? "").trimStart().startsWith("BLOCKED:");
    // A typed failure (schema still unmet after the re-ask) is a real failure: dependents
    // block off it exactly like any failed prerequisite. It cannot coexist with abort/failedRun
    // (enforcement is skipped in those cases).
    const typedFailed = !aborted && !failedRun && typedFailure !== null;
    const outcome: ChildResult["outcome"] = aborted
      ? "aborted"
      : failedRun
        ? "failure"
        : typedFailed
          ? "failure"
          : blocked
            ? "partial"
            : ((row?.outcome as ChildResult["outcome"] | undefined) ?? "success");

    const resultText = aborted
      ? `aborted after ${Math.round(timeoutMs / 1000)}s (${effort} cap)`
      : failedRun
        ? `error: ${last?.error_message ?? String(runError ?? "unknown")}`
        : typedFailed
          ? typedFailure!
          : validated.has
            ? JSON.stringify(validated.value, null, 2)
            : (last?.textContent ?? "");

    return {
      step_id: d.step_id,
      childId,
      text: dirtyWarning ? `${dirtyWarning}\n\n${resultText}` : resultText,
      costUsd: child.meter?.totals().actualCostUsd ?? 0,
      quality: row?.quality ?? null,
      outcome,
      ...(validated.has ? { data: validated.value } : {}),
      workdir: childWorkdir,
    };
  };
}

/** Extract JSON from a child's reply and validate it against the subset schema. */
function validateReply(
  reply: string,
  schema: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false; errors: string[] } {
  const extracted = extractJson(reply);
  if (!extracted.ok) return { ok: false, errors: [extracted.error] };
  const errors = validateAgainstSchema(extracted.value, schema);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: extracted.value };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… [truncated ${s.length - max} chars]`;
}

function lastAssistantOf(agent: MinimaAgent): AssistantMessage | null {
  const msgs = agent.agentState.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m instanceof AssistantMessage) return m;
  }
  return null;
}
