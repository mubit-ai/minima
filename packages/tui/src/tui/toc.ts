/**
 * Table-of-Contents content model (U2, MUB-140) — pure, no React. Sections are built
 * directly over the transcript's ChatMessage[] so a section's anchor IS its jump target
 * (startMsgIdx → offsetForMessage → setScrollOffset). Usage joins by PROMPT ORDINAL:
 * the k-th prompt-opened section here matches the k-th user-prompt section of the U1
 * ledger (src/session/sections.ts over the agent's Message[]) — slash-command echoes
 * and synthetic leading sections exist on only one side, so raw index joins would
 * drift; both sides therefore count only real user prompts. Missing rows join as zeros.
 *
 * The footer total is labeled "lead agent": child-agent (task) spend is excluded in v1,
 * matching the U1 ledger's semantics.
 */

import { sectionTitle } from "../session/sections.ts";
import type { ChatMessage } from "./layout.ts";

export interface TocUsage {
  /** input + output tokens for the section (lead conversation only). */
  tokens: number;
  costUSD: number;
}

export type MilestoneKind = "result" | "tools" | "plan-created" | "plan-updated" | "plan-finalized";

export interface TocMilestone {
  kind: MilestoneKind;
  label: string;
  msgIdx: number;
  isError?: boolean;
}

export interface TocSection {
  /** Section ordinal in the ToC (synthetic session-start included). */
  index: number;
  title: string;
  /** Index into the ChatMessage[] render list — the jump anchor. */
  startMsgIdx: number;
  milestones: TocMilestone[];
  usage: TocUsage;
  /** Prefix sum through this section, inclusive. */
  cumulative: TocUsage;
}

const zero = (): TocUsage => ({ tokens: 0, costUSD: 0 });

export const TOC_SESSION_START = "(session start)";

/** A user ChatMessage that is a slash-command echo (e.g. "/plan") — not a prompt. */
function isCommandEcho(msg: ChatMessage): boolean {
  return msg.role === "user" && msg.text.trimStart().startsWith("/");
}

const TODO_SUMMARY = /\((\d+)\/(\d+) done\)/;

/**
 * Build ToC sections over the render list. `usageLedger` holds one TocUsage per REAL
 * user prompt, in submission order (adapt it from the U1 ledger by dropping its
 * synthetic session-start section).
 */
export function buildSections(messages: ChatMessage[], usageLedger: TocUsage[]): TocSection[] {
  const sections: TocSection[] = [];
  let current: TocSection | null = null;
  let promptOrdinal = -1;
  let sawTodowrite = false;
  // Per-section scratch for the aggregate "tools" child.
  let toolCounts = new Map<string, number>();
  let toolErr = false;
  let lastAssistantIdx = -1;

  const flushChildren = (s: TocSection | null) => {
    if (!s) return;
    if (toolCounts.size > 0) {
      const total = [...toolCounts.values()].reduce((a, b) => a + b, 0);
      const detail = [...toolCounts.entries()].map(([n, c]) => `${n}×${c}`).join(", ");
      s.milestones.push({
        kind: "tools",
        label: `${total} tool${total === 1 ? "" : "s"} (${detail})`,
        msgIdx: s.startMsgIdx,
        isError: toolErr || undefined,
      });
    }
    if (lastAssistantIdx >= 0) {
      s.milestones.push({
        kind: "result",
        label: sectionTitle(messages[lastAssistantIdx]!.text, 40),
        msgIdx: lastAssistantIdx,
      });
    }
    toolCounts = new Map();
    toolErr = false;
    lastAssistantIdx = -1;
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const opensSection = (msg.role === "user" && !isCommandEcho(msg)) || current === null;
    if (opensSection) {
      flushChildren(current);
      const isPrompt = msg.role === "user" && !isCommandEcho(msg);
      if (isPrompt) promptOrdinal += 1;
      sawTodowrite = false;
      current = {
        index: sections.length,
        title: isPrompt ? sectionTitle(msg.text, 40) : TOC_SESSION_START,
        startMsgIdx: i,
        milestones: [],
        usage: isPrompt ? (usageLedger[promptOrdinal] ?? zero()) : zero(),
        cumulative: zero(),
      };
      sections.push(current);
      if (isPrompt) continue;
    }
    if (!current) continue;
    if (msg.role === "assistant") {
      lastAssistantIdx = i;
    } else if (msg.role === "tool" && msg.toolName === "todowrite") {
      const m = TODO_SUMMARY.exec(msg.text);
      if (m) {
        const [, x, y] = m;
        const kind: MilestoneKind = !sawTodowrite
          ? "plan-created"
          : Number(x) === Number(y) && Number(y) > 0
            ? "plan-finalized"
            : "plan-updated";
        sawTodowrite = true;
        current.milestones.push({
          kind,
          label: `${kind.replace("-", " ")} (${x}/${y})`,
          msgIdx: i,
        });
      }
    } else if (msg.role === "tool") {
      const name = msg.toolName ?? "tool";
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      if (msg.isError) toolErr = true;
    }
  }
  flushChildren(current);

  const run = zero();
  for (const s of sections) {
    run.tokens += s.usage.tokens;
    run.costUSD += s.usage.costUSD;
    s.cumulative = { ...run };
  }
  return sections;
}

