/**
 * GT Plan Overview panel (U3, MUB-141; docked 2026-07-14) — fullscreen renderer only,
 * same docked chassis as TocPanel: an in-flow right column with a focus toggle. Enter on
 * a step swaps the panel content to its detail card (stepCardLines — the shared J1 /why
 * component); Esc steps back out of the card, then blurs to the composer (panel stays
 * docked); Ctrl+G closes (or steps out of the card first) and Ctrl+T swaps to the ToC.
 */

import { Box, Text } from "ink";
import { useInput } from "ink";
import React, { useMemo, useState } from "react";

import { type GtOverview, gtRows, padDisplay, stepCardLines } from "./gt_overview.ts";
import { type SidebarGeometry, clipPanelLines } from "./layout.ts";

export interface GtPanelProps {
  overview: GtOverview;
  geometry: SidebarGeometry;
  /** Keyboard owner: true → this panel handles keys; false → docked but inert. */
  focused: boolean;
  onClose: () => void;
  /** Esc (outside the detail card) while focused: keyboard back to the composer. */
  onBlur: () => void;
  /** Ctrl+T while focused: swap to the ToC sidebar (focused). */
  onSwitch: () => void;
}

export function GtPanel({ overview, geometry, focused, onClose, onBlur, onSwitch }: GtPanelProps) {
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

  useInput(
    (input, key) => {
      if (key.escape) {
        if (detail !== null) setDetail(null);
        else onBlur();
        return;
      }
      if (key.ctrl && input === "g") {
        if (detail !== null) setDetail(null);
        else onClose();
        return;
      }
      if (key.ctrl && input === "t") {
        onSwitch();
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
    },
    { isActive: focused },
  );

  const hint = !focused
    ? "^G focus · ^T contents"
    : detail === null
      ? "↑↓ · ⏎ card · esc prompt · ^G close"
      : "esc back";
  let lines: string[];
  let top = 0;
  if (cardLines) {
    ({ lines, top } = clipPanelLines(cardLines, geometry.innerHeight - 2, 0));
  } else {
    const cursorRow = Math.max(
      0,
      rows.findIndex((r) => r.isTitle && r.stepIdx === cursor),
    );
    ({ lines, top } = clipPanelLines(
      rows.map((r) => r.text),
      geometry.innerHeight - 2, // first interior row is the header, last is the key hint
      cursorRow,
    ));
  }
  const accent = focused ? "green" : "gray";

  return (
    <Box
      flexShrink={0}
      width={geometry.sidebarWidth}
      height={geometry.height}
      flexDirection="column"
      borderStyle="round"
      borderColor={accent}
      overflow="hidden"
    >
      <Text wrap="truncate" color={accent} bold>
        {` ${padDisplay("Plan overview", geometry.innerWidth)} `}
      </Text>
      {lines.map((line, i) => {
        const row = cardLines ? undefined : rows[top + i];
        const isCursor = focused && row?.isTitle === true && row.stepIdx === cursor;
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
