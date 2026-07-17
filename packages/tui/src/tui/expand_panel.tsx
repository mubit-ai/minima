/**
 * The expanded live-region panel chassis (D3b; certified by the MP4 spike). Dumb by
 * design: app.tsx owns the panel state machine (panel_state.ts) and the height math
 * (panelOuterHeight) — this component only windows lines around the cursor and forwards
 * every keypress up. Rendering rules that keep the wipe-threshold identity honest:
 * explicit height + flexShrink 0 (Yoga must never negotiate this box), every row
 * wrap="truncate" (exactly one terminal row per line), and clipPanelLines pads short
 * content so all reserved rows paint.
 */
import { Box, Text, useInput } from "ink";
import { clipPanelLines } from "./layout.ts";
import type { PanelNavKey } from "./panel_state.ts";

export interface ExpandPanelProps {
  title: string;
  lines: string[];
  cursor: number;
  /** Cursor-stop line indices (section titles) — rendered cyan; null = plain reader. */
  stops: number[] | null;
  outerHeight: number;
  onKey: (input: string, key: PanelNavKey & { ctrl?: boolean }) => void;
}

/** Border(2) + breadcrumb header(1): rows the chassis spends beyond the content window. */
export const PANEL_CHROME_ROWS = 3;

export function ExpandPanel({ title, lines, cursor, stops, outerHeight, onKey }: ExpandPanelProps) {
  useInput((input, key) => onKey(input, key));
  const inner = Math.max(1, outerHeight - PANEL_CHROME_ROWS);
  const { lines: windowed, top } = clipPanelLines(lines, inner, cursor);
  const stopSet = stops ? new Set(stops) : null;
  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      flexDirection="column"
      width="100%"
      height={outerHeight}
      flexShrink={0}
    >
      <Text color="cyan" bold wrap="truncate">
        {title}
      </Text>
      {windowed.map((line, i) => {
        const idx = top + i;
        const active = idx === cursor && idx < lines.length;
        const isStop = stopSet?.has(idx) ?? false;
        return (
          <Text
            key={idx}
            wrap="truncate"
            color={active ? undefined : isStop ? "cyan" : "gray"}
            bold={active || isStop}
          >
            {active ? `❯ ${line}` : `  ${line}`}
          </Text>
        );
      })}
    </Box>
  );
}
