/**
 * BusyIndicator — an animated spinner plus a rotating tip, shown while the agent is
 * thinking or running tools. This is the "spinner tips" UX from Claude Code: instead
 * of an idle wait, the user sees liveness (an animated glyph + elapsed seconds) and a
 * fresh tip every few seconds. Renders nothing when idle.
 *
 * The tip half is gated by `showTip` so `/tip off` silences tips while keeping the
 * spinner (matching Claude Code's `spinnerTipsEnabled`, which never disables the
 * spinner itself). Timers only run while `active` is true, so an idle app burns nothing.
 */

import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { formatTip, pick } from "./tips.ts";

// Braille spinner — the widely-used cli-spinners "dots" frames.
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** The spinner glyph for animation tick `n`, wrapping (and tolerant of negatives). */
export function spinnerFrame(n: number): string {
  const len = SPINNER_FRAMES.length;
  return SPINNER_FRAMES[((n % len) + len) % len] as string;
}

const SPINNER_INTERVAL_MS = 120; // glyph animation cadence (~8fps)
const TIP_ROTATE_MS = 7000; // swap the tip roughly every 7s of waiting
const TICKS_PER_TIP = Math.max(1, Math.round(TIP_ROTATE_MS / SPINNER_INTERVAL_MS));

// Rotates the *starting* tip across successive busy periods so two turns in a row don't
// open on the same tip. Module-level, no persistence — resets each process, which is fine.
let busyEpoch = 0;

export interface BusyIndicatorProps {
  active: boolean;
  /** The verb shown next to the spinner. */
  state: "thinking" | "working";
  /** When false, the tip is hidden (spinner + elapsed still show). */
  showTip?: boolean;
}

export function BusyIndicator({ active, state, showTip = true }: BusyIndicatorProps) {
  const [tick, setTick] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [tipBase, setTipBase] = useState(0);

  useEffect(() => {
    if (!active) return;
    setTick(0);
    setStartedAt(Date.now());
    setTipBase(busyEpoch++);
    const id = setInterval(() => setTick((t) => t + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active]);

  if (!active) return null;

  const elapsed = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  const tipIdx = tipBase + Math.floor(tick / TICKS_PER_TIP);

  return (
    <Box marginTop={1}>
      <Text color="yellow">{spinnerFrame(tick)} </Text>
      <Text color="gray">{state}… </Text>
      {showTip ? <Text color="yellow">{formatTip(pick(tipIdx))} </Text> : null}
      <Text color="gray">{`· ${elapsed}s · esc to interrupt`}</Text>
    </Box>
  );
}
