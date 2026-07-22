/**
 * Anti-spiral (A3) — a doom-loop ring buffer + a soft turn cap, both resolved at the same
 * per-turn seam A2 uses (`shouldStopAfterTurn`, agent/loop.ts:155).
 *
 * Two failure modes of a stuck agent, one intervention each:
 *   - DOOM LOOP: the model calls the SAME tool with the SAME arguments and it keeps FAILING. A
 *     fixed-size ring of recent (tool, args, failed?) records lets us spot "same signature failed
 *     >= N times in the window". First detection injects a summary + a "you're looping, change
 *     approach" steer and lets the run continue (a real chance to recover); if it STILL spirals
 *     after that nudge, the run stops gracefully.
 *   - STEP CAP: a soft turn budget (separate from the hard `maxTurns`). At the cap we inject a
 *     wrap-up summary + "summarise and stop" and allow ONE more turn, then stop.
 *
 * Injections go into `state.steering` (not `state.followUp`): steering is drained after EVERY turn
 * (loop.ts:165), so a mid-spiral nudge reaches the model on the very next turn even while it is
 * still actively tool-calling — whereas followUp only drains on a no-tool (terminal) turn and would
 * never fire during an active tool-call spiral.
 *
 * Failure signal: tools report failure by RETURNING an error, not by throwing, so afterToolCall's
 * `isError` (a thrown-tool flag) misses almost everything. {@link toolCallFailed} reads the uniform
 * `details.error` marker `errorResult` now stamps. A nonzero shell `exit_code` is deliberately NOT
 * a failure (idempotent probes like `grep -q` / `git diff --quiet` exit nonzero normally).
 *
 * Known coverage limit: the ring is fed from `afterToolCall`, which never fires for calls rejected
 * BEFORE execution (unknown tool, argument-validation failure, or a `beforeToolCall` block such as a
 * permission denial). A spiral built purely from those is invisible to the doom-loop detector; the
 * soft step cap is the backstop for that case. Wiring rejected calls into the ring needs a new loop
 * seam and is left as a follow-up.
 *
 * Enforcement at a turn boundary, not prompt text. Gated by `config.bigPlan` +
 * (`spiralRepeats > 0` || `stepCap > 0`) at the call site (runtime.ts); inert otherwise. Fail-open:
 * the audit-gate write is best-effort and never throws into the loop.
 */

import type { AgentState, ShouldStopAfterTurn, ToolResultLike } from "../agent/state.ts";
import type { ToolResult } from "../agent/tools.ts";
import type { AssistantMessage } from "../ai/index.ts";
import { Message, text } from "../ai/types.ts";
import type { MinimaDb } from "../db/minima_db.ts";

const RING_CAPACITY = 16;
const DIGEST_MAX = 8;
const ARGS_SNIPPET_MAX = 60;

/**
 * Did this tool call unambiguously FAIL? Tools RETURN failure (`errorResult` → `details.error`)
 * rather than throw, so `isError` (thrown-tool flag) alone is nearly always false — we read the
 * marker instead.
 *
 * We deliberately do NOT treat a nonzero `details.exit_code` as failure: a nonzero shell exit is a
 * normal boolean signal for idempotent probes (`grep -q`, `git diff --quiet`, `test -f`, a polling
 * `curl`), so counting those as failures would spuriously trip the doom loop on a legitimately
 * repeated query. Only genuine tool errors (a returned `errorResult`, or a thrown tool) count.
 */
export function toolCallFailed(result: ToolResult, isError: boolean): boolean {
  return isError || result.details?.error === true;
}

/** Ring capacity that can always hold at least `repeats` failures plus interleaved noise, so a
 * large `spiralRepeats` can never silently exceed the window and disable the detector. */
export function ringCapacityForRepeats(repeats: number): number {
  return Math.max(RING_CAPACITY, repeats * 2);
}

/** Deterministic, key-sorted stringify so trivially-reordered args still hash identically. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

interface RingEntry {
  name: string;
  sig: string;
  failed: boolean;
  snippet: string;
}

/** Fixed-size ring of recent tool calls — the doom-loop detector's memory. */
export class DoomLoopRing {
  private buf: RingEntry[] = [];

  constructor(private readonly capacity: number = RING_CAPACITY) {}

  push(name: string, args: unknown, failed: boolean): void {
    const argStr = stableStringify(args);
    const snippet =
      argStr.length > ARGS_SNIPPET_MAX ? `${argStr.slice(0, ARGS_SNIPPET_MAX - 1)}…` : argStr;
    this.buf.push({ name, sig: `${name} ${argStr}`, failed, snippet });
    if (this.buf.length > this.capacity) this.buf.shift();
  }

  /**
   * Every (tool, args) signature that has FAILED at least `repeats` times within the window — the
   * doom-loop condition. Scans the WHOLE window (not just the latest entry) so a loop is caught even
   * when each turn ends on a non-failing call (fail → inspect → fail → inspect …) or spans several
   * tools per turn. Ordered by first appearance for stable reporting.
   */
  spiralingSignatures(repeats: number): { sig: string; name: string; count: number }[] {
    const counts = new Map<string, { name: string; count: number }>();
    for (const e of this.buf) {
      if (!e.failed) continue;
      const cur = counts.get(e.sig);
      if (cur) cur.count += 1;
      else counts.set(e.sig, { name: e.name, count: 1 });
    }
    const out: { sig: string; name: string; count: number }[] = [];
    for (const [sig, v] of counts) if (v.count >= repeats) out.push({ sig, ...v });
    return out;
  }

  /** A compact ✓/✗ digest of the last `n` calls for a summary injection. */
  digest(n: number = DIGEST_MAX): string {
    return this.buf
      .slice(-n)
      .map((e) => `  ${e.failed ? "✗" : "✓"} ${e.name}(${e.snippet})`)
      .join("\n");
  }

