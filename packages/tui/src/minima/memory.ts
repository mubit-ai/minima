/**
 * HarnessMemory — lets a MinimaAgent *use* Mubit memory, not just Minima's model
 * recommender. Port of the Python harness's minima/memory.py to the TS harness (the binary
 * shipped users actually run).
 *
 * The harness read Mubit lessons but never wrote outcomes back, so the loop was open.
 * This closes it:
 *  - recall(task)      -> task-relevant prior context, injected before the model runs.
 *  - recordOutcome(..) -> a trace + an outcome score, attributed to the recommendation
 *    (idempotency_key / reference_id = recommendationId). Never fabricates: a judge
 *    abstention (quality === null) records the trace but no score.
 *  - endSession()      -> reflect + checkpoint, distilling a run into durable memory.
 *
 * Default is NoopHarnessMemory, so MinimaAgent behaves exactly as before unless a
 * MubitHarnessMemory is wired in. The Mubit-backed impl is fail-open (memory must never
 * break a coding run) and talks to the @mubit-ai/sdk Client through a small structural
 * interface, so this module + its tests need neither the SDK nor a network.
 */

const RECALL_ENTRY_TYPES = ["lesson", "rule", "observation"];
const MAX_SNIPPETS = 5;
const MAX_SNIPPET_CHARS = 240;

/**
 * Write-side lane partition. Two structurally incompatible writers share one Mubit
 * backend: the Minima SERVER writes typed OutcomeRecord JSON (intent=observation,
 * lane=minima:<namespace>, its own run ids) and this HARNESS writes free-text traces.
 * Stamping every harness write with its own lane keeps the two deliberately
 * partitioned at the source, whatever run ids are in play. Recall is deliberately
 * NOT lane-filtered yet — pre-partition entries have no lane and would vanish from
 * recall; filter once unlaned data has aged out.
 */
const HARNESS_LANE = "harness";

export interface OutcomeRecord {
  task: string;
  recommendationId: string;
  modelId: string;
  outcome: string;
  quality: number | null;
  costUsd: number;
  latencyMs: number;
  turns: number;
}

export interface HarnessMemory {
  /** Short prior-context snippets relevant to `task` (possibly empty). */
  recall(task: string, limit?: number): Promise<string[]>;
  /** Persist this turn's realized outcome, attributed to its recommendation. */
  recordOutcome(record: OutcomeRecord): Promise<void>;
  /** Distil the session into durable memory (reflect + checkpoint). */
  endSession(): Promise<void>;
}

/** The subset of the @mubit-ai/sdk Client this module uses (structural — for injection). */
export interface MemoryClient {
  recall(req: Record<string, unknown>): Promise<unknown>;
  remember(req: Record<string, unknown>): Promise<unknown>;
  recordOutcome(req: Record<string, unknown>): Promise<unknown>;
  reflect(req: Record<string, unknown>): Promise<unknown>;
  checkpoint(req: Record<string, unknown>): Promise<unknown>;
}

/** Memory disabled — the default. Every method is a no-op / empty. */
export class NoopHarnessMemory implements HarnessMemory {
  async recall(): Promise<string[]> {
    return [];
  }
  async recordOutcome(): Promise<void> {}
  async endSession(): Promise<void> {}
}

/** Render recalled snippets as a compact, clearly-delimited system-prompt section. */
export function formatRecallBlock(snippets: string[]): string {
  const lines = snippets.map((s) => `- ${s}`).join("\n");
  // Framed as passive background, NOT an instruction: recall is keyed by repo (not session), so a
  // fresh chat inherits these; an imperative "apply when relevant" made the model act on habits
  // (e.g. run ls) before the user asked for anything. Keep it reference-only.
  const header =
    "Background context from earlier work on this project, for reference only. Do NOT run tools or " +
    "take any action based on this memory unless the user's current request actually calls for it.";
  return `<prior_learnings source="mubit">\n${header}\n${lines}\n</prior_learnings>`;
}

function snippetOf(entry: unknown): string {
  if (typeof entry === "string") return entry.trim().slice(0, MAX_SNIPPET_CHARS);
  if (entry && typeof entry === "object") {
    for (const key of ["content", "text", "summary"]) {
      const v = (entry as Record<string, unknown>)[key];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, MAX_SNIPPET_CHARS);
    }
  }
  return "";
}

/** recall() may return an array or a wrapper ({entries|evidence|results|items: [...]}). */
function entriesOf(res: unknown): unknown[] {
  if (Array.isArray(res)) return res;
  if (res && typeof res === "object") {
    for (const key of ["entries", "evidence", "results", "items", "memories"]) {
      const v = (res as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

/**
 * Mubit-SDK-backed memory: session-scoped writes, project-scoped recall, fail-open.
 * `client` is any object matching MemoryClient (the real @mubit-ai/sdk Client does).
 */
export class MubitHarnessMemory implements HarnessMemory {
  constructor(
    private readonly client: MemoryClient,
    private readonly sessionId: string,
    private readonly agentId = "minima-harness",
  ) {}

  async recall(task: string, limit = MAX_SNIPPETS): Promise<string[]> {
    if (!task.trim()) return [];
    const cap = Math.max(1, Math.min(limit, MAX_SNIPPETS));
    try {
      // The SDK requires a session_id (or run_id) for recall. We use a STABLE per-repo session
      // id (see createMubitMemory), so recall surfaces prior outcomes accumulated on this repo
      // across runs — the point of a coding agent's memory — and writes land under the same id.
      const res = await this.client.recall({
        query: task,
        limit: cap,
        entry_types: RECALL_ENTRY_TYPES,
        session_id: this.sessionId,
      });
      const out: string[] = [];
      for (const entry of entriesOf(res)) {
        const text = snippetOf(entry);
        if (text) out.push(text);
        if (out.length >= cap) break;
      }
      return out;
    } catch {
      return []; // recall must never break a run
    }
  }

  async recordOutcome(record: OutcomeRecord): Promise<void> {
    if (!record.recommendationId) return;
    const q = record.quality === null ? "n/a" : record.quality.toFixed(3);
    const trace =
      `model=${record.modelId} outcome=${record.outcome} quality=${q} ` +
      `cost_usd=${record.costUsd.toFixed(6)} latency_ms=${record.latencyMs} turns=${record.turns} ` +
      `:: ${record.task.trim().slice(0, 160)}`;
    try {
      // Trace, attributed to the recommendation for provenance + dedup.
      await this.client.remember({
        content: trace,
        intent: "trace",
        session_id: this.sessionId,
        agent_id: this.agentId,
        idempotency_key: record.recommendationId,
        lane: HARNESS_LANE,
      });
      // Close the loop with a real outcome score tied to the recommendation. Never
      // fabricate — a judge abstention (quality === null) records the trace but no score.
      if (record.quality !== null) {
        await this.client.recordOutcome({
          signal: record.quality,
          outcome: record.outcome,
          reference_id: record.recommendationId,
          session_id: this.sessionId,
        });
      }
    } catch {
      // write-back must never break a run
    }
  }

  async endSession(): Promise<void> {
    try {
      await this.client.reflect({ session_id: this.sessionId });
      await this.client.checkpoint({
        context_snapshot: "",
        label: "session-end",
        session_id: this.sessionId,
      });
    } catch {
      // session teardown must never break shutdown
    }
  }
}
