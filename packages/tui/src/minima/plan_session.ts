/**
 * PlanSessionStore — the in-memory single source of truth for a planning session.
 *
 * PURE: zero imports. The planning feature deliberately touches no database / persistence
 * layer — the session lives only for the duration of the /plan conversation and the ONLY
 * durable artifact is the ground-truth .md produced by toMarkdown() on /plan approve.
 *
 * The council appends structured deltas (decisions, findings, constraints, facts, surfaced
 * questions) each round; the store merges + dedups them and re-projects a compact snapshot
 * back into the planner's system prompt every turn. All mutation is fail-open.
 */

const newId = (): string => crypto.randomUUID();

const now = (): number => Date.now() / 1000;

/** Whitespace-collapsed, lowercased key for dedup comparisons. */
const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

const fmtUsd = (n: number): string => `$${(Number.isFinite(n) ? n : 0).toFixed(4)}`;

export interface PlanDecision {
  id: string;
  topic: string;
  decision: string;
  rationale: string;
  resolvedBy: "council" | "user";
  round: number;
}

export interface OpenQuestion {
  id: string;
  question: string;
  why: string;
  round: number;
  status: "open" | "answered" | "dropped";
  answer?: string;
  /** Surfaced options; the first is the council's recommended answer (accepted as-is on finalize). */
  options?: { label: string; description?: string }[];
}

export interface CouncilFinding {
  id: string;
  source: "researcher" | "critic" | "keeper";
  summary: string;
  severity: "info" | "concern" | "blocker";
  round: number;
}

export interface PlanConstraint {
  id: string;
  text: string;
  source: "user" | "council";
}

export interface PlanFact {
  id: string;
  text: string;
  round: number;
}

export interface SurfacedQuestion {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  why: string;
}

export interface CouncilRoundResult {
  /** Concise LLM-authored title for the plan (own words). Empty if the round didn't produce one. */
  title?: string;
  /** Concise LLM-authored restatement of the goal (own words). Empty if none produced. */
  refinedGoal?: string;
  draftDelta: string;
  decisions: { topic: string; decision: string; rationale: string }[];
  findings: {
    source: "researcher" | "critic" | "keeper";
    summary: string;
    severity: "info" | "concern" | "blocker";
  }[];
  faults: { summary: string; severity: "info" | "concern" | "blocker" }[];
  questions: SurfacedQuestion[];
  facts: string[];
  constraints: string[];
  costUsd: number;
  aborted: boolean;
}

/**
 * The LLM-distilled final ground-truth, produced on /plan finalize from the whole planning
 * conversation + accumulated council state. Rendered richly by `toGroundTruth`. Every list may
 * be empty; the renderer falls back to council state / deterministic assembly when it is.
 */
export interface GroundTruthSynthesis {
  title: string;
  goal: string;
  overview: string;
  requirements: string[];
  constraints: string[];
  decisions: { topic: string; decision: string; rationale: string }[];
  approach: string[];
  risks: string[];
  successCriteria: string[];
  openItems: string[];
}

export interface PlanSession {
  goal: string;
  /** Concise LLM-authored title (own words); falls back to `goal` for display when empty. */
  title: string;
  /** Concise LLM-authored goal restatement (own words); falls back to `goal` when empty. */
  refinedGoal: string;
  draft: string;
  decisions: PlanDecision[];
  openQuestions: OpenQuestion[];
  findings: CouncilFinding[];
  constraints: PlanConstraint[];
  facts: PlanFact[];
  rounds: number;
  totalCouncilCostUsd: number;
  createdAt: number;
  updatedAt: number;
}

export class PlanSessionStore {
  private readonly state: PlanSession;

