/**
 * ToC sidebar panel (U2, MUB-140; borderless full-height chassis 2026-07-15) —
 * fullscreen renderer only. An IN-FLOW right column beside the transcript when docked
 * (app.tsx narrows the whole left column to geometry.contentCols while mounted) or a
 * right-anchored overpaint on narrow terminals (geometry.overlay). Persistent with a
 * focus toggle: while `focused` the panel owns navigation keys and the composer is
 * suspended via `panelCapture`; Esc blurs back to the composer with the panel still
 * docked (header dims), Ctrl+T closes/refocuses and Ctrl+G swaps to the GT panel. Rows
 * paint `innerWidth` padded columns so the inverse cursor bar spans the full width.
 */

import { useInput } from "ink";
import React, { useMemo, useState } from "react";

import { type SidebarGeometry, clipPanelLines } from "./layout.ts";
import {
  SidebarChassis,
  type SidebarInfo,
  SidebarRow,
  sidebarBodyRows,
} from "./sidebar-chassis.tsx";
import { type TocSection, tocRows } from "./toc.ts";

export interface TocPanelProps {
  sections: TocSection[];
  geometry: SidebarGeometry;
  /** Keyboard owner: true → this panel handles keys; false → docked but inert. */
  focused: boolean;
  /** OpenCode-style session-info block pinned above the chassis footer. */
  info?: SidebarInfo | null;
  /** Enter on a section title: jump the transcript to its anchor. Panel stays open. */
  onJump: (startMsgIdx: number) => void;
  onClose: () => void;
  /** Esc while focused: keyboard back to the composer, panel stays docked. */
  onBlur: () => void;
  /** Ctrl+G while focused: swap to the GT sidebar (focused). */
  onSwitch: () => void;
}

export function TocPanel({
  sections,
  geometry,
  focused,
  info,
  onJump,
  onClose,
  onBlur,
  onSwitch,
}: TocPanelProps) {
  const [cursor, setCursor] = useState(0); // index into `sections`
  const rows = useMemo(
    () => tocRows(sections, geometry.innerWidth),
    [sections, geometry.innerWidth],
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        onBlur();
        return;
      }
      if (key.ctrl && input === "t") {
        onClose();
        return;
      }
      if (key.ctrl && input === "g") {
        onSwitch();
        return;
      }
      if (key.upArrow || input === "k") {
        setCursor((c) => (sections.length ? (c - 1 + sections.length) % sections.length : 0));
        return;
      }
      if (key.downArrow || input === "j") {
        setCursor((c) => (sections.length ? (c + 1) % sections.length : 0));
        return;
      }
      if (key.return && sections[cursor]) {
        onJump(sections[cursor].startMsgIdx);
        return;
      }
    },
    { isActive: focused },
  );

  const cursorLine = Math.max(
    0,
    rows.findIndex((r) => r.isTitle && r.sectionIdx === cursor),
  );
  const { lines, top } = clipPanelLines(
    rows.map((r) => r.text),
    sidebarBodyRows(geometry, info), // chassis chrome + info rows live outside the body
    cursorLine,
  );
  const hint = focused ? "↑↓ · ⏎ jump · esc prompt · ^T close" : "^T focus · ^G plan";

  return (
    <SidebarChassis
      title="Contents"
      accent="cyan"
      focused={focused}
      hint={hint}
      geometry={geometry}
      info={info}
    >
      {lines.map((line, i) => {
        const row = rows[top + i]; // undefined on padding rows
        const isCursor = focused && row?.isTitle === true && row.sectionIdx === cursor;
        return (
          <SidebarRow
            key={String(i)}
            text={line}
            width={geometry.innerWidth}
            color={isCursor ? "cyan" : undefined}
            inverse={isCursor}
          />
        );
      })}
    </SidebarChassis>
  );
}
