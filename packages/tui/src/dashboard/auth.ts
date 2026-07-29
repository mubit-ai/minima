/**
 * Dashboard credentials: the long-lived bearer token's comparison, and the short-lived tickets
 * that stand in for it wherever the URL is going somewhere we do not control.
 *
 * Why tickets exist: `/dashboard` prints a clickable URL into the transcript. The durable token
 * lives in a 0600 rendezvous file, but a URL on screen is only as protected as whatever ends up
 * persisting the screen — scrollback, a tmux capture, a `script(1)` log. The harness writes that
 * line to no file of its own (in-memory messages only), and controls none of the rest.
 * A ticket is an HMAC of an expiry under the token, so it is worthless a minute after it is
 * printed and the durable secret never leaves the 0600 file. Stateless by construction: no map
 * to grow, no route to mint from, nothing to clean up.
 */

import { createHmac } from "node:crypto";

/** How long a printed link stays usable. Short on purpose — `/dashboard` re-issues on demand. */
export const TICKET_TTL_MS = 60_000;

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function ticketMac(token: string, exp: number): string {
  return createHmac("sha256", token).update(String(exp)).digest("base64url").slice(0, 32);
}

export function mintTicket(token: string, now: number = Date.now(), ttlMs = TICKET_TTL_MS): string {
  const exp = now + ttlMs;
  return `${exp}.${ticketMac(token, exp)}`;
}

export function ticketValid(token: string, ticket: string, now: number = Date.now()): boolean {
  const dot = ticket.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(ticket.slice(0, dot));
  if (!Number.isInteger(exp) || exp <= now) return false;
  // A ticket may not outlive the TTL even if its holder could mint one: caps the blast radius of
  // a ticket that leaks somewhere durable to the same minute as every other ticket.
  if (exp - now > TICKET_TTL_MS) return false;
  return constantTimeEqual(ticket.slice(dot + 1), ticketMac(token, exp));
}
