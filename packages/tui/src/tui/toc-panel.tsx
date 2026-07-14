/**
 * ToC sidebar panel (U2, MUB-140; docked 2026-07-14) — fullscreen renderer only. An
 * IN-FLOW right column beside the transcript (app.tsx narrows the content to
 * geometry.contentCols while it is mounted). Persistent with a focus toggle: while
 * `focused` the panel owns navigation keys and the composer is suspended via
 * `panelCapture`; Esc blurs back to the composer with the panel still docked (border
 * dims), Ctrl+T closes/refocuses and Ctrl+G swaps to the GT panel. Rows still paint
 * `innerWidth` padded columns so the inverse cursor bar spans the full width.
 */

import { Box, Text } from "ink";
import { useInput } from "ink";
import React, { useMemo, useState } from "react";

import { padDisplay } from "./gt_overview.ts";
import { type SidebarGeometry, clipPanelLines } from "./layout.ts";
import { type TocSection, tocRows } from "./toc.ts";

export interface TocPanelProps {
  sections: TocSection[];
  geometry: SidebarGeometry;
  /** Keyboard owner: true → this panel handles keys; false → docked but inert. */
  focused: boolean;
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
    geometry.innerHeight - 2, // first interior row is the header, last is the key hint
    cursorLine,
  );
  const accent = focused ? "cyan" : "gray";
  const hint = focused ? "↑↓ · ⏎ jump · esc prompt · ^T close" : "^T focus · ^G plan";

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
        {` ${padDisplay("Contents", geometry.innerWidth)} `}
      </Text>
      {lines.map((line, i) => {
        const row = rows[top + i]; // undefined on padding rows
        const isCursor = focused && row?.isTitle === true && row.sectionIdx === cursor;
        return (
          <Text key={String(i)} wrap="truncate">
            <Text color={isCursor ? "cyan" : undefined} inverse={isCursor || undefined}>
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
