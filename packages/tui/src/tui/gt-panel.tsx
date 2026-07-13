/**
 * GT Plan Overview panel (U3, MUB-141) — fullscreen renderer only, same overpaint chassis
 * as TocPanel: absolute right-anchored box, every interior row paints innerWidth padded
 * columns closed by the right border glyph. Enter on a step swaps the panel content to its
 * detail card (stepCardLines — the shared J1 /why component); Esc steps back out of the
 * card, then closes.
 */

import { Box, Text } from "ink";
import { useInput } from "ink";
import React, { useMemo, useState } from "react";

import { type GtOverview, gtRows, padDisplay, stepCardLines } from "./gt_overview.ts";
import { type PanelGeometry, clipPanelLines } from "./layout.ts";

export interface GtPanelProps {
  overview: GtOverview;
  geometry: PanelGeometry;
  onClose: () => void;
}

export function GtPanel({ overview, geometry, onClose }: GtPanelProps) {
  const [cursor, setCursor] = useState(0); // index into overview.steps
  const [detail, setDetail] = useState<number | null>(null);
  const steps = overview.steps;

  const rows = useMemo(
    () => gtRows(overview, geometry.innerWidth),
    [overview, geometry.innerWidth],
  );
  const cardLines = useMemo(() => {
    if (detail === null || !steps[detail]) return null;
    const row = steps[detail];
    return stepCardLines(row, overview.gatesByStep.get(row.stepId) ?? []);
  }, [detail, steps, overview]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "g")) {
      if (detail !== null) setDetail(null);
      else onClose();
      return;
    }
    if (detail !== null) return; // the card has no cursor — only Esc/Ctrl+G above
    if (key.upArrow || input === "k") {
      setCursor((c) => (steps.length ? (c - 1 + steps.length) % steps.length : 0));
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor((c) => (steps.length ? (c + 1) % steps.length : 0));
      return;
    }
    if (key.return && steps[cursor]) {
      setDetail(cursor);
      return;
    }
  });

  const hint = detail === null ? "↑↓ move · ⏎ detail · esc close" : "esc back";
  let lines: string[];
  let top = 0;
  let cursorRow = -1;
  if (cardLines) {
    ({ lines, top } = clipPanelLines(cardLines, geometry.innerHeight - 1, 0));
  } else {
    cursorRow = Math.max(
      0,
      rows.findIndex((r) => r.isTitle && r.stepIdx === cursor),
    );
    ({ lines, top } = clipPanelLines(
      rows.map((r) => r.text),
      geometry.innerHeight - 1,
      cursorRow,
    ));
  }

  return (
    <Box
      position="absolute"
      alignSelf="flex-end"
      width={geometry.width}
      height={geometry.height}
      flexDirection="column"
      borderStyle="round"
      borderColor="green"
      overflow="hidden"
    >
      {lines.map((line, i) => {
        const row = cardLines ? undefined : rows[top + i];
        const isCursor = row?.isTitle === true && row.stepIdx === cursor;
        return (
          <Text key={String(i)} wrap="truncate">
            <Text color={isCursor ? "green" : undefined} inverse={isCursor || undefined}>
              {` ${padDisplay(line, geometry.innerWidth)} `}
            </Text>
          </Text>
        );
      })}
      <Text wrap="truncate" color="gray">
        {` ${padDisplay(hint, geometry.innerWidth)} `}
      </Text>
    </Box>
  );
}
