/**
 * The front-end contract — the six seams anything driving this harness has to fill.
 *
 * Three front-ends drive the same agent runtime: the terminal UI, the non-interactive run
 * modes (`--print` / `--mode json`), and the editor transport (`acp`). Six user-facing seams
 * sit between the harness and whichever one is running, and every one of them already existed
 * as a late-bound reference threaded through cli/main.ts by hand. What did not exist was
 * anywhere to read off which front-end filled which — so a front-end that filled none of them
 * looked exactly like one that filled them all. The non-interactive path registers no
 * permission hook at all, and that was never a decision anyone wrote down. Naming the seams
 * turns that absence into a declaration: a `null` in here is a front-end stating what it does
 * not do, somewhere a reader can find it.
 *
 * Every seam is a mutable slot, because the binding is genuinely late: the tools and hooks
 * that read them are built before any front-end exists (the terminal UI's callbacks close over
 * a mounted React tree; ACP's will close over a connected client). The bootstrap attaches the
 * harness to the slots once — `attachPermissionSeam` and `subscribeAgentEvents` below both
 * read their slot per call, so filling one arms it and emptying one disarms it — and the
 * front-end writes into them when it has something to put there.
 *
 * A seventh seam is added here, and to all three implementations, or it is invisible again.
 */

import type { Listener } from "./agent/agent.ts";
import type { BeforeToolCall } from "./agent/tools.ts";
import type { VerifyConsent } from "./minima/big_plan.ts";
import type { ChildEvent } from "./minima/spawn.ts";
import type { AskUserRef } from "./tools/question.ts";

export type FrontEndName = "terminal" | "non-interactive" | "acp";

/** Seam 1 — tool-call permission: the hook the dispatcher runs before every tool call, which
 *  may block it. Empty while the front-end has no user to ask yet (the terminal UI's overlay
 *  before React mounts); see `FrontEnd.permission` for what having no seam at all means. */
export interface PermissionSeam {
  current: BeforeToolCall | null;
}

/**
 * Seam 3 — verification consent: may this verify command execute on the host right now? Never
 * empty, because the harness's own default has to be a decision rather than an accident: a
 * plan's verify commands are model-authored shell, so the fail-closed checker holds the slot
 * until a front-end that can ask replaces it.
 */
export interface VerifyConsentSeam {
  current: VerifyConsent;
}

/**
 * Seam 4 — sub-agent progress: every event a delegated child emits, as it emits it. Empty
 * means the events are dropped; the child's final result still returns through the task tool.
 */
export interface ChildEventSeam {
  handler: ((event: ChildEvent) => void) | null;
}

/**
 * Seam 5 — the agent's event stream. Empty means this front-end is not watching it, which is
 * a real answer: `--print` reads the final message off the agent once the run is over rather
 * than following it.
 */
export interface AgentEventSeam {
  listener: Listener | null;
}

/**
 * Seam 6 — client-owned file IO (MUB-241/S4): reading and writing through the client that is
 * driving us, so the agent sees unsaved editor buffers instead of stale disk.
 *
 * `never` is the honest element type today. `null` — read and write through the harness's own
 * filesystem IO — is the only value any front-end can hold until S4 defines what an adapter
 * is, and S4 then replaces `never` with that type rather than adding a seventh seam nobody
 * named. The seam is here now because being unnamed is the defect this contract exists to fix.
 */
export type FrontEndIo = never;

export interface IoSeam {
  current: FrontEndIo | null;
}

/** One front-end's declaration of how it fills each of the six seams. */
export interface FrontEnd {
  readonly name: FrontEndName;
  /**
   * Seam 1. `null` is the declaration that this front-end never prompts: nothing is attached,
   * so tool calls reach the dispatcher through a hook stack that has never contained a
   * permission hook and every one of them runs unprompted. A front-end with a user to ask
   * supplies a (initially empty) slot instead.
   */
  readonly permission: PermissionSeam | null;
  /** Seam 2 — the `question` tool's ask callback. Empty means there is nobody to ask, and the
   *  tool tells the model to proceed on its best assumption rather than block. */
  readonly askUser: AskUserRef;
  /** Seam 3. */
  readonly verifyConsent: VerifyConsentSeam;
  /** Seam 4. */
  readonly childEvents: ChildEventSeam;
  /** Seam 5. */
  readonly agentEvents: AgentEventSeam;
  /** Seam 6. */
  readonly io: IoSeam;
}

/** A front-end that prompts: its permission seam is a slot, never an absence. */
export interface PromptingFrontEnd extends FrontEnd {
  readonly permission: PermissionSeam;
}

/**
 * Does this front-end prompt for permission at all? The narrowing matters where a surface can
 * only work with one that does — accepting a front-end that declares it never prompts and
 * quietly carrying on would rebuild the invisible gap this contract exists to close.
 */
export function promptsForPermission(front: FrontEnd): front is PromptingFrontEnd {
  return front.permission !== null;
}

/** Whatever a seam attaches to — the MinimaAgent, in every real run. */
export interface AgentEventSource {
  subscribe(listener: Listener): () => void;
}

/** Whatever the permission seam attaches to — the MinimaAgent, in every real run. */
export interface ToolDispatchSource {
  addBeforeToolCall(hook: BeforeToolCall): () => void;
}

/**
 * Put the front-end's permission seam on the tool-dispatch hook stack, and return the
 * disposer. The slot is read per call, so a front-end that fills it later (the terminal UI, on
 * mount) is armed the moment it does and disarmed the moment it empties it again. An empty
 * slot is no opinion — the same as not being on the stack at all.
 */
export function attachPermissionSeam(source: ToolDispatchSource, seam: PermissionSeam): () => void {
  return source.addBeforeToolCall(async (ctx) => (await seam.current?.(ctx)) ?? null);
}

/**
 * Subscribe the front-end's event seam, and return the disposer. Read per event for the same
 * reason as the permission seam: the terminal UI's listener does not exist until React has
 * mounted, and it goes away again on unmount.
 */
export function subscribeAgentEvents(source: AgentEventSource, seam: AgentEventSeam): () => void {
  return source.subscribe((event) => seam.listener?.(event));
}
