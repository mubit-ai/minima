/**
 * D3b reader mode (MP8): turn a ToC section's messages into plain text lines for the
 * panel window (the Q27b decision — inline cannot scroll the terminal's scrollback, so
 * reading happens IN the panel). v1 is plain committed-text: the transcript's header
 * glyphs + word-wrap via the SAME wrapLineToWidth the height estimates are defined by
 * (estimate == render by construction), tool bodies clamped with the honest
 * `… +N more lines` marker, assistant markdown mirrored the way markdownBodyHeight
 * counts it (heading → blank + text; bullet → "- "; else plain). Not a MessageRow
 * re-mount — no Ink here.
 */
import { clampToolText, classifyMarkdownLines, wrapLineToWidth } from "./layout.ts";
import type { ChatMessage } from "./messages.tsx";

function bodyLines(text: string, w: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) out.push(...wrapLineToWidth(line, w));
  return out;
}

export function sectionReaderLines(
  messages: ChatMessage[],
  startIdx: number,
  endIdx: number,
  width: number,
): string[] {
  const w = Math.max(20, width);
  const out: string[] = [];
  for (let i = Math.max(0, startIdx); i < Math.min(endIdx, messages.length); i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (out.length > 0) out.push("");
    if (msg.role === "user") {
      out.push("▸ you");
      out.push(...bodyLines(msg.text, w));
    } else if (msg.role === "tool") {
      out.push(`⚙ ${msg.toolName ?? "tool"}:`);
      const { text, hiddenLines } = clampToolText(msg.text, w + 4);
      out.push(...bodyLines(text, w));
      if (hiddenLines > 0) out.push(`… +${hiddenLines} more lines`);
    } else if (msg.role === "thinking") {
      out.push("🧠 reasoning");
      out.push(...bodyLines(msg.text, w));
    } else {
      out.push("◆ assistant");
      for (const l of classifyMarkdownLines(msg.text)) {
        if (l.kind === "heading") {
          out.push("");
          out.push(...wrapLineToWidth(l.text, w));
        } else if (l.kind === "list") {
          out.push(...wrapLineToWidth(`- ${l.text}`, w));
        } else {
          out.push(...wrapLineToWidth(l.text, w));
        }
      }
    }
  }
  return out.length > 0 ? out : ["(empty section)"];
}
