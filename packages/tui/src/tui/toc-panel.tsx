/**
 * ToC sidebar panel (U2, MUB-140) — fullscreen renderer only. An absolutely-positioned,
 * right-anchored box drawn OVER the transcript region: out-of-flow, so the transcript
 * keeps its full `cols` (no reflow of the characters-per-line underneath). Opacity is by
 * construction: every interior row paints `innerWidth` padded columns and the right
 * border glyph closes each line, so interior pads are never line-trailing (Ink trims
 * trailing whitespace — a bare padEnd would puncture the overpaint).
 *
 * Input follows the CommandPicker pattern: this component owns a useInput; app.tsx adds
 * `tocOpen` to the global hook's guard list and suspends TextInput while open.
 */

import { Box, Text } from "ink";
import { useInput } from "ink";
import React, { useMemo, useState } from "react";

import { type PanelGeometry, clipPanelLines } from "./layout.ts";
import { type TocSection, tocRows } from "./toc.ts";

export interface TocPanelProps {
  sections: TocSection[];
  geometry: PanelGeometry;
  /** Enter on a section title: jump the transcript to its anchor. Panel stays open. */
  onJump: (startMsgIdx: number) => void;
  onClose: () => void;
}

export function TocPanel({ sections, geometry, onJump, onClose }: TocPanelProps) {
  const [cursor, setCursor] = useState(0); // index into `sections`
  const rows = useMemo(
    () => tocRows(sections, geometry.innerWidth),
    [sections, geometry.innerWidth],
  );

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "t")) {
      onClose();
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
  });

  const cursorLine = Math.max(
    0,
    rows.findIndex((r) => r.isTitle && r.sectionIdx === cursor),
  );
  const { lines, top } = clipPanelLines(
    rows.map((r) => r.text),
    geometry.innerHeight - 1, // last interior row is the key hint
    cursorLine,
  );

  return (
    <Box
      position="absolute"
      alignSelf="flex-end"
      width={geometry.width}
      height={geometry.height}
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      overflow="hidden"
    >
      {lines.map((line, i) => {
        const row = rows[top + i]; // undefined on padding rows
        const isCursor = row?.isTitle === true && row.sectionIdx === cursor;
        return (
          <Text key={String(i)} wrap="truncate">
            <Text color={isCursor ? "cyan" : undefined} inverse={isCursor || undefined}>
              {` ${line.padEnd(geometry.innerWidth)} `}
            </Text>
          </Text>
        );
      })}
      <Text wrap="truncate" color="gray">
        {` ${"↑↓ move · ⏎ jump · esc close".padEnd(geometry.innerWidth)} `}
      </Text>
    </Box>
  );
}
