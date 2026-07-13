/**
 * Footer badge slot — Phase-0 shared surface (docs/BigPlan/PLAN.md §3, MUB-129). One
 * right-anchored badge that both renderers draw in the StatusBar's first row. Track A guards
 * (🟡 flags) and Track B modes (PLAN/BUILD) set it; nothing else owns that screen real estate.
 *
 * Framework-free external store so non-React code (agent hooks, guards) can set the badge;
 * app.tsx subscribes via useSyncExternalStore. `MINIMA_TUI_BADGE=<text>` seeds a demo badge —
 * the hook the PTY-shot acceptance artifacts use.
 */

export interface FooterBadge {
  text: string;
  /** Ink color name; StatusBar defaults to "magenta". */
  color?: string;
}

let current: FooterBadge | null = process.env.MINIMA_TUI_BADGE
  ? { text: process.env.MINIMA_TUI_BADGE }
  : null;

const subscribers = new Set<() => void>();

export function getFooterBadge(): FooterBadge | null {
  return current;
}

export function setFooterBadge(badge: FooterBadge | null): void {
  // Drop no-op updates so useSyncExternalStore subscribers don't re-render for nothing.
  if (badge === current) return;
  if (badge && current && badge.text === current.text && badge.color === current.color) return;
  current = badge;
  for (const fn of subscribers) fn();
}

export function subscribeFooterBadge(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
