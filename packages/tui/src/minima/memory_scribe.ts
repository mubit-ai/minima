/**
 * Memory scribe (B2) — the background curator that turns ledger facts into curated
 * memories. Design constraints (all load-bearing):
 *
 * - Letta split: ONLY this module writes memories automatically; the primary agent has no
 *   memory-write tool. Everything it writes is `origin="scribe"`.
 * - Ledger-fed, never transcript-fed: signals come from SQL over gates / user_signals /
 *   routing_decisions — the harness's verified record, not the model's own narration.
 * - Recurrence-gated: a pattern must appear ≥2 times across the project's history before
 *   it is worth an LLM call — except user corrections, which distill immediately.
 * - Routed + budget-booked: the one extraction call routes THROUGH Minima
 *   (tags=["memory:extract"], cost-lean) and its spend books to the meter/budget like
 *   judge spend. Offline / no key / low budget → skip silently, never block.
 * - Provenance activation: gate-cited candidates auto-activate; everything else lands
 *   `pending` for /memory confirm.
 * - mem0 reconciliation: candidate vs similar existing rows → ADD/UPDATE/NOOP, every op an
 *   audit event; rejected/invalidated rows are never resurrected. (DELETE is not emitted
 *   by extraction — retirement is the staleness guards' and the user's job.)
 *
 * Triggers only ever enqueue `memory_jobs` rows; `drainMemoryJobs` claims and runs them,
 * so curation survives crashes and never races a live turn.
 */

import { complete } from "../ai/stream.ts";
import { Message } from "../ai/types.ts";
import type {
  GateHistoryRow,
  MemoryJobRow,
  MemoryRow,
  MinimaDb,
  UserSignalHistoryRow,
} from "../db/minima_db.ts";
import type { BudgetLedger } from "./budget.ts";
import type { CostMeter } from "./meter.ts";
import type { MinimaRouter } from "./router.ts";

// ---------------------------------------------------------------- signals

export type ScribeSignalKind =
  | "gate_flip"
  | "verified_failure"
  | "user_correction"
  | "judge_gate_disagreement"
  | "observer_flag";

export interface ScribeSignal {
  kind: ScribeSignalKind;
  /** Recurrence key material (normalized) — same pattern twice unlocks distillation. */
  pattern: string;
  /** Evidence line shown to the extractor. */
  detail: string;
  recIds: string[];
  gateIds: string[];
  ts: number;
  /** User corrections skip the recurrence gate. */
  immediate: boolean;
  /** Occurrence count this signal represents (a step that failed 2x = the pattern
   * appearing twice, folded into one signal). Feeds the recurrence gate. */
  weight: number;
}

export function normalizePattern(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
}

function gateTs(createdAt: string | null): number {
  const ms = createdAt ? Date.parse(createdAt) : Number.NaN;
  return Number.isFinite(ms) ? ms / 1000 : 0;
}

/**
 * Mine the project's ledger for curation-worthy signals. Pure reads; the whole history is
 * re-derived each pass (state lives in the ledger — reconciliation dedups downstream).
 */
