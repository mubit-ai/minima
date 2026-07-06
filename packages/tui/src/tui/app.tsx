/**
 * HarnessApp — the interactive Ink shell.
 *
 * A focused port of the Python harness's tui/app.py: renders the conversation (user prompts,
 * streamed assistant replies, terse tool lines) plus a status bar, and drives the
 * MinimaAgent. Ctrl+C quits; Esc aborts the in-flight run. (The Python app's overlays,
 * diff approval, mouse capture, sessions, and themes land in later passes.)
 */

import { Box, Static, Text, useApp, useInput } from "ink";
import React, { useEffect, useState, useRef, useCallback } from "react";
import type { AgentEvent } from "../agent/events.ts";
import { PROVIDERS, envVarsForProvider, providerKeyPresent } from "../ai/provider_catalog.ts";
import { allModels } from "../ai/registry.ts";
import type { Model } from "../ai/types.ts";
import { Message as AgentMessage, AssistantMessage } from "../ai/types.ts";
import { metricsReport } from "../db/metrics.ts";
import { applyRehydratedRun, rehydrateRun } from "../db/rehydrate.ts";
import { errText } from "../errtext.ts";
import { BudgetLedger, type BudgetStatus } from "../minima/budget.ts";
import { refreshCatalog, refreshCatalogOnce } from "../minima/catalog.ts";
import type { MinimaAgent } from "../minima/runtime.ts";
import type { ChildEvent } from "../minima/spawn.ts";
import { SessionManager, SessionStore, type SessionSummary, formatAge } from "../session/store.ts";
import { expandAtFiles } from "../tools/at_mentions.ts";
import type { AskUserRef, QuestionOption } from "../tools/question.ts";
import { DEFAULT_CONSOLE_URL, ProvisioningPending, runAuth } from "./auth.ts";
import { BusyIndicator } from "./busy.tsx";
import { type ChildRow, ChildTree } from "./child_tree.tsx";
import { compactMessages, maybeAutoCompact } from "./compact.ts";
import { SECTIONS, mask, get as storeGet, setValue as storeSetValue } from "./config_store.ts";
import { getScrollableMessages, streamTailBudget, tailToFit, wrappedLineCount } from "./layout.ts";
import { type ChatMessage, MessageRow, StreamingReply, StreamingThoughts } from "./messages.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { setMouseScrollCallback } from "./mouse-scroll.ts";
import {
  type PermissionPrompt,
  type PermissionState,
  checkPermission,
  createPermissionState,
} from "./permissions.ts";
import { repoIdentity, setProject } from "./projects.ts";
import { routingInfoWarnings } from "./routing-warnings.ts";
import { StatusBar } from "./status.tsx";
import { TextInput } from "./text-input.tsx";
import { advance as advanceTip, formatTip, isTipsEnabled, setTipsEnabled } from "./tips.ts";

export interface AppProps {
  agent: MinimaAgent;
  banner?: string;
  /** Late-bound slot the `question` tool reads; populated here once the overlay is wired. */
  askUserRef?: AskUserRef;
  /** Mutable ref written by main.ts so HarnessApp can receive sub-agent events. */
  childEventRef?: { handler: ((e: ChildEvent) => void) | null };
  /**
   * Fullscreen renderer (default): alternate screen, full-height frame, prompt glued to the bottom
   * row, history scrolled in-app (PgUp/PgDn + optional wheel). When false, the inline renderer is
   * used (main buffer + <Static> + native OS scroll). Set by main.ts from the CLI flag/env.
   */
  fullscreen?: boolean;
}

/** True when at least one key-requiring model provider has its key set. */
function anyProviderKeyPresent(): boolean {
  return PROVIDERS.some((p) => p.requiresKey && providerKeyPresent(p.name));
}

/** Suggested `/config set` hint for a provider (or a generic one). */
function keyHint(provider?: string): string {
  const env = provider ? envVarsForProvider(provider)[0] : undefined;
  return env ? `\`/config set ${env} <key>\`` : "a model-provider key via /config";
}

/**
 * Append actionable guidance to an auth-shaped error so a user who ran `/auth` (routing only)
 * knows to set a MODEL-provider key. Leaves already-actionable messages (our own "config set"
 * text) untouched.
 */
function actionableError(msg: string, provider?: string): string {
  const authish =
    /could not resolve authentication|api[\s_-]?key|authtoken|unauthor|x-api-key|http 401|no api key/i.test(
      msg,
    );
  if (!authish || /config set/i.test(msg)) return msg;
  return `${msg}\n→ Set a model-provider key: ${keyHint(provider)} (\`/auth\` configures routing only), then /reconnect.`;
}

const GLYPHS: Record<string, string[]> = {
  M: ["███╗   ███╗", "████╗ ████║", "██╔████╔██║", "██║╚██╔╝██║", "██║ ╚═╝ ██║", "╚═╝     ╚═╝"],
  I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
};

function getAsciiBanner(word: string): string {
  const rows: string[] = [];
  for (let r = 0; r < 6; r++) {
    const chars: string[] = [];
    for (const ch of word) {
      const glyph = GLYPHS[ch];
      if (glyph) {
        chars.push(glyph[r] || "");
      }
    }
    rows.push(chars.join(" "));
  }
  return rows.join("\n");
}

function getLastAssistant(agent: MinimaAgent): AssistantMessage | null {
  const msgs = agent.agentState.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m instanceof AssistantMessage) {
      return m;
    }
  }
  return null;
}

const COMMANDS = [
  { name: "model", desc: "Select or pin a model (or 'auto')" },
  { name: "clear", desc: "Clear chat messages" },
  { name: "auth", desc: "Sign in to Mubit & provision this repo's project" },
  { name: "config", desc: "Show/set API keys (MUBIT, GEMINI, ANTHROPIC, etc.)" },
  { name: "help", desc: "Show available commands list" },
  { name: "quit", desc: "Exit the application" },
  { name: "exit", desc: "Exit the application" },
  { name: "cost", desc: "Show cost meter totals" },
  { name: "budget", desc: "Show/set the session budget (set <usd> · mode warn|enforce)" },
  { name: "reconnect", desc: "Reconnect routing client" },
  { name: "new", desc: "Start a fresh session" },
  { name: "name", desc: "Set the session display name" },
  { name: "session", desc: "Show session info" },
  { name: "tree", desc: "Toggle the sub-agent tree panel" },
  { name: "mouse", desc: "Toggle mouse-wheel scroll (fullscreen; disables text select)" },
  { name: "fork", desc: "Fork a session (not implemented yet)" },
  { name: "clone", desc: "Clone a session (not implemented yet)" },
  { name: "resume", desc: "Resume a session (optionally by id)" },
  { name: "judge", desc: "Toggle LLM judging on/off" },
  { name: "thoughts", desc: "Toggle streaming model's reasoning" },
  { name: "perms", desc: "Show current tool permission grants" },
  { name: "undo", desc: "Undo last AI change (git checkout)" },
  { name: "compact", desc: "Summarize old turns to free context" },
  { name: "plan", desc: "Toggle plan mode (read-only)" },
  { name: "tip", desc: "Show a tip (or /tip on|off to toggle startup tips)" },
];

export interface CommandPickerProps {
  commands: { name: string; desc: string }[];
  onPick: (commandName: string) => void;
  onDismiss: () => void;
}

export function CommandPicker({ commands, onPick, onDismiss }: CommandPickerProps) {
  const [cursor, setCursor] = useState(0);
  const [closed, setClosed] = useState(false);

  const safePick = (name: string) => {
    if (closed) return;
    setClosed(true);
    onPick(name);
  };
  const safeDismiss = () => {
    if (closed) return;
    setClosed(true);
    onDismiss();
  };

  useInput((input, key) => {
    if (key.escape) return safeDismiss();
    if (commands.length === 0) return;
    if (key.upArrow) return setCursor((c) => (c - 1 + commands.length) % commands.length);
    if (key.downArrow) return setCursor((c) => (c + 1) % commands.length);
    if (key.return) return safePick(commands[cursor]!.name);
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= commands.length)
      return safePick(commands[n - 1]!.name);
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} borderColor="magenta" width="100%">
      <Box position="absolute" marginTop={-1} marginLeft={2}>
        <Text color="magenta"> palette </Text>
      </Box>
      {commands.map((c, i) => (
        <Text key={c.name} color={i === cursor ? "cyan" : undefined}>
          {i === cursor ? "❯" : " "} {i < 9 ? `${i + 1} ` : "  "}
          <Text bold color="yellow">
            /{c.name.padEnd(12)}
          </Text>
          <Text color="gray">{c.desc}</Text>
        </Text>
      ))}
      <Text color="gray">{"↑/↓ select · ⏎ run · Esc cancel"}</Text>
    </Box>
  );
}

export interface SessionPickerProps {
  sessions: SessionSummary[];
  onPick: (sessionPath: string) => void;
  onDismiss: () => void;
}

