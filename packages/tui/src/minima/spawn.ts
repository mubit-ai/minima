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
import type { ChildResult, Delegation, SpawnContext, SpawnFn } from "../tools/task.ts";
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
}

const TURNS_BY_EFFORT = { light: 6, standard: 12, deep: 24 } as const;
const TIMEOUT_BY_EFFORT = { light: 120_000, standard: 300_000, deep: 600_000 } as const;

/** Render the delegation contract + dependency results as the child's system prompt. */
export function delegationPrompt(d: Delegation, ctx: SpawnContext): string {
  const lines = [
    "You are a focused sub-agent executing ONE delegated subtask.",
    `## Objective\n${d.objective}`,
    `## Return exactly\n${d.output_format}`,
    `## Boundaries (do NOT touch)\n${d.boundaries}`,
  ];
  if (d.tool_guidance) lines.push(`## Tool guidance\n${d.tool_guidance}`);
  const deps = (d.depends_on ?? [])
    .map((id) => ctx.priorResults.find((r) => r.step_id === id))
    .filter((r): r is ChildResult => Boolean(r));
  if (deps.length) {
    lines.push(
      `## Results from prerequisite steps\n${deps
        .map((r) => `### ${r.step_id} [${r.outcome}]\n${r.text}`)
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

    // A tool_allowlist matching nothing (misspelled names, or web tools without
    // EXA_API_KEY) would spawn a zero-tool child that burns a routed turn and returns a
    // spurious text-only "success" — fail the delegation fast with the reason instead.
    if (d.tool_allowlist?.length) {
      const available = new Set(builtinTools({ exclude: ["task"] }).map((t) => t.name));
      if (!d.tool_allowlist.some((n) => available.has(n))) {
        const webHint = d.tool_allowlist.some((n) => n === "web_search" || n === "web_fetch")
          ? " (web tools require EXA_API_KEY)"
          : "";
        return {
          step_id: d.step_id,
          childId,
          text: `BLOCKED: tool_allowlist [${d.tool_allowlist.join(", ")}] matches no available tool${webHint}`,
          costUsd: 0,
          quality: null,
          outcome: "failure",
          workdir: opts.workdir ?? process.cwd(),
        };
      }
    }

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

    let tools = builtinTools({ workdir: childWorkdir, exclude: ["task"] });
    if (d.tool_allowlist?.length) {
      const allowed = new Set(d.tool_allowlist);
      tools = tools.filter((t) => allowed.has(t.name));
    }

    // Per-node budget: stop the child gracefully once its realized spend hits its slice.
    let spent = 0;
    const budget = d.budget_usd;
    const child = new MinimaAgent({
      config: { ...parent.config, pinned: false },
      // Share the parent's router (same client/transport/auth) — rebuilding one from
      // config would bypass injected transports and re-do auth per child.
      router: parent.router,
      mapping: parent.mapping,
      judge: parent.judge,
      meter: new CostMeter(),
      tools,
      maxTurns: TURNS_BY_EFFORT[effort],
      systemPrompt: delegationPrompt(d, ctx),
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

    const unsubscribe = opts.onChildEvent
      ? child.subscribe((event) =>
          opts.onChildEvent?.({ childId, stepId: d.step_id, depth: ctx.depth, event }),
        )
      : null;
    const sink =
      parent.db && parent.runId
        ? attachDbSink(child, parent.db, { runId: parent.runId, agentId: childId })
        : null;

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
    try {
      await child.promptRouted(d.objective, { difficulty: d.difficulty });
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
    const outcome: ChildResult["outcome"] = aborted
      ? "aborted"
      : failedRun
        ? "failure"
        : blocked
          ? "partial"
          : ((row?.outcome as ChildResult["outcome"] | undefined) ?? "success");

    const resultText = aborted
      ? `aborted after ${Math.round(timeoutMs / 1000)}s (${effort} cap)`
      : failedRun
        ? `error: ${last?.error_message ?? String(runError ?? "unknown")}`
        : (last?.textContent ?? "");

    return {
      step_id: d.step_id,
      childId,
      text: dirtyWarning ? `${dirtyWarning}\n\n${resultText}` : resultText,
      costUsd: child.meter?.totals().actualCostUsd ?? 0,
      quality: row?.quality ?? null,
      outcome,
      workdir: childWorkdir,
    };
  };
}

function lastAssistantOf(agent: MinimaAgent): AssistantMessage | null {
  const msgs = agent.agentState.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m instanceof AssistantMessage) return m;
  }
  return null;
}