export function mineSignals(db: MinimaDb, projectKey: string): ScribeSignal[] {
  const out: ScribeSignal[] = [];

  // Red→green flips and unresolved verified failures, per step.
  const byStep = new Map<string, GateHistoryRow[]>();
  for (const g of db.getProjectGateHistory(projectKey)) {
    if (!g.step_id || (g.kind !== "step_check" && g.kind !== "milestone")) continue;
    const rows = byStep.get(g.step_id) ?? [];
    rows.push(g);
    byStep.set(g.step_id, rows);
  }
  for (const rows of byStep.values()) {
    // `rows` is insertion-ordered (created_at, rowid) — positions, not timestamps, decide
    // "after" (gates minted in the same millisecond share an ISO created_at).
    const failed = rows.filter((g) => g.outcome === "failed");
    if (failed.length === 0) continue;
    const firstFail = failed[0]!;
    const firstFailIdx = rows.indexOf(firstFail);
    const flip = rows.find((g, i) => g.outcome === "verified" && i > firstFailIdx);
    const stepText = firstFail.step_content ?? "";
    const verify = firstFail.step_verify ? ` (verify: \`${firstFail.step_verify}\`)` : "";
    const ids = (list: GateHistoryRow[]) => ({
      gateIds: list.map((g) => g.id),
      recIds: [...new Set(list.map((g) => g.rec_id).filter((r): r is string => Boolean(r)))],
    });
    if (flip) {
      const evidence = [...failed, flip];
      out.push({
        kind: "gate_flip",
        pattern: normalizePattern(stepText),
        detail: `step "${stepText}" failed its check ${failed.length}x, then passed${verify}`,
        ...ids(evidence),
        ts: gateTs(flip.created_at),
        immediate: false,
        weight: failed.length,
      });
    } else {
      out.push({
        kind: "verified_failure",
        pattern: normalizePattern(stepText),
        detail: `step "${stepText}" failed its check ${failed.length}x and never passed${verify}`,
        ...ids(failed),
        ts: gateTs(failed[failed.length - 1]!.created_at),
        immediate: false,
        weight: failed.length,
      });
    }
  }

  // User reject/steer overrides — the highest-value, immediate signal.
  for (const s of db.getProjectUserCorrections(projectKey)) {
    const what =
      s.note?.trim() || `user ${s.action}ed the result of step "${s.step_content ?? ""}"`;
    out.push({
      kind: "user_correction",
      pattern: normalizePattern(s.note ?? s.step_content),
      detail: `user correction: ${what}`,
      recIds: [],
      gateIds: s.gate_id ? [s.gate_id] : [],
      ts: gateTs(s.at),
      immediate: true,
      weight: 1,
    });
  }

  // Judge grades that contradict deterministic gate verdicts.
  for (const d of db.getProjectJudgeGateDisagreements(projectKey)) {
    const model = String(d.chosen_model ?? "?");
    const taskType = String(d.task_type ?? "?");
    out.push({
      kind: "judge_gate_disagreement",
      pattern: normalizePattern(`${taskType} ${model} judge-gate`),
      detail: `judge graded ${Number(d.quality).toFixed(2)} but the gate said ${String(d.big_plan_outcome)} (${taskType} on ${model})`,
      recIds: [String(d.rec_id)],
      gateIds: [],
      ts: Number(d.ts) || 0,
      immediate: false,
      weight: 1,
    });
  }

  // Observer warn-verdicts (PR-E): a pattern the observer kept flagging is worth
  // remembering. Recurrence-gated like every non-immediate signal, and never gate-cited
  // (verdicts are advisory, not verified evidence) — so provenance keeps any resulting
  // memory `pending` until the user confirms it.
  for (const v of db.getProjectObserverFlags(projectKey)) {
    out.push({
      kind: "observer_flag",
      pattern: normalizePattern(`${v.kind} ${v.claim}`),
      detail: `observer flagged: ${v.claim} (${v.kind})`,
      recIds: [],
      gateIds: [],
      ts: Number(v.created_at) || 0,
      immediate: false,
      weight: 1,
    });
  }

  return out.sort((a, b) => a.ts - b.ts);
}

/** RecMem-shaped recurrence gate: keep signals whose pattern recurs (weights sum across
 * signals — two failures of one step count like the step recurring twice), plus immediates. */
export function applyRecurrenceGate(signals: ScribeSignal[], minCount = 2): ScribeSignal[] {
  const counts = new Map<string, number>();
  for (const s of signals) counts.set(s.pattern, (counts.get(s.pattern) ?? 0) + s.weight);
  return signals.filter((s) => s.immediate || (counts.get(s.pattern) ?? 0) >= minCount);
}

// ---------------------------------------------------------------- extraction

export interface ScribeCandidate {
  kind: "note" | "workflow" | "lesson" | "guardrail" | "preference";
  content: string;
  trigger?: string | null;
  /** 1-based indices into the evidence list this claim rests on. */
  evidence?: number[];
}

