/**
 * Borderless OpenCode-style chassis shared by the ToC and GT sidebars (2026-07-15
 * restyle): a full-terminal-height column with a bold accent header, an exactly-budgeted
 * body, an optional info section, and a footer pinned to the bottom (cwd with the last
 * segment bold · "● Minima <version>" · key hint). Row accounting is exact — header(1) +
 * blank(1) + body + [blank(1) + info title(1) + info lines] + blank(1) + cwd(1) +
 * version(1) + hint(1) = innerHeight — so the footer sits on the terminal's last row;
 * panels MUST size their body with sidebarBodyRows(). In `overlay` mode the chassis
 * absolutely overpaints the right edge (same alignSelf pin as the rewind picker; height
 * equals the container's, which dodges Yoga's static-position ambiguity).
 */

import os from "node:os";
import { Box, Text } from "ink";
import type React from "react";
import stringWidth from "string-width";

import { VERSION } from "../version.ts";
import { padDisplay } from "./gt_overview.ts";
import { SIDEBAR_CHROME_ROWS, type SidebarGeometry } from "./layout.ts";

const GUTTER = "  ";

/** Display-width trim from the LEFT ("…tail") — paths keep their meaningful tail. */
function fitStart(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  const cps = [...text];
  let w = 1;
  let out = "";
  for (let i = cps.length - 1; i >= 0; i--) {
    const cw = stringWidth(cps[i]!);
    if (w + cw > width) break;
    out = cps[i] + out;
    w += cw;
  }
  return `…${out}`;
}

/** cwd → { head: "~/Mubit/Minima/", base: "minima" }, fitted to `width` display cols. */
export function cwdSegments(width: number, cwd = process.cwd()): { head: string; base: string } {
  const home = os.homedir();
  let p = cwd;
  if (p === home || p.startsWith(`${home}/`)) p = `~${p.slice(home.length)}`;
  const slash = p.lastIndexOf("/");
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  let head = slash >= 0 ? p.slice(0, slash + 1) : "";
  if (stringWidth(base) >= width) return { head: "", base: fitStart(base, width) };
  if (stringWidth(head) + stringWidth(base) > width) {
    head = fitStart(head, width - stringWidth(base));
  }
  return { head, base };
}

export interface SidebarInfo {
  title: string;
  lines: string[];
}

/** Body rows the panel must paint: everything the chassis chrome + info don't consume. */
export function sidebarBodyRows(geometry: SidebarGeometry, info?: SidebarInfo | null): number {
  return Math.max(
    1,
    geometry.innerHeight - SIDEBAR_CHROME_ROWS - (info ? info.lines.length + 2 : 0),
  );
}

/** One padded sidebar row: gutter + innerWidth-padded text + 1-col right margin. Panels
 * use this for body rows so the inverse cursor bar spans the full inner width and, in
 * overlay mode, every column of the panel overpaints the transcript beneath. */
export function SidebarRow({
  text,
  width,
  color,
  inverse,
  bold,
}: {
  text: string;
  width: number;
  color?: string;
  inverse?: boolean;
  bold?: boolean;
}) {
  return (
    <Text wrap="truncate">
      {GUTTER}
      <Text color={color} inverse={inverse || undefined} bold={bold || undefined}>
        {padDisplay(text, width)}
      </Text>{" "}
    </Text>
  );
}

export interface SidebarChassisProps {
  title: string;
  /** Panel identity color (cyan ToC / green GT) — header + footer dot while focused. */
  accent: string;
  focused: boolean;
  hint: string;
  geometry: SidebarGeometry;
  /** Optional info section pinned above the footer (e.g. the ToC's Context block). */
  info?: SidebarInfo | null;
  /** EXACTLY sidebarBodyRows(geometry, info) painted rows. */
  children: React.ReactNode;
}

export function SidebarChassis({
  title,
  accent,
  focused,
  hint,
  geometry,
  info,
  children,
}: SidebarChassisProps) {
  const w = geometry.innerWidth;
  const { head, base } = cwdSegments(w);
  return (
    <Box
      flexShrink={0}
      width={geometry.sidebarWidth}
      height={geometry.height}
      flexDirection="column"
      overflow="hidden"
      position={geometry.overlay ? "absolute" : undefined}
      alignSelf={geometry.overlay ? "flex-end" : undefined}
    >
      <Text wrap="truncate">
        <Text color={focused ? accent : "gray"} bold>
          {focused ? "▍ " : GUTTER}
          {padDisplay(title, w)}
        </Text>{" "}
      </Text>
      <SidebarRow text="" width={w} />
      {children}
      {info ? (
        <>
          <SidebarRow text="" width={w} />
          <SidebarRow text={info.title} width={w} bold />
          {info.lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-order info lines
            <SidebarRow key={i} text={line} width={w} color="gray" />
          ))}
        </>
      ) : null}
      <SidebarRow text="" width={w} />
      <Text wrap="truncate">
        {GUTTER}
        <Text color="gray">{head}</Text>
        <Text bold>{padDisplay(base, Math.max(1, w - stringWidth(head)))}</Text>{" "}
      </Text>
      <Text wrap="truncate">
        {GUTTER}
        <Text color={focused ? accent : "gray"}>{"● "}</Text>
        <Text color="gray">{padDisplay(`Minima ${VERSION}`, Math.max(1, w - 2))}</Text>{" "}
      </Text>
      <Text wrap="truncate" color="gray">
        {GUTTER}
        {padDisplay(hint, w)}{" "}
      </Text>
    </Box>
  );
}