  get size(): number {
    return this.buf.length;
  }
}

/** Plan progress, when a plan of record exists — enriches the wrap-up summary. Fail-open → null. */
function planProgress(db: MinimaDb | null, sessionId: string | null): string | null {
  if (!db || !sessionId) return null;
  try {
    const plan = db.getActivePlan(sessionId);
    if (!plan) return null;
    const steps = db.getPlanSteps(plan.id);
    if (steps.length === 0) return null;
    const done = steps.filter((s) => s.status === "completed").length;
    return `plan: ${done}/${steps.length} steps complete`;
  } catch {
    return null;
  }
}

function steer(body: string): Message {
  return new Message({ role: "user", content: [text(body)] });
}

/** The doom-loop recovery nudge. */
function doomLoopMessage(ring: DoomLoopRing, hit: { name: string; count: number }): Message {
  return steer(
    [
      `⚠ You have called \`${hit.name}\` with the same arguments ${hit.count} times and it keeps FAILING — you are stuck in a loop. Stop repeating it.`,
      "Recent actions:",
      ring.digest(),
      "",
      "Step back and try a materially DIFFERENT approach (different inputs, a different tool, or",
      "re-read the error). If this genuinely cannot be done, say so plainly and stop — do not keep",
      "retrying the same failing call.",
    ].join("\n"),
  );
}

/** The step-cap wrap-up nudge. */
function stepCapMessage(deps: AntiSpiralDeps, ring: DoomLoopRing, turns: number): Message {
  const progress = planProgress(deps.db, deps.sessionId);
  return steer(
    [
      `⚠ You have used ${turns} turns (turn budget ${deps.stepCap}). Wrap up NOW — do not start new work.`,
      progress ? progress : null,
      "Recent actions:",
      ring.digest(),
      "",
      "Summarise what you accomplished and what remains for the user, then stop.",
    ]
      .filter((l): l is string => l !== null)
      .join("\n"),
  );
}

/** Write the single audit-only stop gate (kind='stop', rec_id NULL → invisible to the feedback
 * join by construction, like A2). Fail-open. */
function writeSpiralGate(
  deps: AntiSpiralDeps,
  reason: "doom_loop" | "step_cap",
  turns: number,
): void {
  if (!deps.db || !deps.sessionId) return;
  try {
    const plan = deps.db.getActivePlan(deps.sessionId);
    if (!plan) return;
    deps.db.insertGate({
      planId: plan.id,
      stepId: null,
      kind: "stop",
      outcome: "unchecked",
      confidence: "red",
      verifiedBy: null,
      factors: { spiral: true, reason, turns },
      recId: null,
      sessionId: deps.sessionId,
      agentId: deps.agentId,
    });
  } catch {
    // audit is best-effort; never break the loop over a bookkeeping write.
  }
}

export interface AntiSpiralDeps {
  ring: DoomLoopRing;
  /** N identical failing calls → doom loop. 0 disables the detector. */
  repeats: number;
  /** Soft turn budget → wrap-up + stop. 0 disables the cap. */
  stepCap: number;
  db: MinimaDb | null;
  sessionId: string | null;
  agentId: string | null;
}

/** `pass` → no action (fall through to the next stop check); `handled` → injected a steer, continue
 * (skip other stop checks this turn); `stop` → end the run now. */
export type SpiralVerdict = "pass" | "handled" | "stop";

export type AntiSpiralGate = (
  assistant: AssistantMessage,
  results: ToolResultLike[],
  state: AgentState,
) => Promise<SpiralVerdict>;

/**
 * Build the anti-spiral turn-boundary check. Strike/turn/cap state is closed over here, so a fresh
 * gate (one per recovery rung) resets it. The ring is fed separately by an afterToolCall hook.
 */
export function makeAntiSpiral(deps: AntiSpiralDeps): AntiSpiralGate {
  let turnCount = 0;
  // Per-signature nudge memory: sig → the failure count when we nudged it. A spiral is STOPPED only
  // once that signature fails AGAIN after its nudge (count climbs past the nudge point) — so a
  // single interleaved success can't reset the escalation, and a stale window (a text-only turn that
  // adds no new failure) can't spuriously stop an already-ending run.
  const nudgedAt = new Map<string, number>();
  let capWrapInjected = false;

  return async (_assistant, _results, state): Promise<SpiralVerdict> => {
    turnCount += 1;

    // Step cap: we injected the wrap-up last turn; that wrap-up turn is now done → stop.
    if (capWrapInjected) {
      writeSpiralGate(deps, "step_cap", turnCount);
      return "stop";
    }
    if (deps.stepCap > 0 && turnCount >= deps.stepCap) {
      state.steering.push(stepCapMessage(deps, deps.ring, turnCount));
      capWrapInjected = true;
      return "handled"; // one wrap-up turn, then stop
    }

    // Doom loop: any (tool, args) signature that keeps failing across the window.
    if (deps.repeats > 0) {
      const spiraling = deps.ring.spiralingSignatures(deps.repeats);
      // Escalate first: a signature we already nudged has failed AGAIN since → stop.
      for (const s of spiraling) {
        const at = nudgedAt.get(s.sig);
        if (at !== undefined && s.count > at) {
          writeSpiralGate(deps, "doom_loop", turnCount);
          return "stop";
        }
      }
      // Otherwise nudge the first not-yet-nudged spiraling signature (once each).
      for (const s of spiraling) {
        if (!nudgedAt.has(s.sig)) {
          nudgedAt.set(s.sig, s.count);
          state.steering.push(doomLoopMessage(deps.ring, s));
          return "handled";
        }
      }
    }

    return "pass";
  };
}