/** The injectable extraction seam. Null = skip silently (offline / no key / no model). */
export type ExtractFn = (
  evidence: ScribeSignal[],
  prompt: string,
) => Promise<ScribeCandidate[] | null>;

export const SCRIBE_SYSTEM =
  "You are the memory curator for a coding harness. From verified ledger evidence you " +
  "distill at most 3 durable memories worth injecting into FUTURE sessions in this " +
  "repository. Write each as one self-contained sentence or two, generalized past the " +
  "specific session (no run ids, no temp paths). kinds: lesson (something learned), " +
  "guardrail (something to avoid), workflow (a repeatable procedure), preference (a " +
  "durable user preference about how work should be done here — only from " +
  "user_correction evidence), note (other). " +
  "Only claim what the evidence supports; cite the evidence line numbers you used. " +
  'Reply with ONLY a JSON array: [{"kind":"lesson","content":"...","trigger":"when to ' +
  'surface (optional)","evidence":[1,2]}]. Reply [] if nothing generalizes.';

export function buildScribePrompt(signals: ScribeSignal[]): string {
  const lines = signals.map((s, i) => `${i + 1}. [${s.kind}] ${s.detail}`);
  return `Evidence from this repository's ledger (chronological):\n${lines.join("\n")}`;
}

/** Parse the extractor's reply: first [...] block, validated + capped. Null = unusable. */
export function parseCandidates(text: string): ScribeCandidate[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const kinds = new Set(["note", "workflow", "lesson", "guardrail", "preference"]);
  const out: ScribeCandidate[] = [];
  for (const c of parsed) {
    if (typeof c !== "object" || c === null) continue;
    const kind = (c as Record<string, unknown>).kind;
    const content = (c as Record<string, unknown>).content;
    if (typeof kind !== "string" || !kinds.has(kind)) continue;
    if (typeof content !== "string" || !content.trim()) continue;
    const trigger = (c as Record<string, unknown>).trigger;
    const evidence = (c as Record<string, unknown>).evidence;
    out.push({
      kind: kind as ScribeCandidate["kind"],
      content: content.trim().slice(0, 500),
      trigger: typeof trigger === "string" && trigger.trim() ? trigger.trim().slice(0, 120) : null,
      evidence: Array.isArray(evidence)
        ? evidence.filter((n): n is number => Number.isInteger(n) && n >= 1)
        : [],
    });
    if (out.length >= 3) break;
  }
  return out;
}

/** Per-pass USD ceiling for the extraction call (open decision #3 default). */
export const SCRIBE_PASS_CAP_USD = 0.03;

/**
 * The real extractor: one recommend (tags=["memory:extract"], cost-lean slider, hard
 * per-call cap) → one completion on the routed model → realized-cost feedback. Spend
 * books to the meter/budget exactly like judge spend — never into any turn's
 * actual_cost_usd. Any failure returns null (skip silently).
 */
