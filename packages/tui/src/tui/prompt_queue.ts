/**
 * Busy-composer prompt queue (MUB-183) — the pure decision + state core, kept free of
 * Ink/React so the semantics are unit-testable.
 *
 * While a turn runs, Enter either DISPATCHES a read-only local command immediately
 * (panels stay usable mid-run) or ENQUEUES the line; the app drains the queue through
 * the normal submit path one item per completed turn. The queue is in-memory session
 * state — it survives nothing, on purpose.
 *
 * Abort semantics (documented contract): Esc/Ctrl+C aborts the CURRENT turn and puts a
 * non-empty queue on hold — an abort must never auto-fire the next prompt. While idle,
 * Esc clears the held queue; submitting a fresh PROMPT (not a slash command) releases
 * the hold so the queue resumes after that turn.
 */

export interface PromptQueue {
  readonly items: readonly string[];
  readonly held: boolean;
}

export const EMPTY_QUEUE: PromptQueue = { items: [], held: false };

export type BusySubmit = { kind: "dispatch"; name: string; args: string } | { kind: "enqueue" };

/**
 * Allowlist of commands safe to run mid-turn: side-effect-free and panel/print-only.
 * Sub-command gating is deliberately conservative — `/tasks cancel` injects a user turn
 * into agent state, `/cost fleet` hits the network, `/memory <mutation>` writes the
 * ledger: all of those queue instead.
 */
function isLocalWhileBusy(name: string, args: string): boolean {
  switch (name) {
    case "tree":
    case "why":
    case "bp":
    case "session":
    case "perms":
    case "help":
      return true;
    case "tasks":
    case "cost":
      return args === "";
    case "memory":
      return args === "" || args === "list";
    default:
      return false;
  }
}

export function decideBusySubmit(text: string): BusySubmit {
  const trimmed = text.trim();
  if (trimmed.startsWith("/")) {
    const firstSpace = trimmed.indexOf(" ");
    const name = firstSpace !== -1 ? trimmed.slice(1, firstSpace) : trimmed.slice(1);
    const args = firstSpace !== -1 ? trimmed.slice(firstSpace + 1).trim() : "";
    if (isLocalWhileBusy(name.toLowerCase(), args.toLowerCase())) {
      return { kind: "dispatch", name: name.toLowerCase(), args };
    }
  }
  return { kind: "enqueue" };
}

export function enqueuePrompt(q: PromptQueue, text: string): PromptQueue {
  return { items: [...q.items, text], held: q.held };
}

export function holdOnAbort(q: PromptQueue): PromptQueue {
  return q.items.length === 0 || q.held ? q : { items: q.items, held: true };
}

export function releaseOnPrompt(q: PromptQueue, text: string): PromptQueue {
  if (!q.held || text.trim().startsWith("/")) return q;
  return { items: q.items, held: false };
}

export function clearQueue(q: PromptQueue): { queue: PromptQueue; cleared: number } {
  return { queue: EMPTY_QUEUE, cleared: q.items.length };
}

export function takeNext(q: PromptQueue): { queue: PromptQueue; next: string } | null {
  if (q.held || q.items.length === 0) return null;
  return { queue: { items: q.items.slice(1), held: false }, next: q.items[0] as string };
}

export function queueNote(q: PromptQueue): string | null {
  if (q.items.length === 0) return null;
  const base = `${q.items.length} queued`;
  return q.held ? `${base} · held (esc clears)` : base;
}
