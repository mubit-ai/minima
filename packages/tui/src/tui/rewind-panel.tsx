/**
 * /rewind turn picker panel (B5, MUB-142) — fullscreen renderer only, same overpaint
 * chassis as TocPanel/GtPanel. j/k move over turns; on the selected turn [c] rewinds the
 * conversation, [f] restores files (code), [b] both; Esc closes. The panel closes itself
 * after dispatching — the executor appends the outcome as a tool message.
 */

import { Box, Text } from "ink";
import { useInput } from "ink";
import React, { useState } from "react";

import { padDisplay } from "./gt_overview.ts";
import { type PanelGeometry, clipPanelLines } from "./layout.ts";
import type { RewindMode, RewindTurn } from "./rewind_picker.ts";

export interface RewindPanelProps {
  turns: RewindTurn[];
  geometry: PanelGeometry;
  onRewind: (turn: RewindTurn, mode: RewindMode) => void;
  onClose: () => void;
}

export function RewindPanel({ turns, geometry, onRewind, onClose }: RewindPanelProps) {
  const [cursor, setCursor] = useState(Math.max(0, turns.length - 1));

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((c) => (turns.length ? (c - 1 + turns.length) % turns.length : 0));
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor((c) => (turns.length ? (c + 1) % turns.length : 0));
      return;
    }
    const turn = turns[cursor];
    if (!turn) return;
    if (input === "c") {
      onClose();
      onRewind(turn, "convo");
    } else if (input === "f") {
      onClose();
      onRewind(turn, "code");
    } else if (input === "b" || key.return) {
      onClose();
      onRewind(turn, "both");
    }
  });

  const rows = turns.map(
    (t) => `${String(t.liveIdx).padStart(3)}. ${t.title}${t.codeRestorable ? " ✓" : ""}`,
  );
  const { lines, top } = clipPanelLines(rows, geometry.innerHeight - 2, cursor);

  return (
    <Box
      position="absolute"
      alignSelf="flex-end"
      width={geometry.width}
      height={geometry.height}
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      overflow="hidden"
    >
      <Text wrap="truncate" color="yellow">
        {` ${padDisplay("Rewind to before prompt…", geometry.innerWidth)} `}
      </Text>
      {lines.map((line, i) => {
        const isCursor = top + i === cursor && line !== "";
        return (
          <Text key={String(i)} wrap="truncate">
            <Text color={isCursor ? "yellow" : undefined} inverse={isCursor || undefined}>
              {` ${padDisplay(line, geometry.innerWidth)} `}
            </Text>
          </Text>
        );
      })}
      <Text wrap="truncate" color="gray">
        {` ${padDisplay("[c]onvo · [f]iles · [b]oth/⏎ · esc", geometry.innerWidth)} `}
      </Text>
    </Box>
  );
}
