/**
 * Human-facing text for a thrown value.
 *
 * `String(err)` on an Error yields "Error: <msg>" (the class name prefix), which — when
 * spliced into a message that already says "Error:" — produces the doubled "Error: Error: …"
 * users were seeing. Prefer the bare `.message`; fall back to String() for non-Error throws.
 */
export function errText(exc: unknown): string {
  if (exc instanceof Error) return exc.message || exc.name;
  return String(exc);
}