export function SessionPicker({ sessions, onPick, onDismiss }: SessionPickerProps) {
  const [cursor, setCursor] = useState(0);
  // Latch so a fast double-Enter can't resolve twice (duplicate loadRun / "Resumed" messages).
  const [closed, setClosed] = useState(false);
  const pick = (path: string) => {
    if (closed) return;
    setClosed(true);
    onPick(path);
  };

  useInput((input, key) => {
    if (closed) return;
    if (key.escape) {
      setClosed(true);
      return onDismiss();
    }
    if (sessions.length === 0) return;
    if (key.upArrow) return setCursor((c) => (c - 1 + sessions.length) % sessions.length);
    if (key.downArrow) return setCursor((c) => (c + 1) % sessions.length);
    if (key.return) return pick(sessions[cursor]!.path);
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= sessions.length) return pick(sessions[n - 1]!.path);
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} borderColor="magenta" width="100%">
      <Box position="absolute" marginTop={-1} marginLeft={2}>
        <Text color="magenta"> sessions </Text>
      </Box>
      {sessions.length === 0 ? (
        <Text color="gray">No previous sessions found.</Text>
      ) : (
        sessions.slice(0, 15).map((s, i) => {
          const ageCreated = formatAge(s.created);
          const ageUpdated = formatAge(s.mtime);
          const label = s.displayName || s.sessionId;
          return (
            <Text key={s.path} color={i === cursor ? "cyan" : undefined}>
              {i === cursor ? "❯" : " "} {i < 9 ? `${i + 1} ` : "  "}
              <Text bold color="yellow">
                {label.padEnd(16)}
              </Text>
              <Text color="gray">
                {` · ${s.nEntries} entries · created ${ageCreated} · updated ${ageUpdated}`}
              </Text>
            </Text>
          );
        })
      )}
      <Text color="gray">{"↑/↓ select · ⏎ resume · Esc cancel"}</Text>
    </Box>
  );
}

export function PermissionOverlay({ prompt }: { prompt: PermissionPrompt }) {
  const isReadTool = prompt.toolName === "read" || prompt.toolName === "ls";

  useInput((input, key) => {
    if (input === "y" || input === "Y" || key.return) {
      prompt.resolve("allow");
    } else if (input === "a" || input === "A") {
      prompt.resolve("always");
    } else if (input === "n" || input === "N" || key.escape) {
      prompt.resolve("deny");
    }
  });

  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column" width="100%">
      <Box position="absolute" marginTop={-1} marginLeft={2}>
        <Text color="yellow" bold>
          {" permission "}
        </Text>
      </Box>
      <Box flexDirection="column">
        <Text>
          <Text color="yellow" bold>
            {prompt.toolName === "read" ||
            prompt.toolName === "ls" ||
            prompt.toolName === "glob" ||
            prompt.toolName === "grep"
              ? "READ"
              : prompt.toolName === "write"
                ? "WRITE (new file)"
                : prompt.toolName === "edit"
                  ? "EDIT (modify file)"
                  : prompt.toolName === "bash"
                    ? "RUN COMMAND"
                    : prompt.toolName.toUpperCase()}
          </Text>
          <Text color="white"> {prompt.promptText}</Text>
        </Text>
        {prompt.argsSummary && !prompt.diffPreview ? (
          <Text color="gray"> target: {prompt.argsSummary.slice(0, 80)}</Text>
        ) : null}
      </Box>
      {prompt.diffPreview ? (
        <Box flexDirection="column" marginTop={0}>
          {prompt.diffPreview
            .split("\n")
            .slice(0, 12)
            .map((line) => (
              <Text
                key={line.slice(0, 40)}
                color={line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : "gray"}
              >
                {line}
              </Text>
            ))}
        </Box>
      ) : null}
      <Text color="gray">
        {isReadTool
          ? "[y] Yes once · [a] Always for this directory · [n] Reject"
          : "[y] Yes once · [a] Always allow this tool · [n] Reject"}
      </Text>
    </Box>
  );
}

export interface QuestionPromptData {
  question: string;
  header: string;
  options: QuestionOption[];
  allow_freetext: boolean;
  resolve: (answer: string | null) => void;
}

/** Overlay for the `question` tool: pick an option, type a custom answer, or dismiss (Esc). */
export function QuestionOverlay({ prompt }: { prompt: QuestionPromptData }) {
  const optionCount = prompt.options.length;
  const rowCount = optionCount + (prompt.allow_freetext ? 1 : 0);
  const [cursor, setCursor] = useState(0);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");

  useInput((input, key) => {
    if (typing) {
      if (key.return) {
        const v = draft.trim();
        if (v) prompt.resolve(v);
        return;
      }
      if (key.escape) {
        setTyping(false);
        setDraft("");
        return;
      }
      if (key.backspace || key.delete) {
        setDraft((v) => v.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input) setDraft((v) => v + input);
      return;
    }
    if (key.escape) {
      prompt.resolve(null);
      return;
    }
    if (input === "t" && prompt.allow_freetext) {
      setTyping(true);
      return;
    }
    if (key.upArrow) {
      setCursor((c) => (c - 1 + rowCount) % rowCount);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % rowCount);
      return;
    }
    if (key.return) {
      if (prompt.allow_freetext && cursor === optionCount) {
        setTyping(true);
        return;
      }
      const opt = prompt.options[cursor];
      if (opt) prompt.resolve(opt.label);
    }
  });

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column" width="100%">
      <Box position="absolute" marginTop={-1} marginLeft={2}>
        <Text color="cyan" bold>
          {prompt.header ? ` ${prompt.header} ` : " question "}
        </Text>
      </Box>
      <Text color="white" bold>
        {prompt.question}
      </Text>
      {typing ? (
        <Box marginTop={0}>
          <Text color="gray">{"› "}</Text>
          <Text color="white">{draft}</Text>
          <Text color="gray">{"▋"}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={0}>
          {prompt.options.map((opt, i) => (
            <Text key={opt.label} color={i === cursor ? "cyan" : "white"}>
              {i === cursor ? "› " : "  "}
              {opt.label}
              {opt.description ? <Text color="gray"> — {opt.description}</Text> : null}
            </Text>
          ))}
          {prompt.allow_freetext ? (
            <Text color={cursor === optionCount ? "cyan" : "gray"}>
              {cursor === optionCount ? "› " : "  "}✎ Other (type a custom answer)
            </Text>
          ) : null}
        </Box>
      )}
      <Text color="gray">
        {typing
          ? "⏎ submit · Esc cancel"
          : `↑↓ select · ⏎ confirm${prompt.allow_freetext ? " · t type" : ""} · Esc dismiss`}
      </Text>
    </Box>
  );
}

export interface ConfigOverlayProps {
  onDismiss: () => void;
}

const ALL_CONFIG_FIELDS = SECTIONS.flatMap((s) => s.fields);

export function ConfigOverlay({ onDismiss }: ConfigOverlayProps) {
  const allFields = ALL_CONFIG_FIELDS;
  const [cursor, setCursor] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [_loaded, setLoaded] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const vals: Record<string, string> = {};
      for (const f of ALL_CONFIG_FIELDS) {
        const v = process.env[f.key] ?? "";
        vals[f.key] = v;
      }
      setValues(vals);
      setLoaded(true);
    })();
  }, []);

  useInput((input, key) => {
    if (savedMsg) {
      setSavedMsg(null);
      return;
    }
    if (editing) {
      if (key.return) {
        const field = allFields[cursor]!;
        const val = editValue.trim();
        setValues((prev) => ({ ...prev, [field.key]: val }));
        process.env[field.key] = val;
        storeSetValue(field.key, val).catch(() => {});
        setEditing(false);
        setEditValue("");
        setSavedMsg(`${field.key} saved ✓`);
        return;
      }
      if (key.escape) {
        setEditing(false);
        setEditValue("");
        return;
      }
      if (key.backspace || key.delete) {
        setEditValue((v) => v.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input && !key.escape) {
        setEditValue((v) => v + input);
      }
      return;
    }
    if (key.escape) return onDismiss();
    if (key.upArrow) return setCursor((c) => (c - 1 + allFields.length) % allFields.length);
    if (key.downArrow) return setCursor((c) => (c + 1) % allFields.length);
    if (key.return) {
      const field = allFields[cursor]!;
      setEditValue(values[field.key] ?? "");
      setEditing(true);
    }
  });

  const field = allFields[cursor];

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} borderColor="cyan" width="100%">
      <Box position="absolute" marginTop={-1} marginLeft={2}>
        <Text color="cyan" bold>
          {" config "}
        </Text>
      </Box>
      {SECTIONS.map((section) => (
        <Box key={section.title} flexDirection="column">
          <Text color="gray" bold>
            {section.title}
          </Text>
          {section.fields.map((f) => {
            const idx = allFields.indexOf(f);
            const isActive = idx === cursor;
            const val = values[f.key] ?? "";
            // Always mask secrets in the list — never reveal a full key just because the cursor
            // landed on its row. (Editing uses a separate, also-masked buffer.)
            const shown = f.secret ? mask(val) : val;
            return (
              <Text key={f.key} color={isActive ? "cyan" : undefined}>
                {isActive ? "❯" : " "} {f.key.padEnd(20)}
                <Text color={val ? "green" : "gray"}>{shown || "(not set)"}</Text>
              </Text>
            );
          })}
        </Box>
      ))}
      {editing && field ? (
        <Box marginTop={1}>
          <Text color="yellow" bold>
            {field.key}:{" "}
          </Text>
          <Text color="white">{field.secret ? editValue.replace(/./g, "*") : editValue}</Text>
          <Text color="gray">{"▋"}</Text>
        </Box>
      ) : null}
      <Text color="gray">
        {savedMsg ?? (editing ? "⏎ save · Esc cancel" : "↑/↓ navigate · ⏎ edit · Esc close")}
      </Text>
    </Box>
  );
}

