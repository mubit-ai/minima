/**
 * /rewind turn picker model (B5, MUB-142) — pure, no React. Turns are the transcript's
 * REAL user prompts (slash echoes excluded), same anchor model as the U2 ToC. Replay-space
 * mapping is by DISTANCE FROM THE END (see session/rewind.ts): live turn j of L maps to
 * replay keep_prompts = replayCount − (L − j + 1) when dropping j..L.
 *
 * Code-restorability: snapshots capture the worktree BEFORE a mutating prompt's changes,
 * so "files as of prompt j's submission" is the checkpoint with the smallest
 * prompt_ordinal ≥ replay(j)−1 — taken during prompt j itself if it mutated, else during
 * the next mutating prompt. No such checkpoint = nothing changed since (already there).
 */

import { sectionTitle } from "../session/sections.ts";
import type { ChatMessage } from "./layout.ts";

export interface RewindTurn {
  /** 1-based position among the live transcript's real user prompts. */
  liveIdx: number;
  title: string;
  /** Replay-space keep_prompts if rewinding to BEFORE this turn. */
  keepPrompts: number;
  /** A checkpoint can restore files to this turn's submission state. */
  codeRestorable: boolean;
}

/** A user ChatMessage that is a slash-command echo — not a prompt (same rule as toc.ts). */
const isCommandEcho = (m: ChatMessage) => m.role === "user" && m.text.trimStart().startsWith("/");

export function buildRewindTurns(
  messages: ChatMessage[],
  checkpointOrdinals: number[],
  replayCount: number,
): RewindTurn[] {
  const prompts = messages.filter((m) => m.role === "user" && !isCommandEcho(m));
  const total = prompts.length;
  return prompts.map((m, i) => {
    const liveIdx = i + 1;
    const dropCount = total - liveIdx + 1;
    const keepPrompts = Math.max(0, replayCount - dropCount);
    return {
      liveIdx,
      title: sectionTitle(m.text, 40),
      keepPrompts,
      codeRestorable: checkpointOrdinals.some((o) => o >= keepPrompts),
    };
  });
}

export type RewindMode = "convo" | "code" | "both";

export function parseRewindArgs(args: string): { n: number; mode: RewindMode } | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const n = Number(parts[0]);
  if (!Number.isInteger(n) || n < 1) return null;
  const mode = (parts[1] ?? "both").toLowerCase();
  if (mode !== "convo" && mode !== "code" && mode !== "both") return null;
  return { n, mode };
}

/** One-shot numbered list — the inline renderer's (and too-narrow fullscreen's) /rewind output. */
export function renderRewindText(turns: RewindTurn[], width: number): string {
  if (turns.length === 0) return "Nothing to rewind — no prompts in this session yet.";
  const lines = ["Rewind to before prompt N — /rewind <n> [convo|code|both] (default both):"];
  for (const t of turns) {
    const mark = t.codeRestorable ? "✓ code+convo" : "convo only";
    const line = `${String(t.liveIdx).padStart(3)}. ${t.title} — ${mark}`;
    lines.push(line.length > width ? `${line.slice(0, Math.max(1, width - 1))}…` : line);
  }
  return lines.join("\n");
}
