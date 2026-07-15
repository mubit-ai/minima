/**
 * GT Plan Overview panel (U3, MUB-141; borderless full-height chassis 2026-07-15) —
 * fullscreen renderer only, same chassis as TocPanel: an in-flow right column (or
 * narrow-terminal overpaint) with a focus toggle. Enter on a step swaps the panel
 * content to its detail card (stepCardLines — the shared J1 /why component); Esc steps
 * back out of the card, then blurs to the composer (panel stays docked); Ctrl+G closes
 * (or steps out of the card first) and Ctrl+T swaps to the ToC.
 */

import { useInput } from "ink";
import React, { useMemo, useState } from "react";

import { type GtOverview, gtRows, stepCardLines } from "./gt_overview.ts";
import { type SidebarGeometry, clipPanelLines } from "./layout.ts";
import { SidebarChassis, SidebarRow, sidebarBodyRows } from "./sidebar-chassis.tsx";

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
    ({ lines, top } = clipPanelLines(cardLines, sidebarBodyRows(geometry), 0));
  } else {
    const cursorRow = Math.max(
      0,
      rows.findIndex((r) => r.isTitle && r.stepIdx === cursor),
    );
    ({ lines, top } = clipPanelLines(
      rows.map((r) => r.text),
      sidebarBodyRows(geometry), // chassis chrome rows live outside the body
      cursorRow,
    ));
  }

  return (
    <SidebarChassis
      title="Plan overview"
      accent="green"
      focused={focused}
      hint={hint}
      geometry={geometry}
    >
      {lines.map((line, i) => {
        const row = cardLines ? undefined : rows[top + i];
        const isCursor = focused && row?.isTitle === true && row.stepIdx === cursor;
        return (
          <SidebarRow
            key={String(i)}
            text={line}
            width={geometry.innerWidth}
            color={isCursor ? "green" : undefined}
            inverse={isCursor}
          />
        );
      })}
    </SidebarChassis>
  );
}
