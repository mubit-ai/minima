/**
 * Pending image attachments for the composer — the bridge between Ctrl+V and Enter.
 *
 * A draft is a `string`; an image is not. So the draft carries a TOKEN (`[Image #1]`) and this
 * module holds the bytes behind it. On submit the tokens still present in the text name the
 * images that get sent, which gives the whole feature its contract:
 *
 *     what you can see in the draft is what the model gets
 *
 * Backspacing the token therefore drops the image, and it costs no bookkeeping — it falls out
 * of parsing the text that was actually submitted.
 *
 * A MODULE SINGLETON, not React state, for the reason editor_chord.ts spells out: text-input.tsx
 * writes it and app.tsx reads it, and a component ref is invisible across that boundary. Ink
 * also dispatches a whole stdin chunk synchronously with no re-render in between, so two fast
 * Ctrl+V presses must both land — a state setter would collapse them onto one stale snapshot.
 *
 * IDS ARE MONOTONIC AND NEVER REUSED. Restarting at 1 per turn reads better, but a prompt
 * queued mid-turn (app.tsx onSubmit) still holds its tokens while the user types the next one —
 * and a reused id would hand the queued prompt someone else's screenshot.
 */

import type { ClipboardImage } from "./clipboard_image.ts";

export interface Attachment extends ClipboardImage {
  id: number;
}

/**
 * Ceiling on un-submitted attachments. A draft cleared with Ctrl+U abandons its tokens without
 * telling us, so the store would otherwise grow for the life of the session; the oldest entry
 * is evicted rather than refusing the paste, since the newest is the one the user is looking at.
 */
export const MAX_PENDING_ATTACHMENTS = 20;

/** The literal that stands in for an image inside the draft text. */
export function attachmentToken(id: number): string {
  return `[Image #${id}]`;
}

const TOKEN_RE = /\[Image #(\d+)\]/g;

/**
 * Ids referenced by `text`, in the order they appear, each at most once. Pure — this is the
 * function that decides what a submitted line actually carries.
 */
export function parseAttachmentTokens(text: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const id = Number(m[1]);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

const pending = new Map<number, Attachment>();
let nextId = 1;

/** Store an image and return its id; the caller inserts `attachmentToken(id)` into the draft. */
export function addAttachment(image: ClipboardImage): number {
  const id = nextId++;
  pending.set(id, { ...image, id });
  while (pending.size > MAX_PENDING_ATTACHMENTS) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    pending.delete(oldest.value);
  }
  return id;
}

/**
 * The attachments `text` refers to, in text order — REMOVED from the store as they are handed
 * over, so a turn cannot resend the previous turn's images. Unknown ids (a token the user typed
 * by hand, or one evicted by the cap) are skipped silently: the literal text still reaches the
 * model, so nothing is lost without a trace.
 */
export function consumeAttachments(text: string): Attachment[] {
  const out: Attachment[] = [];
  for (const id of parseAttachmentTokens(text)) {
    const a = pending.get(id);
    if (a !== undefined) {
      out.push(a);
      pending.delete(id);
    }
  }
  return out;
}

/** Pending count — diagnostics only; the composer's hint counts tokens in the DRAFT instead,
 * so that deleting a token updates the hint immediately. */
export function pendingAttachmentCount(): number {
  return pending.size;
}

/** Drop everything and restart numbering. Tests, and a fresh session. */
export function resetAttachments(): void {
  pending.clear();
  nextId = 1;
}