  constructor(goal: string) {
    const ts = now();
    this.state = {
      goal: goal.trim(),
      title: "",
      refinedGoal: "",
      draft: "",
      decisions: [],
      openQuestions: [],
      findings: [],
      constraints: [],
      facts: [],
      rounds: 0,
      totalCouncilCostUsd: 0,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  get session(): PlanSession {
    return this.state;
  }

  setGoal(goal: string): void {
    this.state.goal = goal.trim();
    this.state.updatedAt = now();
  }

  /** Adopt `text` as the goal if none is set yet (first substantive turn wins). Capped to a
   *  single-line title; the full turn is still preserved as a PlanFact. */
  adoptGoalIfEmpty(text: string): void {
    if (this.state.goal.trim()) return;
    const firstLine = (text ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
    if (!firstLine) return;
    this.setGoal(firstLine.length > 100 ? `${firstLine.slice(0, 97).trimEnd()}…` : firstLine);
  }

  /** Merge a council round's deltas; dedup by normalized topic/question/summary/text. Fail-open. */
  applyCouncilResult(r: CouncilRoundResult): void {
    try {
      const round = this.state.rounds + 1;

      // The council's own-words title/goal; first substantive round wins so they stay stable.
      const title = (r.title ?? "").trim();
      if (title && !this.state.title) this.state.title = title;
      const refinedGoal = (r.refinedGoal ?? "").trim();
      if (refinedGoal && !this.state.refinedGoal) this.state.refinedGoal = refinedGoal;

      const delta = (r.draftDelta ?? "").trim();
      if (delta) this.state.draft = this.state.draft ? `${this.state.draft}\n\n${delta}` : delta;

      const seenTopics = new Set(this.state.decisions.map((d) => norm(d.topic)));
      for (const d of r.decisions ?? []) {
        const key = norm(d.topic);
        if (!key || seenTopics.has(key)) continue;
        seenTopics.add(key);
        this.state.decisions.push({
          id: newId(),
          topic: d.topic.trim(),
          decision: d.decision.trim(),
          rationale: d.rationale.trim(),
          resolvedBy: "council",
          round,
        });
      }

      const seenFindings = new Set(this.state.findings.map((f) => norm(f.summary)));
      const pushFinding = (
        source: CouncilFinding["source"],
        summary: string,
        severity: CouncilFinding["severity"],
      ): void => {
        const key = norm(summary);
        if (!key || seenFindings.has(key)) return;
        seenFindings.add(key);
        this.state.findings.push({ id: newId(), source, summary: summary.trim(), severity, round });
      };
      for (const f of r.findings ?? []) pushFinding(f.source, f.summary, f.severity);
      for (const f of r.faults ?? []) pushFinding("critic", f.summary, f.severity);

      const seenConstraints = new Set(this.state.constraints.map((c) => norm(c.text)));
      for (const text of r.constraints ?? []) {
        const key = norm(text);
        if (!key || seenConstraints.has(key)) continue;
        seenConstraints.add(key);
        this.state.constraints.push({ id: newId(), text: text.trim(), source: "council" });
      }

      const seenFacts = new Set(this.state.facts.map((f) => norm(f.text)));
      for (const text of r.facts ?? []) {
        const key = norm(text);
        if (!key || seenFacts.has(key)) continue;
        seenFacts.add(key);
        this.state.facts.push({ id: newId(), text: text.trim(), round });
      }

      this.addSurfacedQuestions(r.questions ?? [], round);

      this.state.rounds = round;
      this.state.totalCouncilCostUsd += Number.isFinite(r.costUsd) ? r.costUsd : 0;
      this.state.updatedAt = now();
    } catch {
      // planning telemetry must never break the conversation loop
    }
  }

  /** Record a user turn as a PlanFact (the user's words are ground truth). */
  recordUserTurn(text: string): void {
    const t = (text ?? "").trim();
    if (!t) return;
    this.state.facts.push({ id: newId(), text: t, round: this.state.rounds });
    this.state.updatedAt = now();
  }

  /** Resolve an open question with the user's answer and record it as a user decision. */
  answerQuestion(
    question: string,
    answer: string,
    resolvedBy: "council" | "user" = "user",
    rationale?: string,
  ): void {
    const key = norm(question);
    for (const q of this.state.openQuestions) {
      if (q.status === "open" && norm(q.question) === key) {
        q.status = "answered";
        q.answer = answer.trim();
      }
    }
    this.state.decisions.push({
      id: newId(),
      topic: question.trim(),
      decision: answer.trim(),
      rationale:
        rationale?.trim() ||
        (resolvedBy === "user" ? "answered by user" : "auto-resolved at finalize"),
      resolvedBy,
      round: this.state.rounds,
    });
    this.state.updatedAt = now();
  }

  /** Append surfaced questions as open OpenQuestions, deduped by normalized question text. */
  addSurfacedQuestions(qs: SurfacedQuestion[], round: number): void {
    const seen = new Set(this.state.openQuestions.map((q) => norm(q.question)));
    for (const q of qs ?? []) {
      const key = norm(q.question);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      this.state.openQuestions.push({
        id: newId(),
        question: q.question.trim(),
        why: (q.why ?? "").trim(),
        round,
        status: "open",
        options: (q.options ?? [])
          .map((o) => ({ label: o.label.trim(), description: o.description?.trim() || undefined }))
          .filter((o) => o.label.length > 0),
      });
    }
    this.state.updatedAt = now();
  }

  /** Compact re-anchor projection injected into the planner's system prompt each turn. */
  snapshotBlock(): string {
    const s = this.state;
    const lines: string[] = ["=== PLAN SNAPSHOT ===", `Goal: ${s.goal || "(none set)"}`];

    lines.push("", "Decisions:");
    if (s.decisions.length === 0) lines.push("- (none yet)");
    else for (const d of s.decisions) lines.push(`- ${d.topic}: ${d.decision}`);

    lines.push("", "Constraints:");
    if (s.constraints.length === 0) lines.push("- (none)");
    else for (const c of s.constraints) lines.push(`- ${c.text}`);

    const open = s.openQuestions.filter((q) => q.status === "open");
    lines.push("", "Open questions:");
    if (open.length === 0) lines.push("- (none)");
    else for (const q of open) lines.push(`- ${q.question}`);

    lines.push("", "Current draft:", s.draft.trim() || "(empty)");
    lines.push("=== END SNAPSHOT ===");
    return lines.join("\n");
  }

  /** The ground-truth doc. Deterministic string assembly — no LLM call. */
  toMarkdown(): string {
    const s = this.state;
    const out: string[] = [];
    out.push(`# Ground Truth: ${s.title || s.goal || "Untitled Plan"}`);
    out.push("");
    out.push(
      `_Generated by the planning council — ${s.rounds} ${s.rounds === 1 ? "round" : "rounds"}, ${fmtUsd(
        s.totalCouncilCostUsd,
      )}._`,
    );

    out.push("", "## Goal", "", s.refinedGoal || s.goal || "_No goal recorded._");

    out.push("", "## Constraints", "");
    if (s.constraints.length === 0) out.push("_None recorded._");
    else for (const c of s.constraints) out.push(`- ${c.text}`);

    out.push("", "## Key Decisions", "");
    if (s.decisions.length === 0) out.push("_None recorded._");
    else
      for (const d of s.decisions) {
        out.push(`### ${d.topic}`);
        out.push("");
        out.push(`**Decision:** ${d.decision}`);
        out.push("");
        out.push(`**Rationale:** ${d.rationale || "—"}`);
        out.push("");
        out.push(`_resolved by ${d.resolvedBy}, round ${d.round}_`);
        out.push("");
      }

    out.push("## Plan", "", s.draft.trim() || "_No plan drafted._");

    const open = s.openQuestions.filter((q) => q.status === "open");
    out.push("", "## Open Questions", "");
    if (open.length === 0) out.push("_None._");
    else for (const q of open) out.push(`- [ ] ${q.question}${q.why ? ` — ${q.why}` : ""}`);

    out.push("", "## Context & Findings", "");
    if (s.findings.length === 0 && s.facts.length === 0) out.push("_None recorded._");
    else {
      for (const f of s.findings) out.push(`- (${f.source}/${f.severity}) ${f.summary}`);
      for (const f of s.facts) out.push(`- (fact) ${f.text}`);
    }

    out.push("");
    return out.join("\n");
  }

  /**
   * The finalized ground-truth doc, rendered from an LLM synthesis of the whole planning
   * conversation. Detail-rich and consistently formatted. Falls back to `toMarkdown()` when no
   * synthesis is available (synthesis failed/disabled). Council-accumulated constraints/decisions
   * are used as a floor so nothing the council established is ever lost.
   */
  toGroundTruth(synth: GroundTruthSynthesis | null): string {
    if (!synth) return this.toMarkdown();
    const s = this.state;
    const out: string[] = [];

    const title = synth.title.trim() || s.title || s.goal || "Untitled Plan";
    out.push(`# Ground Truth: ${title}`, "");
    out.push(
      s.rounds > 0
        ? `_Compiled by the planning council — ${s.rounds} ${
            s.rounds === 1 ? "round" : "rounds"
          }, ${fmtUsd(s.totalCouncilCostUsd)}._`
        : "_Compiled by the planning council from the planning conversation._",
      "",
    );

    out.push(
      "## Goal",
      "",
      synth.goal.trim() || s.refinedGoal || s.goal || "_No goal recorded._",
      "",
    );

    if (synth.overview.trim()) out.push("## Overview", "", synth.overview.trim(), "");

    const bullets = (heading: string, items: string[]): void => {
      const clean = items.map((x) => x.trim()).filter(Boolean);
      if (clean.length === 0) return;
      out.push(`## ${heading}`, "");
      for (const it of clean) out.push(`- ${it}`);
      out.push("");
    };

    bullets("Requirements", synth.requirements);
    bullets(
      "Constraints",
      synth.constraints.length ? synth.constraints : s.constraints.map((c) => c.text),
    );

    const decisions = synth.decisions.length
      ? synth.decisions
      : s.decisions.map((d) => ({ topic: d.topic, decision: d.decision, rationale: d.rationale }));
    const cleanDecisions = decisions.filter((d) => d.topic.trim() || d.decision.trim());
    if (cleanDecisions.length) {
      out.push("## Key Decisions", "");
      for (const d of cleanDecisions) {
        out.push(`### ${d.topic.trim() || "Decision"}`, "");
        out.push(`**Decision:** ${d.decision.trim() || "—"}`, "");
        if (d.rationale.trim()) out.push(`**Rationale:** ${d.rationale.trim()}`, "");
        out.push("");
      }
    }

    const steps = synth.approach.map((x) => x.trim()).filter(Boolean);
    out.push("## Implementation Plan", "");
    if (steps.length === 0) out.push(s.draft.trim() || "_No plan drafted._", "");
    else {
      steps.forEach((st, i) => out.push(`${i + 1}. ${st}`));
      out.push("");
    }

    bullets("Risks & Edge Cases", synth.risks);
    bullets("Success Criteria", synth.successCriteria);
    bullets("Deferred / Open Items", synth.openItems);

    const ctx: string[] = [];
    for (const f of s.findings) ctx.push(`- (${f.source}/${f.severity}) ${f.summary}`);
    if (ctx.length) out.push("## Context & Findings", "", ...ctx, "");

    return `${out.join("\n").trimEnd()}\n`;
  }

  /** One-line status. */
  summary(): string {
    const s = this.state;
    const open = s.openQuestions.filter((q) => q.status === "open").length;
    return `plan: ${s.rounds} ${s.rounds === 1 ? "round" : "rounds"}, ${s.decisions.length} decisions, ${open} open questions, ${fmtUsd(s.totalCouncilCostUsd)}`;
  }

  hasSubstance(): boolean {
    return this.state.decisions.length > 0 || this.state.draft.trim().length > 0;
  }
}

export function buildPlannerSystemPrompt(base: string, store: PlanSessionStore): string {
  return `${base}\n\n${store.snapshotBlock()}`;
}
