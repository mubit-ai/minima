/**
 * BusyIndicator — an animated spinner, a rotating verb, and a rotating tip, shown
 * while a turn is running (model reasoning or tool execution). Instead of an idle
 * wait the user sees liveness (an animated glyph, a playful verb, elapsed seconds)
 * and a fresh tip every few seconds. Renders nothing when idle.
 *
 * The tip half is gated by `showTip` so `/tip off` silences tips while keeping the
 * spinner + verb. Timers only run while `active` is true, so an idle app burns nothing.
 */

import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { formatTip, pick } from "./tips.ts";

// Braille spinner — the widely-used cli-spinners "dots" frames.
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

// Playful Minima-flavored progress verbs. Rotated over time and phase-independent — they
// convey "busy", not a specific stage. Kept original (a nod to Minima's routing/recommend/
// judge/memory loop) rather than borrowed from any other tool's spinner vocabulary.
export const VERBS = [
  "routing",
  "crunching",
  "brewing",
  "dispatching",
  "assembling",
  "orchestrating",
  "triangulating",
  "reconciling",
  "canvassing",
  "tallying",
  "wrangling",
  "marshalling",
] as const;

/** The spinner glyph for animation tick `n`, wrapping (and tolerant of negatives). */
export function spinnerFrame(n: number): string {
  const len = SPINNER_FRAMES.length;
  return SPINNER_FRAMES[((n % len) + len) % len] as string;
}

/** The progress verb at rotation index `n`, wrapping (and tolerant of negatives). */
export function pickVerb(n: number): string {
  const len = VERBS.length;
  return VERBS[((n % len) + len) % len] as string;
}

const SPINNER_INTERVAL_MS = 120; // glyph animation cadence (~8fps)
const VERB_ROTATE_MS = 3000; // swap the verb roughly every 3s of waiting
const TIP_ROTATE_MS = 7000; // swap the tip roughly every 7s of waiting
const TICKS_PER_VERB = Math.max(1, Math.round(VERB_ROTATE_MS / SPINNER_INTERVAL_MS));
const TICKS_PER_TIP = Math.max(1, Math.round(TIP_ROTATE_MS / SPINNER_INTERVAL_MS));

// Rotates the *starting* verb + tip across successive busy periods so two turns in a row
// don't open on the same words. Module-level, no persistence — resets each process, fine.
let busyEpoch = 0;

export interface BusyIndicatorProps {
  active: boolean;
  /** When false, the tip is hidden (spinner + verb + elapsed still show). */
  showTip?: boolean;
}

export function BusyIndicator({ active, showTip = true }: BusyIndicatorProps) {
  const [tick, setTick] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [base, setBase] = useState(0);

  useEffect(() => {
    if (!active) return;
    setTick(0);
    setStartedAt(Date.now());
    setBase(busyEpoch++);
    const id = setInterval(() => setTick((t) => t + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active]);

  if (!active) return null;

  const elapsed = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  const verb = pickVerb(base + Math.floor(tick / TICKS_PER_VERB));
  const tipIdx = base + Math.floor(tick / TICKS_PER_TIP);

  return (
    <Box marginTop={1}>
      <Text color="yellow">{spinnerFrame(tick)} </Text>
      <Text color="gray">{verb}… </Text>
      {showTip ? <Text color="yellow">{formatTip(pick(tipIdx))} </Text> : null}
      <Text color="gray">{`· ${elapsed}s · esc to abort`}</Text>
    </Box>
  );
}