export function HarnessApp({
  agent,
  banner: _banner,
  askUserRef,
  childEventRef,
  fullscreen = true,
}: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Bumped whenever `messages` is REPLACED wholesale (clear / new / resume / load-session) rather
  // than appended to. It keys the <Static> transcript so it remounts and reprints from scratch
  // instead of trying to append onto a now-different list (Static is otherwise append-only).
  const [transcriptGen, setTranscriptGen] = useState(0);
  const [streaming, setStreaming] = useState("");
  const [streamingThoughts, setStreamingThoughts] = useState("");
  const streamingBufRef = useRef("");
  const streamingThoughtsBufRef = useRef("");
  const streamFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thoughtsFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyState, setBusyState] = useState<"ready" | "reasoning" | "running">("ready");
  const [actualCost, setActualCost] = useState<number>();
  const [quitArmed, setQuitArmed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [sessionsList, setSessionsList] = useState<SessionSummary[]>([]);
  const [configOverlayOpen, setConfigOverlayOpen] = useState(false);
  // Re-render trigger after a catalog refresh so the /model picker (which reads allModels()
  // at render) reflects newly-registered models even if it's already open.
  const [, setCatalogVersion] = useState(0);
  const [budgetStatus, setBudgetStatus] = useState<BudgetStatus | null>(null);
  // Startup tips (ON by default): a rotating tip shown on the empty welcome splash. `/tip on|off`
  // toggles the persisted preference; `startupTip` holds the tip rendered this launch.
  const [tipsEnabled, setTipsEnabledState] = useState(isTipsEnabled());
  const [startupTip, setStartupTip] = useState<string | null>(null);

  // Sub-agent tree: childrenState tracks each in-flight child; treeOpen toggles the panel.
  const [childrenState, setChildrenState] = useState<Map<string, ChildRow>>(new Map());
  const [treeOpen, setTreeOpen] = useState(false);

  // On mount: nudge if routing is set but no model-provider key is, and pull the live model
  // catalog (Minima /v1/models + OpenRouter) so /model reflects runnable models, not just seeds.
  useEffect(() => {
    // Rotate a fresh startup tip for the welcome splash (ON by default; persisted preference).
    if (isTipsEnabled()) setStartupTip(formatTip(advanceTip()));
    if (!anyProviderKeyPresent()) {
      setMessages((m) => [
        ...m,
        {
          role: "tool",
          toolName: "setup",
          text: `No model-provider API key set — set one to run models: ${keyHint("anthropic")} (or OPENAI/GOOGLE/OPENROUTER). \`/auth\` configures routing only.`,
        },
      ]);
    }
    // One-time bootstrap (memoized): the REGISTRY is process-global, so the catalog must
    // not be re-synced mid-run once (sub-)agents can be in flight.
    void refreshCatalogOnce(agent.config)
      .then((n) => {
        if (n > 0) setCatalogVersion((v) => v + 1);
      })
      .catch(() => {});
    // Budget signals render as chat notices (not stderr — that would corrupt Ink).
    agent.budget?.setOnEvent((e) => {
      if (e.kind === "threshold" || e.kind === "deny") {
        setMessages((m) => [
          ...m,
          {
            role: "tool",
            text: `${e.kind === "deny" ? "⛔" : "💰"} ${e.note ?? e.kind}`,
            toolName: "budget",
            isError: e.kind === "deny",
          },
        ]);
      }
      setBudgetStatus(agent.budget?.status() ?? null);
    });
    setBudgetStatus(agent.budget?.status() ?? null);
  }, [agent]);

  // Wire the sub-agent event feed so ChildTree stays live during multi-step runs.
  useEffect(() => {
    if (!childEventRef) return;
    childEventRef.handler = (e: ChildEvent) => {
      setChildrenState((prev) => {
        const next = new Map(prev);
        const existing = next.get(e.childId);
        // Determine status from the incoming AgentEvent kind.
        const kind = (e.event as { kind?: string }).kind ?? "";
        const isDone = kind === "run_complete" || kind === "error";
        const isAborted = kind === "aborted";
        const status: ChildRow["status"] = isAborted
          ? "aborted"
          : isDone
            ? "success" === (e.event as { outcome?: string }).outcome
              ? "done"
              : "failure"
            : "running";
        const costUsd =
          (e.event as { cost?: { total?: number } }).cost?.total ?? existing?.costUsd ?? 0;
        next.set(e.childId, { stepId: e.stepId, depth: e.depth, status, costUsd });
        return next;
      });
    };
    return () => {
      childEventRef.handler = null;
    };
  }, [childEventRef]);

  // Permission system
  const [permPrompt, setPermPrompt] = useState<PermissionPrompt | null>(null);
  const permStateRef = useRef<PermissionState>(createPermissionState(process.cwd()));

  // `question` tool overlay: the tool awaits a promise resolved by the overlay below.
  const [questionPrompt, setQuestionPrompt] = useState<QuestionPromptData | null>(null);
  useEffect(() => {
    if (!askUserRef) return;
    askUserRef.current = (params) =>
      new Promise<string | null>((resolve) => {
        setQuestionPrompt({ ...params, resolve });
      });
    return () => {
      askUserRef.current = null;
    };
  }, [askUserRef]);

  // Plan mode: read-only (blocks write/edit/bash)
  const [planMode, setPlanMode] = useState(false);
  const planModeRef = useRef(false);
  useEffect(() => {
    planModeRef.current = planMode;
  }, [planMode]);

  // Terminal sizing (rows/cols).
  const [rows, setRows] = useState(process.stdout.rows || 24);
  const [cols, setCols] = useState(process.stdout.columns || 80);

  // Fullscreen scroll state: 0 = pinned to the newest line (bottom); positive = scrolled up N
  // rows. Only used in fullscreen mode; inline mode uses the terminal's native scrollback.
  const [scrollOffset, setScrollOffset] = useState(0);
  const atBottomRef = useRef(true);
  const maxChatHeightRef = useRef(1);
  // Mouse-wheel scroll (fullscreen only), toggled by /mouse. OFF by default so native click-drag
  // text selection works; ON captures the wheel for in-app scroll (disabling native selection).
  const [mouseEnabled, setMouseEnabled] = useState(false);

  useEffect(() => {
    const handleResize = () => {
      setRows(process.stdout.rows || 24);
      setCols(process.stdout.columns || 80);
    };
    process.stdout.on("resize", handleResize);

    if (fullscreen) {
      // Wheel notches (decoded by installMouseScrollFilter in main.ts) adjust the scroll offset.
      setMouseScrollCallback((dir) =>
        setScrollOffset((p) => (dir === "up" ? p + 3 : Math.max(0, p - 3))),
      );
    } else {
      // Inline: mouse tracking stays OFF so native scroll/select/copy work with <Static>.
      process.stdout.write("\u001b[?1000l");
      process.stdout.write("\u001b[?1006l");
    }

    return () => {
      process.stdout.off("resize", handleResize);
      setMouseScrollCallback(null);
      process.stdout.write("\u001b[?1006l");
      process.stdout.write("\u001b[?1000l");
    };
  }, [fullscreen]);

  // Toggle SGR mouse reporting as the user flips /mouse (fullscreen only). ON = wheel scroll
  // (native selection disabled); OFF = native selection restored.
  useEffect(() => {
    if (!fullscreen) return;
    if (mouseEnabled) {
      process.stdout.write("\u001b[?1000h");
      process.stdout.write("\u001b[?1006h");
    } else {
      process.stdout.write("\u001b[?1006l");
      process.stdout.write("\u001b[?1000l");
    }
  }, [fullscreen, mouseEnabled]);

  // Follow the newest content only when already pinned at the bottom (fullscreen). The message/
  // stream deps are intentional triggers (re-run when new content arrives), not values read here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the follow-on-new-content triggers
  useEffect(() => {
    if (fullscreen && atBottomRef.current) setScrollOffset(0);
  }, [messages.length, streaming, streamingThoughts, fullscreen]);

  // Wire the beforeToolCall permission hook.
  // Sensitive tools (write/edit/bash) always prompt; read/ls auto-allow within cwd.
  useEffect(() => {
    agent.setBeforeToolCall(async (ctx) => {
      if (planModeRef.current) {
        const blocked = ["write", "edit", "bash"];
        if (blocked.includes(ctx.toolCall.name)) {
          return {
            block: true,
            reason: "Plan mode is ON — write/edit/bash are blocked. Use /plan to exit.",
          };
        }
      }
      const result = await checkPermission(
        ctx.toolCall.name,
        ctx.args,
        permStateRef.current,
        (prompt) => setPermPrompt(prompt),
      );
      return result;
    });
  }, [agent]);

  // Scrolling is handled by the terminal itself (the finalized transcript renders into native
  // scrollback via <Static>), so there is no in-app scroll offset to track.

  // Status Bar states
  const [basis, setBasis] = useState<string>(agent.config.pinned ? "pinned" : "minima");
  const [routeMode, setRouteMode] = useState<"auto" | "confirm">("auto");
  const [thinkingLevel, setThinkingLevel] = useState<string>(agent.agentState.thinkingLevel);
  const [ctxPct, setCtxPct] = useState(0);
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);

  // Input history states
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  // The in-progress line stashed when the user first presses Up into history, restored on the way back.
  const draftRef = useRef("");

  // Command auto-complete & typed text
  const [typedText, setTypedText] = useState("");

  const hasSpace = typedText.includes(" ");
  const MAX_SUGGESTIONS = 8;
  const allMatchingCommands =
    typedText.startsWith("/") && !hasSpace
      ? COMMANDS.filter((c) => c.name.startsWith(typedText.slice(1).trim().toLowerCase()))
      : [];
  // Cap the inline suggestions so a bare "/" (which matches ALL commands) can't inflate the
  // reserved height past a short terminal and shove the input/status off-screen.
  const matchingCommands = allMatchingCommands.slice(0, MAX_SUGGESTIONS);
  const hiddenSuggestions = allMatchingCommands.length - matchingCommands.length;

  const [showThinking, setShowThinking] = useState(false);
  const showThinkingRef = useRef(showThinking);
  useEffect(() => {
    showThinkingRef.current = showThinking;
  }, [showThinking]);

  const thoughtsRef = useRef("");
  const thinkingStartRef = useRef<number | null>(null);

  // Subscribe to the agent event stream once.
  useEffect(() => {
    const unsub = agent.subscribe((ev: AgentEvent) => {
      switch (ev.type) {
        case "message_start":
          if (ev.message?.role === "user") {
            setMessages((m) => [...m, { role: "user", text: ev.message!.textContent }]);
          }
          break;
        case "message_update": {
          const s = ev.assistantMessageEvent;
          if (s?.type === "thinking_start") {
            thinkingStartRef.current = Date.now();
            setBusyState("reasoning");
            streamingThoughtsBufRef.current = "";
          } else if (s?.type === "thinking_delta") {
            thoughtsRef.current += s.delta;
            streamingThoughtsBufRef.current += s.delta;
            if (!thoughtsFlushRef.current) {
              thoughtsFlushRef.current = setTimeout(() => {
                setStreamingThoughts(streamingThoughtsBufRef.current);
                thoughtsFlushRef.current = null;
              }, 80);
            }
          } else if (s?.type === "text_delta") {
            setBusyState("running");
            streamingBufRef.current += s.delta;
            if (!streamFlushRef.current) {
              streamFlushRef.current = setTimeout(() => {
                setStreaming(streamingBufRef.current);
                streamFlushRef.current = null;
              }, 80);
            }
          }
          break;
        }
        case "message_end":
          if (ev.message && ev.message.role === "assistant") {
            const assistantMsg = ev.message as AssistantMessage;
            const text = assistantMsg.textContent.trim();
            const isErr = assistantMsg.stop_reason === "error";
            const errMsg = assistantMsg.error_message;
            const elapsed = thinkingStartRef.current
              ? (Date.now() - thinkingStartRef.current) / 1000
              : 0;
            const accumulatedThoughts = thoughtsRef.current.trim();
            if (showThinkingRef.current && accumulatedThoughts) {
              setMessages((m) => [
                ...m,
                {
                  role: "thinking",
                  text: accumulatedThoughts,
                  thoughtDurationSecs: elapsed,
                },
              ]);
            }
            if (isErr) {
              // A hard provider failure — render RED (role tool + isError) and, when it's an
              // auth error, append actionable guidance naming the provider key to set.
              const provider = agent.agentState.model?.provider;
              setMessages((m) => [
                ...m,
                {
                  role: "tool",
                  toolName: "error",
                  text: `⚠ ${actionableError(errMsg || "provider error (no response)", provider)}`,
                  isError: true,
                },
              ]);
            } else if (text) {
              setMessages((m) => [...m, { role: "assistant", text }]);
            }
            setStreaming("");
            setStreamingThoughts("");
            streamingBufRef.current = "";
            streamingThoughtsBufRef.current = "";
            if (streamFlushRef.current) {
              clearTimeout(streamFlushRef.current);
              streamFlushRef.current = null;
            }
            if (thoughtsFlushRef.current) {
              clearTimeout(thoughtsFlushRef.current);
              thoughtsFlushRef.current = null;
            }
            thoughtsRef.current = "";
            thinkingStartRef.current = null;
          } else if (ev.message?.role === "toolResult") {
            setMessages((m) => [
              ...m,
              {
                role: "tool",
                text: ev.message!.textContent,
                toolName: ev.message!.tool_name,
                isError: ev.message!.is_error,
              },
            ]);
          }
          break;
        case "tool_execution_start":
          setBusyState("running");
          break;
      }
    });
    return unsub;
  }, [agent]);

  // Global keybindings: Ctrl+C quits (double-tap), Esc aborts, Ctrl+L opens the model picker.
  useInput((input, key) => {
    if (
      pickerOpen ||
      paletteOpen ||
      sessionPickerOpen ||
      permPrompt ||
      questionPrompt ||
      configOverlayOpen
    )
      return;

    // Abort a running turn. MUST be handled before the busy-guard below — otherwise these are
    // dead code and the advertised "esc to abort" does nothing. (Ctrl+C is also intercepted by
    // Ink unless exitOnCtrlC:false is passed to render — see main.ts.)
    if (busy && (key.escape || (key.ctrl && input === "c"))) {
      agent.abort();
      return;
    }

    // Fullscreen: scroll the in-app history viewport (allowed mid-run, so you can read back while a
    // reply streams). Inline mode leaves scrolling to the terminal's native scrollback.
    if (fullscreen) {
      const page = Math.max(1, maxChatHeightRef.current - 2);
      if (key.pageUp) {
        setScrollOffset((p) => p + page);
        return;
      }
      if (key.pageDown) {
        setScrollOffset((p) => Math.max(0, p - page));
        return;
      }
    }

    // Everything below opens an overlay / changes mode — not allowed mid-run.
    if (busy) return;

    if (key.ctrl && input === "l") {
      setPickerOpen(true);
      return;
    }
    if (key.ctrl && input === "p") {
      setPaletteOpen(true);
      return;
    }
    if (key.ctrl && input === "r") {
      setRouteMode((m) => (m === "auto" ? "confirm" : "auto"));
      return;
    }
    if (key.ctrl && input === "c") {
      if (quitArmed) exit();
      else {
        setQuitArmed(true);
        setTimeout(() => setQuitArmed(false), 1500);
      }
      return;
    }
  });

  function pickModel(model: Model, pinned: boolean) {
    agent.agentState.model = model;
    if (pinned) {
      agent.config.pinned = true;
      agent.config.candidates = [model.id];
      setBasis("pinned");
    } else {
      agent.config.pinned = false;
      setBasis("minima");
    }
    setPickerOpen(false);
  }

  function handleTabComplete(val: string): string | undefined {
    if (!val.startsWith("/")) return undefined;
    const hasSpace = val.includes(" ");
    if (hasSpace) return undefined;

    const prefix = val.slice(1).toLowerCase();
    const matches = COMMANDS.filter((c) => c.name.startsWith(prefix));

    if (matches.length > 0) {
      return `/${matches[0]!.name} `;
    }
    return undefined;
  }

  function cycleThinkingLevel() {
    const levels = ["off", "low", "medium", "high"];
    const cur = agent.agentState.thinkingLevel;
    const nxt = levels[(levels.indexOf(cur) + 1) % levels.length] || "low";
    agent.agentState.thinkingLevel = nxt as any;
    setThinkingLevel(nxt);
  }

  function handleHistoryUp(current: string): string | undefined {
    let nextIdx = historyIdx;
    if (nextIdx === null) {
      if (history.length === 0) return undefined;
      draftRef.current = current; // stash the in-progress draft before entering history
      nextIdx = history.length - 1;
    } else if (nextIdx > 0) {
      nextIdx = nextIdx - 1;
    } else {
      return undefined;
    }
    setHistoryIdx(nextIdx);
    return history[nextIdx];
  }

  function handleHistoryDown(): string | undefined {
    if (historyIdx === null) return undefined;
    const nextIdx = historyIdx + 1;
    if (nextIdx >= history.length) {
      setHistoryIdx(null);
      return draftRef.current; // restore the stashed draft, not an empty line
    }
    setHistoryIdx(nextIdx);
    return history[nextIdx];
  }

  /** Resume a DB-persisted run: restore context + cost footer + judge cadence, and record
   * lineage (the CURRENT run continues from the resumed one — new rows keep landing under
   * the current run_id; rec_ids are never duplicated). */
  async function loadRun(runId: string) {
    if (!agent.db) throw new Error("no run store");
    const r = rehydrateRun(agent.db, runId);
    applyRehydratedRun(agent, r);
    if (agent.runId) {
      try {
        agent.db.setRunParent(agent.runId, runId);
      } catch {
        // lineage is best-effort
      }
    }
    const chat: ChatMessage[] = [];
    for (const m of r.messages) {
      if (m.role === "user") chat.push({ role: "user", text: m.textContent });
      else if (m.role === "assistant") chat.push({ role: "assistant", text: m.textContent });
      else if (m.role === "toolResult")
        chat.push({
          role: "tool",
          text: m.textContent,
          toolName: (m as AgentMessage & { tool_name?: string }).tool_name ?? "tool",
          isError: (m as AgentMessage & { is_error?: boolean }).is_error ?? false,
        });
    }
    const totals = agent.meter?.totals();
    if (totals) setActualCost(totals.actualCostUsd);
    const label = r.run.display_name || runId.slice(0, 12);
    setTranscriptGen((g) => g + 1);
    setMessages([
      ...chat,
      {
        role: "tool",
        text: `Resumed run ${label} (${r.messages.length} msg(s), ${r.meterRows.length} routed prompt(s), $${(totals?.actualCostUsd ?? 0).toFixed(4)} recorded)`,
        toolName: "resume",
      },
    ]);
  }

  async function loadSession(store: SessionStore) {
    const list: ChatMessage[] = [];
    const agentMsgs: AgentMessage[] = [];

    for (const entry of store.entries) {
      const text = (entry.payload.text as string) || "";
      if (entry.type === "user") {
        list.push({ role: "user", text });
        agentMsgs.push(new AgentMessage({ role: "user", content: text }));
      } else if (entry.type === "assistant") {
        list.push({ role: "assistant", text });
        agentMsgs.push(new AssistantMessage({ content: text }));
      } else if (entry.type === "tool") {
        list.push({
          role: "tool",
          text,
          toolName: (entry.payload.tool_name as string) || "tool",
          isError: (entry.payload.is_error as boolean) || false,
        });
        agentMsgs.push(
          new AgentMessage({
            role: "toolResult",
            content: text,
            tool_name: (entry.payload.tool_name as string) || "tool",
            is_error: (entry.payload.is_error as boolean) || false,
          }),
        );
      }
    }

    setTranscriptGen((g) => g + 1);
    setMessages(list);
    agent.agentState.messages = agentMsgs;

    const label = store.displayName || "latest";
    setMessages((m) => [
      ...m,
      {
        role: "tool",
        text: `Resumed session ${label} (${agentMsgs.length} msg(s) in context)`,
        toolName: "resume",
      },
    ]);
  }

  async function handleCommand(name: string, args: string) {
    const cmdName = name.trim().toLowerCase();
    switch (cmdName) {
      case "clear":
        setTranscriptGen((g) => g + 1);
        setMessages([]);
        break;
      case "perms": {
        const ps = permStateRef.current;
        const dirs = [...ps.allowedDirs].map((d) => d.replace(ps.cwd, ".")).sort();
        const always = [...ps.allowAlways].sort();
        const lines: string[] = ["Permission state:", ""];
        lines.push("  Read/LS directories (auto-approved):");
        if (dirs.length) {
          for (const d of dirs) lines.push(`    dr-x------  ${d}`);
        } else {
          lines.push("    (none — will prompt on first access)");
        }
        lines.push("");
        lines.push("  Tool permissions:");
        for (const t of ["read", "ls", "glob", "grep", "write", "edit", "bash"]) {
          const isAlways = always.includes(t);
          const isRead = t === "read" || t === "ls" || t === "glob" || t === "grep";
          let perm: string;
          if (isAlways) perm = "--x------";
          else if (isRead) perm = "r-x------";
          else perm = "---x-----";
          const status = isAlways ? "✓ always" : isRead ? "(dir-scoped)" : "asks each time";
          lines.push(`    ${perm}  ${t.padEnd(8)} ${status}`);
        }
        lines.push("");
        lines.push(`  Plan mode: ${planMode ? "ON (read-only)" : "off"}`);
        setMessages((m) => [
          ...m,
          { role: "user", text: `/${name}` },
          { role: "tool", text: lines.join("\n"), toolName: "perms" },
        ]);
        break;
      }
      case "mouse": {
        if (!fullscreen) {
          setMessages((m) => [
            ...m,
            { role: "user", text: `/${name}` },
            {
              role: "tool",
              text: "Mouse-wheel scroll is a fullscreen-mode feature; this session is inline (the terminal's native scroll already works). Restart without --no-fullscreen / MINIMA_TUI_INLINE to use it.",
              toolName: "mouse",
            },
          ]);
          break;
        }
        const nextMouse = !mouseEnabled;
        setMouseEnabled(nextMouse);
        setMessages((m) => [
          ...m,
          { role: "user", text: `/${name}` },
          {
            role: "tool",
            text: nextMouse
              ? "Mouse-wheel scroll ON — the wheel now scrolls history; native click-drag text selection is disabled until you run /mouse again."
              : "Mouse-wheel scroll OFF — native click-drag text selection restored; scroll history with PgUp/PgDn.",
            toolName: "mouse",
          },
        ]);
        break;
      }
      case "undo": {
        try {
          const diff = Bun.spawnSync(["git", "diff", "--name-only", "HEAD"]);
          const changed = diff.stdout.toString().trim();
          if (!changed) {
            setMessages((m) => [
              ...m,
              { role: "tool", text: "Nothing to undo (no uncommitted changes)", toolName: "undo" },
            ]);
          } else {
            Bun.spawnSync(["git", "checkout", "--"]);
            setMessages((m) => [
              ...m,
              {
                role: "tool",
                text: `Reverted changes to:\n${changed}`,
                toolName: "undo",
              },
            ]);
          }
        } catch (exc) {
          setMessages((m) => [
            ...m,
            { role: "tool", text: `undo failed: ${errText(exc)}`, toolName: "undo", isError: true },
          ]);
        }
        break;
      }
      case "compact": {
        const before = agent.agentState.messages.length;
        agent.agentState.messages = compactMessages(agent, agent.agentState.messages);
        const after = agent.agentState.messages.length;
        setMessages((m) => [
          ...m,
          {
            role: "user",
            text: `/${name} ${args}`.trim(),
          },
          {
            role: "tool",
            text: `Context compacted: ${before} → ${after} messages`,
            toolName: "compact",
          },
        ]);
        break;
      }
      case "auth": {
        setMessages((m) => [
          ...m,
          { role: "user", text: "/auth" },
          { role: "tool", text: "Opening your browser to sign in to Mubit…", toolName: "auth" },
        ]);
        try {
          const cwd = process.cwd();
          const repo = repoIdentity(cwd);
          const consoleUrl = process.env.MUBIT_CONSOLE_URL?.trim() || DEFAULT_CONSOLE_URL;
          const result = await runAuth({
            repo,
            consoleUrl,
            onUrl: (u) =>
              setMessages((m) => [
                ...m,
                {
                  role: "tool",
                  text: `If the browser didn't open, visit:\n${u}`,
                  toolName: "auth",
                },
              ]),
          });
          await storeSetValue("MUBIT_API_KEY", result.mubitApiKey);
          process.env.MUBIT_API_KEY = result.mubitApiKey;
          if (result.minimaUrl) {
            await storeSetValue("MINIMA_URL", result.minimaUrl);
            process.env.MINIMA_URL = result.minimaUrl;
          }
          await setProject(repo, {
            instanceId: result.instanceId,
            projectId: result.projectId,
            namespace: result.namespace,
            minimaUrl: result.minimaUrl,
          });
          if (result.namespace) agent.config.namespace = result.namespace;
          agent.reconnect();
          setMessages((m) => [
            ...m,
            {
              role: "tool",
              text: `✅ Authorized. Key stored (${mask(result.mubitApiKey)}). Project ${result.projectId} on ${result.instanceId}. Router reconnected.${
                anyProviderKeyPresent()
                  ? ""
                  : `\n→ Next: set a model-provider key to run models — ${keyHint("anthropic")} (or OPENAI/GOOGLE/OPENROUTER).`
              }`,
              toolName: "auth",
            },
          ]);
        } catch (exc) {
          if (exc instanceof ProvisioningPending) {
            setMessages((m) => [
              ...m,
              {
                role: "tool",
                text: "⏳ Your Minima workspace is provisioning (~1-2 min). Run /auth again shortly — it'll pick up where it left off.",
                toolName: "auth",
              },
            ]);
          } else {
            setMessages((m) => [
              ...m,
              {
                role: "tool",
                text: `auth failed: ${errText(exc)}`,
                toolName: "auth",
                isError: true,
              },
            ]);
          }
        }
        break;
      }
      case "config": {
        const parts = args.trim().split(/\s+/);
        if (parts[0] === "set" && parts[1]) {
          const key = parts[1]!.toUpperCase();
          const value = parts.slice(2).join(" ");
          if (!value) {
            setMessages((m) => [
              ...m,
              {
                role: "user",
                text: `/${name} ${args}`.trim(),
              },
              {
                role: "tool",
                text: "Usage: /config set <KEY> <value>",
                toolName: "config",
                isError: true,
              },
            ]);
            break;
          }
          const backend = await storeSetValue(key, value);
          process.env[key] = value;
          if (key === "MUBIT_API_KEY" || key === "MINIMA_API_KEY") agent.reconnect();
          setMessages((m) => [
            ...m,
            {
              role: "user",
              text: `/${name} ${args.split(" ").slice(0, 2).join(" ")} ***`,
            },
            {
              role: "tool",
              text: `${key} stored (${backend}). ${key === "MUBIT_API_KEY" || key === "MINIMA_API_KEY" ? "Router reconnected." : "Set in env."}`,
              toolName: "config",
            },
          ]);
        } else if (parts[0] === "get" && parts[1]) {
          const key = parts[1]!.toUpperCase();
          const val = await storeGet(key);
          setMessages((m) => [
            ...m,
            {
              role: "user",
              text: `/${name} ${args}`.trim(),
            },
            {
              role: "tool",
              text: `${key}=${val ? mask(val) : "(not set)"}`,
              toolName: "config",
            },
          ]);
        } else {
          setConfigOverlayOpen(true);
        }
        break;
      }
      case "plan": {
        const next = !planMode;
        setPlanMode(next);
        setMessages((m) => [
          ...m,
          {
            role: "user",
            text: `/${name} ${args}`.trim(),
          },
          {
            role: "tool",
            text: next
              ? "Plan mode ON — read-only (write/edit/bash blocked). Use /plan again to exit."
              : "Plan mode OFF — full write access restored.",
            toolName: "plan",
          },
        ]);
        break;
      }
      case "help":
        setMessages((m) => [
          ...m,
          {
            role: "user",
            text: `/${name} ${args}`.trim(),
          },
          {
            role: "tool",
            text: `Available commands:\n${COMMANDS.map((c) => `  /${c.name.padEnd(12)} ${c.desc}`).join("\n")}`,
            toolName: "help",
          },
        ]);
        break;
      case "cost": {
        // `/cost fleet` — org-level savings truth straight from the server.
        if (args.trim().toLowerCase().startsWith("fleet")) {
          setMessages((m) => [...m, { role: "user", text: `/${name} ${args}`.trim() }]);
          try {
            const s = await agent.router.savings({ days: 30 });
            const summary = JSON.stringify(s.summary ?? {}, null, 2);
            setMessages((m) => [
              ...m,
              {
                role: "tool",
                text: `Fleet savings (org ${s.org_id}, last ${s.days}d${s.namespace ? `, ns ${s.namespace}` : ""}):\n${summary}`,
                toolName: "cost",
              },
            ]);
          } catch (exc) {
            setMessages((m) => [
              ...m,
              {
                role: "tool",
                text: `fleet savings unavailable: ${errText(exc)}`,
                toolName: "cost",
                isError: true,
              },
            ]);
          }
          break;
        }
        let report = agent.meter?.report() || "(no cost metrics recorded)";
        // Persisted-run metrics (quality/$, savings, OCR) — the durable view.
        if (agent.db && agent.runId) {
          try {
            const rows = agent.db.getRunDecisions(agent.runId) as unknown as Parameters<
              typeof metricsReport
            >[0];
            report += `\n\n— run metrics —\n${metricsReport(rows)}`;
          } catch {
            // metrics are best-effort
          }
        }
        setMessages((m) => [
          ...m,
          {
            role: "user",
            text: `/${name} ${args}`.trim(),
          },
          {
            role: "tool",
            text: report,
            toolName: "cost",
          },
        ]);
        break;
      }
      case "budget": {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        let textOut: string;
        let isErr = false;
        if (parts[0] === "set" && parts[1]) {
          const usd = Number(parts[1]);
          if (!Number.isFinite(usd) || usd <= 0) {
            textOut = "Usage: /budget set <usd>  (positive USD amount)";
            isErr = true;
          } else if (agent.db && agent.runId) {
            agent.budget = new BudgetLedger({
              db: agent.db,
              scopeKey: `session:${agent.runId}`,
              limitUsd: usd,
              mode: agent.budget?.mode ?? "warn",
              runId: agent.runId,
            });
            agent.budget.setOnEvent((e) => {
              if (e.kind === "threshold" || e.kind === "deny") {
                setMessages((m) => [
                  ...m,
                  {
                    role: "tool",
                    text: `${e.kind === "deny" ? "⛔" : "💰"} ${e.note ?? e.kind}`,
                    toolName: "budget",
                    isError: e.kind === "deny",
                  },
                ]);
              }
              setBudgetStatus(agent.budget?.status() ?? null);
            });
            setBudgetStatus(agent.budget.status());
            textOut = `Budget set: $${usd.toFixed(2)} (${agent.budget.mode} mode) — warnings at 50/75/90/100%`;
          } else {
            textOut = "Budget unavailable: persistence is disabled this session";
            isErr = true;
          }
        } else if (parts[0] === "mode" && parts[1]) {
          const mode = parts[1] as "shadow" | "warn" | "enforce";
          if (!["shadow", "warn", "enforce"].includes(mode)) {
            textOut = "Usage: /budget mode shadow|warn|enforce";
            isErr = true;
          } else if (agent.budget) {
            agent.budget.setMode(mode);
            setBudgetStatus(agent.budget.status());
            textOut = `Budget mode: ${mode}${mode === "enforce" ? " — runs are refused once the limit is hit" : ""}`;
          } else {
            textOut = "No budget set — /budget set <usd> first";
            isErr = true;
          }
        } else if (agent.budget) {
          const s = agent.budget.status();
          textOut = `Budget: $${s.spentUsd.toFixed(4)} spent + $${s.reservedUsd.toFixed(4)} reserved of $${s.limitUsd.toFixed(2)} (${Math.round(s.fraction * 100)}%) · remaining $${s.remainingUsd.toFixed(4)} · mode ${s.mode}\n/budget set <usd> · /budget mode shadow|warn|enforce`;
        } else {
          textOut = "No budget set. /budget set <usd> to add one (warn mode by default).";
        }
        setMessages((m) => [
          ...m,
          { role: "user", text: `/${name} ${args}`.trim() },
          { role: "tool", text: textOut, toolName: "budget", isError: isErr },
        ]);
        break;
      }
      case "reconnect": {
        agent.reconnect();
        // Re-pull the model catalog too (a key added since launch may unlock more models).
        void refreshCatalog(agent.config)
          .then((n) => {
            if (n > 0) setCatalogVersion((v) => v + 1);
          })
          .catch(() => {});
        setMessages((m) => [
          ...m,
          {
            role: "user",
            text: `/${name} ${args}`.trim(),
          },
          {
            role: "tool",
            text: "Rebuilding Minima router client... connected!",
            toolName: "reconnect",
          },
        ]);
        break;
      }
      case "quit":
      case "exit":
        exit();
        break;
      case "new":
        agent.setSessionId(Math.random().toString(16).slice(2, 14));
        agent.reset();
        setTranscriptGen((g) => g + 1);
        setMessages([]);
        setActualCost(0);
        setInputTokens(0);
        setOutputTokens(0);
        setCtxPct(0);
        setMessages((m) => [
          ...m,
          {
            role: "tool",
            text: `Started fresh session: ${agent.sessionId}`,
            toolName: "new",
          },
        ]);
        break;
      case "name": {
        // Persist to the run row so the name survives reload (was cosmetic-only).
        let persisted = false;
        if (agent.db && agent.runId && args.trim()) {
          try {
            agent.db.setRunName(agent.runId, args.trim());
            persisted = true;
          } catch {
            // fail-open: name-setting must not break the session
          }
        }
        setMessages((m) => [
          ...m,
          {
            role: "user",
            text: `/${name} ${args}`.trim(),
          },
          {
            role: "tool",
            text: persisted
              ? `Session name set to "${args.trim()}" (persisted)`
              : `Session display name set to: "${args}" (not persisted — no run store)`,
            toolName: "name",
          },
        ]);
        break;
      }
      case "session":
        setMessages((m) => [
          ...m,
          {
            role: "user",
            text: `/${name} ${args}`.trim(),
          },
          {
            role: "tool",
            text: `session: ${agent.sessionId ?? "ephemeral"} · entries=${messages.length}`,
            toolName: "session",
          },
        ]);
        break;
      case "tree":
        setTreeOpen((o) => !o);
        setMessages((m) => [
          ...m,
          {
            role: "user",
            text: `/${name} ${args}`.trim(),
          },
          {
            role: "tool",
            text:
              childrenState.size > 0
                ? `Sub-agent tree toggled (${childrenState.size} tracked). Use /tree again to collapse.`
                : "No sub-agents active. The tree panel will appear during multi-step task runs.",
            toolName: "tree",
          },
        ]);
        break;
      case "fork":
        setMessages((m) => [
          ...m,
          {
            role: "user",
            text: `/${name} ${args}`.trim(),
          },
          {
            role: "tool",
            text: "/fork isn't implemented yet — session branching is planned. For now use /resume to reopen a past session or /new to start fresh.",
            toolName: "fork",
          },
        ]);
        break;
      case "clone":
        setMessages((m) => [
          ...m,
          {
            role: "user",
            text: `/${name} ${args}`.trim(),
          },
          {
            role: "tool",
            text: "/clone isn't implemented yet — session copy is planned. For now use /resume to reopen a past session or /new to start fresh.",
            toolName: "clone",
          },
        ]);
        break;
      case "resume": {
        const targetId = args.trim();
        if (!targetId) {
          try {
            // DB-backed runs are the real record (JSONL sessions are legacy/read-only).
            if (agent.db) {
              const runs = agent.db
                .listRuns(repoIdentity(process.cwd()))
                .filter((r) => r.run_id !== agent.runId);
              setSessionsList(
                runs.map((r) => ({
                  path: `run:${r.run_id}`,
                  sessionId: r.run_id.slice(0, 12),
                  displayName: r.display_name,
                  nEntries: agent.db?.countEvents(r.run_id) ?? 0,
                  created: r.created * 1000,
                  mtime: r.updated * 1000,
                })),
              );
              setSessionPickerOpen(true);
            } else {
              const manager = new SessionManager();
              const list = await manager.listSessions(process.cwd());
              setSessionsList(list);
              setSessionPickerOpen(true);
            }
          } catch (exc) {
            setMessages((m) => [
              ...m,
              {
                role: "tool",
                text: `Failed to list sessions: ${errText(exc)}`,
                toolName: "resume",
                isError: true,
              },
            ]);
          }
        } else {
          try {
            if (agent.db) {
              await loadRun(targetId);
            } else {
              const manager = new SessionManager();
              const store = await manager.open(process.cwd(), {
                sessionId: targetId,
              });
              await loadSession(store);
            }
          } catch (exc) {
            setMessages((m) => [
              ...m,
              {
                role: "user",
                text: `/${name} ${args}`.trim(),
              },
              {
                role: "tool",
                text: `Failed to resume session: ${errText(exc)}`,
                toolName: "resume",
                isError: true,
              },
            ]);
          }
        }
        break;
      }
      case "tip": {
        const arg = args.trim().toLowerCase();
        if (arg === "on" || arg === "off") {
          const on = arg === "on";
          setTipsEnabled(on);
          setTipsEnabledState(on);
          setMessages((m) => [
            ...m,
            { role: "user", text: `/tip ${arg}` },
            {
              role: "tool",
              text: `startup tips ${on ? "on" : "off"}`,
              toolName: "tip",
            },
          ]);
          break;
        }
        setMessages((m) => [
          ...m,
          { role: "tool", text: formatTip(advanceTip()), toolName: "tip" },
        ]);
        break;
      }
      case "judge": {
        const on = args.trim().toLowerCase() in { on: 1, "1": 1, true: 1, yes: 1 };
        agent.config.judgeEvery = on ? 1 : 0;
        setMessages((m) => [
          ...m,
          {
            role: "user",
            text: `/${name} ${args}`.trim(),
          },
          {
            role: "tool",
            text: `judging ${agent.config.judgeEvery > 0 ? "on" : "off"} (judge_every=${agent.config.judgeEvery})`,
            toolName: "judge",
          },
        ]);
        break;
      }
      case "thoughts": {
        const target = args.trim().toLowerCase();
        let on = !showThinking;
        if (target === "on" || target === "1" || target === "true" || target === "yes") {
          on = true;
        } else if (target === "off" || target === "0" || target === "false" || target === "no") {
          on = false;
        }
        setShowThinking(on);
        if (on && agent.agentState.thinkingLevel === "off") {
          agent.agentState.thinkingLevel = "medium";
          setThinkingLevel("medium");
        }
        if (!on) {
          agent.agentState.thinkingLevel = "off";
          setThinkingLevel("off");
        }
        setMessages((m) => [
          ...m,
          {
            role: "user",
            text: `/${name} ${args}`.trim(),
          },
          {
            role: "tool",
            text: `reasoning: ${on ? "ON" : "off"}${on ? " — model's reasoning streams above each answer" : ""}`,
            toolName: "thoughts",
          },
        ]);
        break;
      }
      case "model": {
        const target = args.trim().toLowerCase();
        if (!target) {
          setPickerOpen(true);
        } else if (target === "auto" || target === "unpin" || target === "clear") {
          agent.config.pinned = false;
          setBasis("minima");
          setMessages((m) => [
            ...m,
            {
              role: "user",
              text: `/${name} ${args}`.trim(),
            },
            {
              role: "tool",
              text: "Unpinned model: auto — Minima routes each turn",
              toolName: "model",
            },
          ]);
        } else {
          const matched = allModels().find((m) => m.id.toLowerCase() === target);
          if (matched) {
            agent.agentState.model = matched;
            agent.config.pinned = true;
            agent.config.candidates = [matched.id];
            setBasis("pinned");
            setMessages((m) => [
              ...m,
              {
                role: "user",
                text: `/${name} ${args}`.trim(),
              },
              {
                role: "tool",
                text: `Pinned model: ${matched.id}`,
                toolName: "model",
              },
            ]);
          } else {
            setMessages((m) => [
              ...m,
              {
                role: "user",
                text: `/${name} ${args}`.trim(),
              },
              {
                role: "tool",
                text: `Model ID not found: "${args}". Available candidates:\n${allModels()
                  .map((m) => `  - ${m.id}`)
                  .join("\n")}`,
                toolName: "model",
                isError: true,
              },
            ]);
          }
        }
        break;
      }
      default:
        setMessages((m) => [
          ...m,
          {
            role: "user",
            text: `/${name} ${args}`.trim(),
          },
          {
            role: "tool",
            text: `Unknown command: /${name}. Type /help to see all available commands.`,
            toolName: "error",
            isError: true,
          },
        ]);
    }
  }

  async function onSubmit(text: string) {
    setTypedText("");
    setScrollOffset(0); // jump back to the newest content when the user sends (fullscreen viewport)
    setHistory((h) => {
      const trimmed = text.trim();
      if (trimmed && (h.length === 0 || h[h.length - 1] !== trimmed)) {
        return [...h, trimmed];
      }
      return h;
    });
    setHistoryIdx(null);

    const trimmed = text.trim();
    if (trimmed.startsWith("/")) {
      const firstSpace = trimmed.indexOf(" ");
      const name = firstSpace !== -1 ? trimmed.slice(1, firstSpace) : trimmed.slice(1);
      const args = firstSpace !== -1 ? trimmed.slice(firstSpace + 1).trim() : "";
      await handleCommand(name, args);
      return;
    }

    setBusy(true);
    setBusyState("reasoning");
    setStreaming("");
    setStreamingThoughts("");
    try {
      const expanded = expandAtFiles(text, process.cwd());
      const routing = await agent.promptRouted(expanded);
      if (routing) {
        setBasis(routing.decisionBasis || "minima");
        // Recommend-path warnings are all benign/informational (routing succeeded or degraded
        // gracefully) — surface as a MUTED info note, never a red error. See routing-warnings.ts.
        const info = routingInfoWarnings(routing.warnings);
        if (info.length > 0) {
          setMessages((m) => [
            ...m,
            {
              role: "tool",
              text: `ℹ ${info.join("; ")}`,
              toolName: "routing",
              isError: false,
            },
          ]);
        }
      } else {
        setBasis("offline");
        const reason = agent.offlineReason ?? "Minima unreachable";
        // Offline is graceful degradation — the turn still ran on the default model. Muted, not red.
        setMessages((m) => [
          ...m,
          {
            role: "tool",
            text: `ℹ routing offline: ${reason} — ran ${agent.agentState.model?.id ?? "default model"} unrouted. /reconnect to retry.`,
            toolName: "routing",
            isError: false,
          },
        ]);
      }
    } catch (exc) {
      setMessages((m) => [
        ...m,
        {
          role: "tool",
          toolName: "error",
          text: `⚠ ${actionableError(errText(exc), agent.agentState.model?.provider)}`,
          isError: true,
        },
      ]);
    } finally {
      setBusy(false);
      setBusyState("ready");
      setStreaming("");
      setStreamingThoughts("");
      const totals = agent.meter?.totals();
      if (totals) setActualCost(totals.actualCostUsd);
      if (agent.budget) setBudgetStatus(agent.budget.status());

      const last = getLastAssistant(agent);
      if (last?.usage) {
        setInputTokens(last.usage.input || 0);
        setOutputTokens(last.usage.output || 0);
        const model = agent.agentState.model;
        if (model?.context_window) {
          setCtxPct((100 * last.usage.input) / model.context_window);
        } else {
          setCtxPct(0);
        }
      }

      if (maybeAutoCompact(agent)) {
        setMessages((m) => [
          ...m,
          {
            role: "tool",
            text: "Context auto-compacted (was >80% full)",
            toolName: "compact",
          },
        ]);
      }
    }
  }

  // The finalized transcript is printed to native scrollback via <Static>; only the LIVE region
  // (streaming reply + thoughts + busy + input + status) is re-diffed by Ink, so it must fit the
  // screen. Because we render inline in the MAIN buffer, a live frame that reaches `rows` makes Ink
  // clearTerminal (CSI 3J) and WIPE the scrollback (all <Static> history) — so we reserve rows for
  // each live element and bound the streaming preview to keep the total strictly below `rows` (see
  // streamTailBudget). The full reply is committed to <Static> when the turn ends, so nothing is lost.
  const footerHeight = 6; // StatusBar (2 rows + margin) + keybinding row + quit line (generous)
  const suggestionsHeight =
    matchingCommands.length > 0 ? matchingCommands.length + 2 + (hiddenSuggestions > 0 ? 1 : 0) : 0;
  const overlayOpen = pickerOpen || paletteOpen || sessionPickerOpen || configOverlayOpen;
  // The prompt/plan input box only renders when no overlay/picker/permission prompt owns the
  // bottom region (see the render tree). Plan mode adds its banner (+3). A long typed prompt wraps
  // inside the box, so grow the reserve by the extra wrapped lines.
  const inputHidden = overlayOpen || permPrompt || questionPrompt;
  const inputExtraLines = inputHidden ? 0 : Math.max(1, wrappedLineCount(typedText, cols - 4)) - 1;
  const inputBoxHeight = inputHidden ? 0 : (planMode ? 7 : 4) + inputExtraLines;
  const permPromptHeight = permPrompt
    ? 3 + // round border (2) + prompt line (1)
      (permPrompt.argsSummary && !permPrompt.diffPreview ? 1 : 0) +
      (permPrompt.diffPreview ? Math.min(12, permPrompt.diffPreview.split("\n").length) : 0) +
      1 // hint line
    : 0;
  // The thoughts peek is wrap="truncate" (fixed ~4 rows), so it never grows with content.
  const streamingThoughtsHeight = streamingThoughts && showThinkingRef.current ? 4 : 0;
  // The busy indicator (spinner + tip) renders as one line above the input box while a turn
  // is running and no overlay owns the bottom region. Reserve marginTop(1) + line(1) = 2 rows.
  const busyIndicatorVisible = busy && !overlayOpen && !permPrompt && !questionPrompt;
  const busyIndicatorHeight = busyIndicatorVisible ? 2 : 0;
  // Rows left for the live streaming reply after the other live elements; bound its preview to that
  // (keeping the newest lines) so the re-diffed region never exceeds the terminal.
  const streamReserved =
    footerHeight +
    suggestionsHeight +
    inputBoxHeight +
    permPromptHeight +
    busyIndicatorHeight +
    streamingThoughtsHeight +
    2; // "◆ assistant" header + marginTop
  const streamTail = streaming
    ? tailToFit(streaming, cols, streamTailBudget(rows, streamReserved))
    : "";

  // Fullscreen: window the transcript into the chat region above the fixed footer, and bound the
  // in-viewport streaming reply. The viewport is overflow:"hidden" + justifyContent:"flex-end", so
  // any height under-count merely clips an extra top row instead of overflowing — and running in the
  // alternate screen makes Ink's clearTerminal fallback harmless (no native scrollback to wipe).
  const chatRegionHeight = Math.max(
    1,
    rows -
      footerHeight -
      suggestionsHeight -
      inputBoxHeight -
      permPromptHeight -
      busyIndicatorHeight,
  );
  const scrollWin = fullscreen
    ? getScrollableMessages(messages, chatRegionHeight, scrollOffset, cols)
    : null;
  if (scrollWin) {
    maxChatHeightRef.current = chatRegionHeight; // page size for PgUp/PgDn
    atBottomRef.current = scrollWin.atBottom; // gates follow-on-new-content + in-viewport streaming
  }
  const fsStreamTail =
    fullscreen && busy && scrollWin?.atBottom && streaming
      ? tailToFit(streaming, cols, chatRegionHeight)
      : "";

  // Below a usable size the fixed footer + input + overlays can't coexist with even one chat row;
  // show a single resize notice instead of a clipped, garbled UI.
  if (rows < 10 || cols < 40) {
    return (
      <Box
        height={rows}
        width="100%"
        flexDirection="column"
        justifyContent="center"
        alignItems="center"
        overflow="hidden"
      >
        <Text color="yellow" bold>
          Terminal too small
        </Text>
        <Text color="gray">{`resize to at least 40×10 (now ${cols}×${rows})`}</Text>
      </Box>
    );
  }

  const bannerBlock =
    messages.length === 0 && matchingCommands.length === 0 && !overlayOpen ? (
      <Box flexDirection="column" alignItems="center" marginTop={1}>
        <Text color="green" bold>
          {getAsciiBanner("MINIMA")}
        </Text>
        <Box marginTop={1}>
          <Text color="gray">CLI · cost-aware model routing</Text>
        </Box>
        <Box marginTop={1}>
          <Text color="gray">recommend → run → judge → feedback → memory</Text>
        </Box>
        <Box marginTop={1}>
          <Text color="gray">type a prompt, or / for commands</Text>
        </Box>
        <Box marginTop={1}>
          <Text color="gray">
            {fullscreen
              ? "scroll history with PgUp / PgDn · /mouse toggles wheel scroll"
              : "scroll with your terminal (wheel / trackpad) · select & copy freely"}
          </Text>
        </Box>
        {tipsEnabled && startupTip ? (
          <Box marginTop={1}>
            <Text color="yellow">{startupTip}</Text>
          </Box>
        ) : null}
      </Box>
    ) : null;

  return (
    // Two layouts share one fixed footer (suggestions + input/overlays + status bar). FULLSCREEN wraps
    // the transcript in a bottom-anchored, in-app-scrolled viewport inside a height={rows} frame, so
    // the prompt is glued to the last row (like Claude Code's fullscreen mode). INLINE prints the
    // transcript to the terminal's native scrollback via <Static> and lets the terminal scroll it.
    <Box
      flexDirection="column"
      width="100%"
      height={fullscreen ? rows : undefined}
      overflow={fullscreen ? "hidden" : "visible"}
    >
      {fullscreen ? (
        <Box
          flexGrow={1}
          minHeight={0}
          overflow="hidden"
          flexDirection="column"
          justifyContent="flex-end"
        >
          {bannerBlock}
          {(scrollWin?.visible ?? []).map((msg, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: windowed transcript, positional key is fine
            <MessageRow key={i} msg={msg} cols={cols} />
          ))}
          {busy && scrollWin?.atBottom && streamingThoughts && showThinkingRef.current ? (
            <StreamingThoughts text={streamingThoughts} />
          ) : null}
          {busy && scrollWin?.atBottom && fsStreamTail ? (
            <StreamingReply text={fsStreamTail} />
          ) : null}
          {scrollWin && !scrollWin.atBottom ? (
            <Text color="gray">{`  ↑ scrolled up${scrollWin.atTop ? " (top)" : ""} · PgDn to catch up`}</Text>
          ) : null}
        </Box>
      ) : (
        <>
          {/* Finalized transcript → native scrollback (each message once, never re-diffed). */}
          <Static key={transcriptGen} items={messages}>
            {(msg, i) => <MessageRow key={i} msg={msg} cols={cols} />}
          </Static>
          {bannerBlock}
          {/* Live region: reasoning peek + streaming reply, tail-bounded so the re-diffed region
              never reaches `rows` (which would make Ink clearTerminal and wipe scrollback). */}
          {busy && streamingThoughts && showThinkingRef.current ? (
            <StreamingThoughts text={streamingThoughts} />
          ) : null}
          {busy && streamTail ? <StreamingReply text={streamTail} /> : null}
        </>
      )}

      {matchingCommands.length > 0 && (
        <Box
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          flexDirection="column"
          width="100%"
          marginBottom={0}
          flexShrink={0}
        >
          <Box position="absolute" marginTop={-1} marginLeft={2}>
            <Text color="gray"> commands </Text>
          </Box>
          {matchingCommands.map((cmd) => (
            <Box key={cmd.name}>
              <Text color="yellow">/{cmd.name.padEnd(12)}</Text>
              <Text color="gray">{cmd.desc}</Text>
            </Box>
          ))}
          {hiddenSuggestions > 0 && (
            <Text color="gray">…+{hiddenSuggestions} more · keep typing or Tab to complete</Text>
          )}
        </Box>
      )}

      {busyIndicatorVisible && <BusyIndicator active showTip={tipsEnabled} />}

      {pickerOpen ? (
        <ModelPicker
          models={allModels()}
          currentId={agent.agentState.model?.id ?? ""}
          onPick={pickModel}
          onDismiss={() => setPickerOpen(false)}
        />
      ) : paletteOpen ? (
        <CommandPicker
          commands={COMMANDS}
          onPick={(name) => {
            setPaletteOpen(false);
            handleCommand(name, "").catch((exc) => {
              setMessages((m) => [
                ...m,
                {
                  role: "tool",
                  text: `Command /${name} failed: ${errText(exc)}`,
                  toolName: "error",
                  isError: true,
                },
              ]);
            });
          }}
          onDismiss={() => setPaletteOpen(false)}
        />
      ) : sessionPickerOpen ? (
        <SessionPicker
          sessions={sessionsList}
          onPick={async (path) => {
            setSessionPickerOpen(false);
            if (path.startsWith("run:")) {
              await loadRun(path.slice(4)).catch((exc) => {
                setMessages((m) => [
                  ...m,
                  {
                    role: "tool",
                    text: `Failed to resume run: ${errText(exc)}`,
                    toolName: "resume",
                    isError: true,
                  },
                ]);
              });
            } else {
              const store = await SessionStore.fileBacked(path);
              await loadSession(store);
            }
          }}
          onDismiss={() => setSessionPickerOpen(false)}
        />
      ) : configOverlayOpen ? (
        <ConfigOverlay onDismiss={() => setConfigOverlayOpen(false)} />
      ) : permPrompt || questionPrompt ? null : ( // permission/question prompt owns the bottom region (rendered below)
        <Box flexDirection="column" width="100%" marginTop={1} flexShrink={0}>
          {planMode && (
            <Box borderStyle="round" borderColor="magenta" paddingX={1} marginBottom={0}>
              <Text color="magenta" bold>
                {" ⚠ PLAN MODE — read only (write/edit/bash blocked) · /plan to exit "}
              </Text>
            </Box>
          )}
          <Box
            borderStyle="round"
            borderColor={planMode ? "magenta" : "yellow"}
            paddingX={1}
            flexDirection="column"
            width="100%"
          >
            <Box position="absolute" marginTop={-1} marginLeft={2}>
              <Text color={planMode ? "magenta" : "yellow"}>
                {planMode ? " plan mode " : " prompt "}
              </Text>
            </Box>
            <TextInput
              onSubmit={onSubmit}
              onChange={setTypedText}
              onTab={handleTabComplete}
              onShiftTab={cycleThinkingLevel}
              onUp={handleHistoryUp}
              onDown={handleHistoryDown}
              disabled={busy}
              placeholder=""
              showPrefix={false}
            />
          </Box>
        </Box>
      )}

      {permPrompt && (
        <PermissionOverlay
          prompt={{
            ...permPrompt,
            resolve: (decision) => {
              setPermPrompt(null);
              permPrompt.resolve(decision);
            },
          }}
        />
      )}

      {questionPrompt && !permPrompt && (
        <QuestionOverlay
          prompt={{
            ...questionPrompt,
            resolve: (answer) => {
              setQuestionPrompt(null);
              questionPrompt.resolve(answer);
            },
          }}
        />
      )}

      <Box flexDirection="column" flexShrink={0}>
        {treeOpen && <ChildTree nodes={childrenState} />}
        <StatusBar
          model={agent.agentState.model?.id ?? "(none)"}
          basis={basis}
          routeMode={routeMode}
          thinkingLevel={thinkingLevel}
          ctxPct={ctxPct}
          inputTokens={inputTokens}
          outputTokens={outputTokens}
          actualCostUsd={actualCost}
          budget={budgetStatus}
          sessionId={agent.sessionId ?? "ephemeral"}
          routingOffline={agent.offlineReason !== null}
          offlineReason={agent.offlineReason}
          statusText={busyState}
          planMode={planMode}
          readDirs={[...permStateRef.current.allowedDirs].map((d) => d.replace(process.cwd(), "."))}
          alwaysTools={[...permStateRef.current.allowAlways]}
          activeChildren={childrenState.size > 0 ? childrenState.size : undefined}
        />

        <Box justifyContent="space-between" width="100%">
          <Box>
            <Text color="yellow">ctrl+l </Text>
            <Text color="gray">Model </Text>
            <Text color="yellow">ctrl+r </Text>
            <Text color="gray">Route </Text>
            <Text color="yellow">esc </Text>
            <Text color="gray">Abort</Text>
          </Box>
          <Box>
            <Text color="yellow">ctrl+p </Text>
            <Text color="gray">palette</Text>
          </Box>
        </Box>

        {quitArmed ? <Text color="yellow"> Ctrl+C again to quit</Text> : null}
      </Box>
    </Box>
  );
}