export function makeRoutedExtractor(deps: {
  router: MinimaRouter;
  meter?: CostMeter | null;
  budget?: BudgetLedger | null;
  /** Injectable for tests; defaults to the real ai/stream complete(). */
  completeFn?: typeof complete;
}): ExtractFn {
  const run = deps.completeFn ?? complete;
  return async (_evidence, prompt) => {
    let routing: Awaited<ReturnType<MinimaRouter["recommend"]>>;
    try {
      routing = await deps.router.recommend({
        task: prompt,
        taskType: "extraction",
        tags: ["memory:extract"],
        slider: 2,
        maxCostPerCall: SCRIBE_PASS_CAP_USD,
      });
    } catch {
      return null; // offline / no server / no key — curation is strictly optional
    }
    const start = Date.now();
    try {
      const resp = await run(
        routing.model,
        {
          system_prompt: SCRIBE_SYSTEM,
          messages: [new Message({ role: "user", content: prompt })],
          tools: [],
        },
        { options: { timeout: 30, prompt_cache: false } },
      );
      const usd = resp.usage.cost.total;
      try {
        deps.meter?.addOverhead(Number.isFinite(usd) ? usd : 0);
        deps.budget?.bookSpend(Number.isFinite(usd) ? usd : 0, "scribe");
      } catch {
        // spend hooks must never break curation
      }
      const providerError = resp.stop_reason === "error";
      const candidates = providerError ? null : parseCandidates(resp.textContent);
      if (routing.recommendationId && routing.chosenModelId) {
        deps.router
          .feedback({
            recommendationId: routing.recommendationId,
            chosenModelId: routing.chosenModelId,
            outcome: candidates !== null ? "success" : "failure",
            quality: null,
            usage: resp.usage,
            latencyMs: Date.now() - start,
            evidenceSource: "none",
            errorCause: candidates !== null ? undefined : providerError ? "infra" : "quality",
            verifiedInProduction: false,
            judged: false,
            notes: "memory:extract",
          })
          .catch(() => {});
      }
      return candidates;
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------- reconciliation + pass

/** Token-Jaccard similarity, the same shape the ledger uses for step matching. */
export function similarity(a: string, b: string): number {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit / (ta.size + tb.size - hit);
}

const NOOP_SIMILARITY = 0.7;
const UPDATE_SIMILARITY = 0.45;

export interface ScribeReport {
  signals: number;
  gated: number;
  candidates: number;
  added: number;
  updated: number;
  noops: number;
  invalidated: number;
  /** Why the pass stopped early (null = full pass ran). */
  skipped: "no_signals" | "budget" | "extractor" | null;
}

export interface ScribePassDeps {
  db: MinimaDb;
  projectKey: string;
  extract: ExtractFn;
  budget?: BudgetLedger | null;
  /** Staleness guard: does this model id still resolve? (model registry seam). */
  modelExists?: (id: string) => boolean;
  recurrenceMin?: number;
}

/** Skip curation entirely when less than this share of the session budget remains. */
export const SCRIBE_BUDGET_FLOOR = 0.2;

/**
 * One full curation pass: staleness sweep → mine → recurrence gate → budget check →
 * extract → reconcile. Every write is audited; the pass never throws past its boundary.
 */
export async function runScribePass(deps: ScribePassDeps): Promise<ScribeReport> {
  const report: ScribeReport = {
    signals: 0,
    gated: 0,
    candidates: 0,
    added: 0,
    updated: 0,
    noops: 0,
    invalidated: 0,
    skipped: null,
  };
  const { db, projectKey } = deps;

  report.invalidated = sweepStaleMemories(deps);

  const signals = mineSignals(db, projectKey);
  report.signals = signals.length;
  const gated = applyRecurrenceGate(signals, deps.recurrenceMin ?? 2);
  report.gated = gated.length;
  if (gated.length === 0) {
    report.skipped = "no_signals";
    return report;
  }

  if (deps.budget) {
    const s = deps.budget.status();
    if (s.limitUsd > 0 && s.remainingUsd / s.limitUsd < SCRIBE_BUDGET_FLOOR) {
      report.skipped = "budget";
      return report;
    }
  }

  const candidates = await deps.extract(gated, buildScribePrompt(gated));
  if (candidates === null) {
    report.skipped = "extractor";
    return report;
  }
  report.candidates = candidates.length;

  // Compare against EVERYTHING ever written (incl. rejected + invalidated): a candidate
  // similar to a row the user rejected or deleted must NOOP, never resurrect.
  const existing = db.listMemories(projectKey, { includeInvalidated: true, limit: 500 });
  const watermark = Math.max(0, ...gated.map((s) => s.ts));
  for (const cand of candidates) {
    let best: MemoryRow | null = null;
    let bestSim = 0;
    for (const row of existing) {
      const sim = similarity(cand.content, row.content);
      if (sim > bestSim) {
        bestSim = sim;
        best = row;
      }
    }
    const cited = (cand.evidence ?? [])
      .map((i) => gated[i - 1])
      .filter((s): s is ScribeSignal => Boolean(s));
    const citations = [...new Set(cited.flatMap((s) => [...s.recIds, ...s.gateIds]))];
    const gateCited = cited.some((s) => s.kind === "gate_flip" && s.gateIds.length > 0);
    const humanCited = cited.some((s) => s.kind === "user_correction");

    if (best && bestSim >= NOOP_SIMILARITY) {
      db.writeMemoryEvent({
        memoryId: best.id,
        op: "noop",
        payload: { candidate: cand.content, similarity: Number(bestSim.toFixed(3)) },
        actor: "scribe",
      });
      report.noops += 1;
      continue;
    }
    if (
      best &&
      bestSim >= UPDATE_SIMILARITY &&
      best.origin === "scribe" &&
      best.invalidated_at === null &&
      best.status !== "rejected"
    ) {
      if (
        db.updateMemory(
          best.id,
          { content: cand.content, citations, watermarkTs: watermark },
          "scribe",
        )
      ) {
        report.updated += 1;
        continue;
      }
    }
    db.insertMemory({
      projectKey,
      kind: cand.kind,
      content: cand.content,
      trigger: cand.trigger ?? null,
      citations,
      // Provenance discipline: only gate-backed claims may auto-activate; a user
      // correction is human evidence but the WORDING is scribe-inferred → still pending.
      evidenceSource: gateCited ? "gate" : humanCited ? "human" : "none",
      origin: "scribe",
      status: gateCited ? "active" : "pending",
      watermarkTs: watermark,
      actor: "scribe",
    });
    report.added += 1;
  }
  return report;
}

/**
 * Staleness guards (STALE lesson: models notice expired memories only ~55% of the time —
 * expire them mechanically instead): (a) a live memory naming a project-chosen model id
 * that no longer resolves in the catalog; (b) a live `workflow` written before the last
 * toolchain-manifest change (package.json/pyproject/bun.lock/uv.lock in file_changes).
 */
export function sweepStaleMemories(deps: ScribePassDeps): number {
  const { db, projectKey } = deps;
  let n = 0;
  const live = db.listMemories(projectKey, { statuses: ["active", "pinned", "pending"] });
  if (deps.modelExists) {
    const gone = db.getProjectChosenModels(projectKey).filter((id) => !deps.modelExists?.(id));
    for (const row of live) {
      if (gone.some((id) => row.content.includes(id))) {
        if (db.invalidateMemory(row.id, "system")) n += 1;
      }
    }
  }
  const toolchainTs = db.latestToolchainChangeTs(projectKey);
  if (toolchainTs !== null) {
    for (const row of live) {
      if (row.kind !== "workflow" || row.invalidated_at !== null) continue;
      const wm = row.watermark_ts ?? row.updated;
      if (wm < toolchainTs && db.invalidateMemory(row.id, "system")) n += 1;
    }
  }
  return n;
}

// ---------------------------------------------------------------- job drain

export interface DrainDeps extends Omit<ScribePassDeps, "projectKey"> {
  /** Resolve a job's project (jobs carry the session; the run row carries the project). */
  projectKeyFor: (job: MemoryJobRow) => string | null;
}

/**
 * Claim-and-run queued jobs (FIFO, bounded). `reflect`/`consolidate` jobs run a scribe
 * pass; `dream` jobs run the offline consolidation (B3). A pass that throws marks its
 * job `failed` and the drain continues — one bad pass never wedges the queue.
 */
export async function drainMemoryJobs(deps: DrainDeps, maxJobs = 3): Promise<ScribeReport[]> {
  const { runDream } = await import("./memory_dream.ts");
  const reports: ScribeReport[] = [];
  for (let i = 0; i < maxJobs; i++) {
    const job = deps.db.claimNextMemoryJob();
    if (!job) break;
    const projectKey = deps.projectKeyFor(job);
    if (!projectKey) {
      deps.db.finishMemoryJob(job.id, "failed");
      continue;
    }
    try {
      if (job.kind === "dream") {
        runDream(deps.db, projectKey);
      } else {
        reports.push(await runScribePass({ ...deps, projectKey }));
      }
      deps.db.finishMemoryJob(job.id, "done");
    } catch {
      deps.db.finishMemoryJob(job.id, "failed");
    }
  }
  return reports;
}
