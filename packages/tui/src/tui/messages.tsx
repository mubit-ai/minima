/**
 * Conversation rendering for the TUI.
 *
 * The finalized transcript is rendered via Ink's <Static> (see app.tsx): each message is an
 * independent, append-only item printed ONCE into the terminal's scrollback and never re-diffed.
 * That is what makes long transcripts render cleanly — Ink's cursor-relative diff only ever manages
 * the small live region (streaming reply + input + status), never content taller than the screen.
 * So this module exposes a per-MESSAGE row (not a per-turn box, which would have to grow and thus
 * couldn't be a stable Static item) plus the live streaming blocks.
 */

import { Box, Text } from "ink";
import { type ReactNode, memo } from "react";
import { isGateBlockReason } from "../minima/big_plan.ts";
import {
  BANNER_TAGLINES,
  type ChatMessage,
  clampToolText,
  classifyMarkdownLines,
  getAsciiBanner,
  toolHiddenMarker,
} from "./layout.ts";

// Re-exported so app.tsx keeps a single import site.
export type { ChatMessage };

function renderInlineMarkdown(text: string): ReactNode {
  const tokens: ReactNode[] = [];
  const currentText = text;

  const regex = /(\*\*|`)/g;
  let match = regex.exec(currentText);
  let lastIndex = 0;
  let boldActive = false;
  let codeActive = false;

  while (match) {
    const tag = match[0];
    const index = match.index;

    if (index > lastIndex) {
      const segment = currentText.slice(lastIndex, index);
      tokens.push(
        <Text key={lastIndex} bold={boldActive} color={codeActive ? "cyan" : undefined}>
          {segment}
        </Text>,
      );
    }

    if (tag === "**") {
      boldActive = !boldActive;
    } else if (tag === "`") {
      codeActive = !codeActive;
    }

    lastIndex = index + tag.length;
    match = regex.exec(currentText);
  }

  if (lastIndex < currentText.length) {
    const segment = currentText.slice(lastIndex);
    tokens.push(
      <Text key={lastIndex} bold={boldActive} color={codeActive ? "cyan" : undefined}>
        {segment}
      </Text>,
    );
  }

  return <>{tokens}</>;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ text }: { text: string }) {
  const lines = classifyMarkdownLines(text);

  return (
    <Box flexDirection="column">
      {lines.map((l, idx) => {
        if (l.kind === "heading") {
          return (
            <Box
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of text are stable
              key={idx}
              marginTop={1}
              marginBottom={0}
            >
              <Text bold color="cyan">
                {l.text || " "}
              </Text>
            </Box>
          );
        }

        if (l.kind === "list") {
          return (
            <Box
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of text are stable
              key={idx}
              marginLeft={2}
              flexDirection="row"
            >
              <Text color="yellow">{`${l.bullet} `}</Text>
              <Text>{renderInlineMarkdown(l.text)}</Text>
            </Box>
          );
        }

        // Fence delimiters render dim (kept, not dropped: exact height lockstep, the
        // language tag stays visible, and scrollback copy-paste stays valid markdown).
        if (l.kind === "fence-open" || l.kind === "fence-close") {
          return (
            <Box
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of text are stable
              key={idx}
            >
              <Text dimColor>{l.text}</Text>
            </Box>
          );
        }

        // Code: verbatim, default foreground, no inline markdown (kills the backtick
        // cyan-toggle garble). The " " forces the row Ink would collapse for an empty
        // <Text>, keeping render exactly equal to the estimate's 1 row per line.
        if (l.kind === "code") {
          return (
            <Box
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of text are stable
              key={idx}
            >
              <Text>{l.text || " "}</Text>
            </Box>
          );
        }

        // The " " armor mirrors the code branch: an empty <Text> collapses to ZERO rows
        // while markdownBodyHeight counts every source line >= 1 — on a blank-line-heavy
        // reply that over-count decayed the anchor ledger 6+ rows past the real print and
        // floated the composer (the wide-terminal stream-commit float, before-evidence
        // shots/anchor-ledger). Blank lines now render as the paragraph gaps they are.
        return (
          <Box
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of text are stable
            key={idx}
          >
            <Text>{l.text ? renderInlineMarkdown(l.text) : " "}</Text>
          </Box>
        );
      })}
    </Box>
  );
});