const fmtUsd = (v: number) => `$${v.toFixed(4)}`;
const fmtTok = (v: number) => (v >= 10_000 ? `${(v / 1000).toFixed(1)}k` : String(v));

/** Clip to `width` code points (titles are pre-ellipsized; this is a hard guard). */
function fit(text: string, width: number): string {
  const cp = [...text];
  return cp.length <= width ? text : `${cp.slice(0, Math.max(1, width - 1)).join("")}…`;
}

export interface TocRow {
  text: string;
  /** Section this row belongs to; title rows are the cursor stops. */
  sectionIdx: number | null;
  isTitle: boolean;
}

/** Flatten sections into panel rows: title · price line · milestone children · Σ footer. */
export function tocRows(sections: TocSection[], innerWidth: number): TocRow[] {
  const rows: TocRow[] = [];
  for (const s of sections) {
    rows.push({ text: fit(`▸ ${s.title}`, innerWidth), sectionIdx: s.index, isTitle: true });
    rows.push({
      text: fit(`   ${fmtUsd(s.usage.costUSD)} · ${fmtTok(s.usage.tokens)} tok`, innerWidth),
      sectionIdx: s.index,
      isTitle: false,
    });
    for (const m of s.milestones) {
      const mark = m.kind === "result" ? "◆" : m.kind === "tools" ? "⚙" : "☰";
      rows.push({
        text: fit(`   ${mark} ${m.label}${m.isError ? " ⚠" : ""}`, innerWidth),
        sectionIdx: s.index,
        isTitle: false,
      });
    }
  }
  const totals = sections.length ? sections[sections.length - 1]!.cumulative : zero();
  rows.push({ text: "─".repeat(Math.max(1, innerWidth)), sectionIdx: null, isTitle: false });
  rows.push({
    text: fit(
      `Σ ${fmtUsd(totals.costUSD)} · ${fmtTok(totals.tokens)} tok (lead agent)`,
      innerWidth,
    ),
    sectionIdx: null,
    isTitle: false,
  });
  return rows;
}

/** One-shot text ToC — the inline renderer's (and too-narrow fullscreen's) Ctrl+T output. */
export function renderTocText(sections: TocSection[], width: number): string {
  if (sections.length === 0) return "Table of contents: (empty session)";
  const lines: string[] = ["Table of contents:"];
  for (const s of sections) {
    lines.push(
      fit(
        `${s.index + 1}. ${s.title} — ${fmtUsd(s.usage.costUSD)} · ${fmtTok(s.usage.tokens)} tok`,
        width,
      ),
    );
    for (const m of s.milestones)
      lines.push(fit(`     · ${m.label}${m.isError ? " ⚠" : ""}`, width));
  }
  const totals = sections[sections.length - 1]!.cumulative;
  lines.push(fit(`Σ ${fmtUsd(totals.costUSD)} · ${fmtTok(totals.tokens)} tok (lead agent)`, width));
  return lines.join("\n");
}