/**
 * One finalized message, rendered inline (no per-turn box). Used as a <Static> item — printed once
 * into scrollback. A `marginTop` gives visual separation between messages.
 *
 * memo: each row renders once via <Static>; memo is a cheap guard for the rare re-mount paths
 * (transcriptGen bumps on /clear and resume).
 */
/**
 * The MINIMA banner block. Lives in the live frame while the transcript is empty (it hides
 * for overlays/autocomplete), then commits INTO <Static> with the first message so its rows
 * leave the live frame as printed scrollback instead of dead padding (MUB-167). One JSX for
 * both forms; bannerRowCount in layout.ts is its row ruler.
 */
export function BannerBlock({ tip, width }: { tip: string | null; width?: number }) {
  return (
    <Box flexDirection="column" alignItems="center" marginTop={1} width={width}>
      <Text color="green" bold>
        {getAsciiBanner("MINIMA")}
      </Text>
      {BANNER_TAGLINES.map((line) => (
        <Box key={line} marginTop={1}>
          <Text color="gray">{line}</Text>
        </Box>
      ))}
      {tip ? (
        <Box marginTop={1}>
          <Text color="yellow">{tip}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export const MessageRow = memo(function MessageRow({
  msg,
  cols,
}: { msg: ChatMessage; cols: number }) {
  if (msg.role === "banner") {
    return <BannerBlock tip={msg.text || null} width={cols} />;
  }

  if (msg.role === "user") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="green">{"▸ you"}</Text>
        <Text backgroundColor="#2a2a35" color="white">
          {` ${msg.text} `}
        </Text>
      </Box>
    );
  }

  if (msg.role === "tool") {
    const { text: body, hiddenLines } = clampToolText(msg.text, cols);
    // A done-gate block is NOT a denial/cancellation — the call was approved and the gate
    // then refused the completion flip. Red error styling here read as "todowrite was
    // cancelled" (2026-07-21 report), so gate blocks get their own calm header.
    const gateBlock =
      msg.isError === true && msg.toolName === "todowrite" && isGateBlockReason(msg.text);
    if (gateBlock) {
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">{"  ⊘ verify gate — completion blocked, statuses unchanged:"}</Text>
          <Text>{body}</Text>
          {hiddenLines > 0 && <Text dimColor>{`  ${toolHiddenMarker(hiddenLines)}`}</Text>}
        </Box>
      );
    }
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={msg.isError ? "red" : "yellow"}>{`  ⚙ ${msg.toolName ?? "tool"}:`}</Text>
        {/* default fg (no hardcoded white — invisible on light themes); body is clipped */}
        <Text color={msg.isError ? "red" : undefined}>{body}</Text>
        {hiddenLines > 0 && <Text dimColor>{`  ${toolHiddenMarker(hiddenLines)}`}</Text>}
      </Box>
    );
  }

  if (msg.role === "thinking") {
    return (
      <Box
        flexDirection="column"
        marginTop={1}
        paddingLeft={2}
        borderStyle="single"
        borderColor="gray"
        // Hard guard against horizontal spill past the border: Ink only wraps when
        // string-width judges a line too wide, and it under-counts glyphs like 🧠/wide
        // emoji, so those lines skip wrapping and draw PAST the right border. Clip
        // horizontally at the border; vertical growth (wrapping) is unaffected.
        width="100%"
        overflowX="hidden"
      >
        <Text color="gray" italic>
          {`🧠 reasoning (${msg.thoughtDurationSecs?.toFixed(1) ?? "0.0"}s)`}
        </Text>
        <Text color="gray" italic>
          {msg.text}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="magenta">{"◆ assistant"}</Text>
      <MarkdownRenderer text={msg.text} />
    </Box>
  );
});

/** The live streaming assistant reply (dynamic region; finalizes into a MessageRow when done). */
export function StreamingReply({ text }: { text: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="magenta">{"◆ assistant"}</Text>
      <MarkdownRenderer text={text} />
    </Box>
  );
}

/** The live reasoning peek (dynamic region); truncated so it never grows past a couple of rows. */
export function StreamingThoughts({ text }: { text: string }) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1} width="100%">
      <Box flexDirection="column">
        <Text color="cyan">{"🧠 reasoning..."}</Text>
        <Text color="gray" wrap="truncate">
          {text.slice(-300)}
        </Text>
      </Box>
    </Box>
  );
}
