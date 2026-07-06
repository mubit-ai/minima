/**
 * HarnessApp — the interactive Ink shell.
 *
 * A focused port of minima_harness/tui/app.py: renders the conversation (user prompts,
 * streamed assistant replies, terse tool lines) plus a status bar, and drives the
 * MinimaAgent. Ctrl+C quits; Esc aborts the in-flight run. (The Python app's overlays,
 * diff approval, mouse capture, sessions, and themes land in later passes.)
 */

import { Box, Text, useApp, useInput } from "ink";
import React, { useEffect, useState, useRef } from "react";
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
import { SessionManager, SessionStore, type SessionSummary, formatAge } from "../session/store.ts";
import { expandAtFiles } from "../tools/at_mentions.ts";
import type { AskUserRef, QuestionOption } from "../tools/question.ts";
import { DEFAULT_CONSOLE_URL, ProvisioningPending, runAuth } from "./auth.ts";
import { BusyIndicator } from "./busy.tsx";
import { compactMessages, maybeAutoCompact } from "./compact.ts";
import { SECTIONS, mask, get as storeGet, setValue as storeSetValue } from "./config_store.ts";
import { getScrollableMessages, wrappedLineCount } from "./layout.ts";
import { type ChatMessage, Messages } from "./messages.tsx";
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
  { name: "tree", desc: "View the session tree" },
  { name: "fork", desc: "Fork from an entry ID" },
  { name: "clone", desc: "Clone the current session" },
  { name: "resume", desc: "Resume a session (optionally by id)" },
  { name: "judge", desc: "Toggle LLM judging on/off" },
  { name: "thoughts", desc: "Toggle streaming model's reasoning" },
  { name: "mouse", desc: "Toggle mouse capture (scroll vs select/copy)" },
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

  useInput((input, key) => {
    if (key.escape) return onDismiss();
    if (sessions.length === 0) return;
    if (key.upArrow) return setCursor((c) => (c - 1 + sessions.length) % sessions.length);
    if (key.downArrow) return setCursor((c) => (c + 1) % sessions.length);
    if (key.return) return onPick(sessions[cursor]!.path);
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= sessions.length) return onPick(sessions[n - 1]!.path);
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
            const shown = f.secret && !isActive ? mask(val) : f.secret && isActive ? val : val;
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

export function HarnessApp({ agent, banner: _banner, askUserRef }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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
  const [mouseEnabled, setMouseEnabled] = useState(true);
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

  // Sizing & alternate screen setup
  const [rows, setRows] = useState(process.stdout.rows || 24);
  const [cols, setCols] = useState(process.stdout.columns || 80);

  useEffect(() => {
    const handleResize = () => {
      setRows(process.stdout.rows || 24);
      setCols(process.stdout.columns || 80);
    };
    process.stdout.on("resize", handleResize);

    // Register the mouse scroll callback (the stdin.read() filter is already
    // installed in main.ts; here we just wire it to our scroll state).
    setMouseScrollCallback((dir) => {
      if (dir === "up") {
        setScrollOffset((p) => p + 3);
      } else {
        setScrollOffset((p) => Math.max(0, p - 3));
      }
    });

    return () => {
      process.stdout.off("resize", handleResize);
      setMouseScrollCallback(null);
      process.stdout.write("\u001b[?1006l");
      process.stdout.write("\u001b[?1000l");
    };
  }, []);

  // Toggle SGR mouse reporting on/off based on mouseEnabled state.
  // ON: mouse wheel scroll works, but terminal native select/copy is suppressed.
  // OFF: native select/copy works (drag to select, Cmd/Ctrl+C to copy), but no wheel scroll.
  useEffect(() => {
    if (mouseEnabled) {
      process.stdout.write("\u001b[?1000h");
      process.stdout.write("\u001b[?1006h");
    } else {
      process.stdout.write("\u001b[?1006l");
      process.stdout.write("\u001b[?1000l");
    }
  }, [mouseEnabled]);

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

  // Scroll state: 0 = at bottom (latest); positive = scrolled up N lines
  const [scrollOffset, setScrollOffset] = useState(0);
  // Latest render's atBottom + visible-chat-height, read by the input/scroll handlers (which
  // close over stale render values otherwise). Written once per render, below the height math.
  const atBottomRef = useRef(true);
  const maxChatHeightRef = useRef(1);

  // Follow the newest content ONLY when the user is already at the bottom. If they've scrolled
  // up (offset > 0) we leave their position alone — otherwise every ~80ms streaming delta would
  // yank the view back down and make scrolling-while-generating impossible.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally trigger on content changes
  useEffect(() => {
    if (atBottomRef.current) setScrollOffset(0);
  }, [messages.length, streaming, streamingThoughts]);

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

    // Scrolling works whether or not a turn is running — page by the REAL visible chat height,
    // not a hardcoded rows-6 (which ignored the input box, suggestions, busy line and streaming).
    const page = Math.max(1, maxChatHeightRef.current - 2);
    if (key.pageUp) {
      setScrollOffset((prev) => prev + page);
      return;
    }
    if (key.pageDown || (key.shift && input === " ")) {
      setScrollOffset((prev) => Math.max(0, prev - page));
      return;
    }
    if (key.ctrl && input === "g") {
      setScrollOffset(99999); // Home — jump to top
      return;
    }
    if (key.ctrl && input === "e") {
      setScrollOffset(0); // End — jump to bottom
      return;
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

  function handleHistoryUp(): string | undefined {
    let nextIdx = historyIdx;
    if (nextIdx === null) {
      if (history.length === 0) return undefined;
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
      return "";
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
        setMessages((m) => [
          ...m,
          {
            role: "user",
            text: `/${name} ${args}`.trim(),
          },
          {
            role: "tool",
            text: `Session Tree:\n  └─ ${agent.sessionId ?? "ephemeral"} (active tip)\n     entries: ${messages.length}`,
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
            text: `Forked session successfully from: ${args || "tip"}`,
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
            text: "Cloned session successfully.",
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
      case "mouse": {
        const target = args.trim().toLowerCase();
        let on = !mouseEnabled;
        if (target === "on" || target === "1" || target === "true" || target === "yes") {
          on = true;
        } else if (target === "off" || target === "0" || target === "false" || target === "no") {
          on = false;
        }
        setMouseEnabled(on);
        setMessages((m) => [
          ...m,
          {
            role: "user",
            text: `/${name} ${args}`.trim(),
          },
          {
            role: "tool",
            text: on
              ? "mouse: ON — wheel scroll enabled · native select/copy disabled · /mouse off to toggle"
              : "mouse: OFF — native select/copy enabled (drag to select) · wheel scroll disabled · /mouse on to toggle",
            toolName: "mouse",
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

  // Calculate dynamic sizing for the chat list based on terminal size. The chat region is the
  // ONE flex-grow child; every other bottom region is a fixed sibling and must be subtracted so
  // the windowed history + live streaming fit the frame. (The region ALSO hard-clips via
  // overflow:"hidden" as a safety net — see the render tree — so an estimate error can never
  // corrupt the terminal, only shave a line at the fold.)
  const footerHeight = 6; // StatusBar (2 rows + margin) + keybinding row + quit line (generous)
  const suggestionsHeight =
    matchingCommands.length > 0 ? matchingCommands.length + 2 + (hiddenSuggestions > 0 ? 1 : 0) : 0;
  const overlayOpen = pickerOpen || paletteOpen || sessionPickerOpen || configOverlayOpen;
  // The prompt/plan input box only renders when no overlay/picker/permission prompt owns the
  // bottom region (see the render tree). Plan mode adds its banner (+3).
  const inputBoxHeight = overlayOpen || permPrompt || questionPrompt ? 0 : planMode ? 7 : 4;
  const permPromptHeight = permPrompt
    ? 3 + // round border (2) + prompt line (1)
      (permPrompt.argsSummary && !permPrompt.diffPreview ? 1 : 0) +
      (permPrompt.diffPreview ? Math.min(12, permPrompt.diffPreview.split("\n").length) : 0) +
      1 // hint line
    : 0;
  // Live streaming renders INSIDE the chat region, below the history. Reserve its true height:
  // count newlines + wrapping at the turn-box interior width (cols-4), plus box chrome (border 2 +
  // outer marginBottom 1 + inner marginY 2 + header 1 = 6). The old `2 + ceil(len/cols)` collapsed
  // newlines and undercounted, letting a multi-line reply overflow.
  const streamingHeight = streaming ? 6 + wrappedLineCount(streaming, cols - 4) : 0;
  // The thoughts peek is wrap="truncate" (fixed ~4 rows), so it never grows with content.
  const streamingThoughtsHeight = streamingThoughts && showThinkingRef.current ? 4 : 0;
  // The busy indicator (spinner + tip) renders as one line above the input box while a turn
  // is running and no overlay owns the bottom region. Reserve marginTop(1) + line(1) = 2 rows.
  const busyIndicatorVisible = busy && !overlayOpen && !permPrompt && !questionPrompt;
  const busyIndicatorHeight = busyIndicatorVisible ? 2 : 0;
  const chatRegionHeight = Math.max(
    1,
    rows -
      footerHeight -
      suggestionsHeight -
      inputBoxHeight -
      permPromptHeight -
      busyIndicatorHeight,
  );
  const maxChatHeight = Math.max(1, chatRegionHeight - streamingHeight - streamingThoughtsHeight);

  const { visible: visibleMsgs, atBottom } = getScrollableMessages(
    messages,
    maxChatHeight,
    scrollOffset,
    cols,
  );
  // Publish the latest layout facts for the input/scroll handlers, which close over render values.
  maxChatHeightRef.current = maxChatHeight;
  atBottomRef.current = atBottom;

  return (
    // Global overflow guard: bound the whole frame to exactly `rows` and clip anything beyond.
    // This keeps Ink's output from ever exceeding the terminal height (which is what desyncs its
    // cursor-relative diff into garbled output), covering not just the chat region but oversized
    // overlays (command palette, config, permission diffs) on short terminals too.
    <Box flexDirection="column" height={rows} width="100%" overflow="hidden">
      {messages.length === 0 &&
      matchingCommands.length === 0 &&
      !pickerOpen &&
      !paletteOpen &&
      !sessionPickerOpen &&
      !configOverlayOpen ? (
        <Box
          flexDirection="column"
          alignItems="center"
          justifyContent="flex-start"
          flexGrow={1}
          minHeight={0}
          overflow="hidden"
        >
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
              {mouseEnabled
                ? "wheel scroll ON · /mouse off to select & copy · PgUp/PgDn always works"
                : "select & copy ON · /mouse on for wheel scroll · PgUp/PgDn always works"}
            </Text>
          </Box>
          {tipsEnabled && startupTip ? (
            <Box marginTop={1}>
              <Text color="yellow">{startupTip}</Text>
            </Box>
          ) : null}
        </Box>
      ) : (
        // Hard overflow clamp: overflow="hidden" + minHeight={0} make it IMPOSSIBLE for the chat
        // to exceed its allotted rows regardless of any height-estimate error — this is what stops
        // Ink's cursor-relative diff from desyncing into garbled/overlapping output. flex-end
        // bottom-aligns the conversation so the clip eats the OLDEST content at the top fold,
        // keeping the newest answer + live streaming visible (correct chat semantics).
        <Box
          flexDirection="column"
          flexGrow={1}
          minHeight={0}
          overflow="hidden"
          justifyContent="flex-end"
        >
          <Messages
            messages={visibleMsgs}
            streaming={busy && atBottom ? streaming : ""}
            streamingThoughts={busy && atBottom && showThinkingRef.current ? streamingThoughts : ""}
          />
          {!atBottom && (
            <Text color="gray">
              {" "}
              ↑ scrolled up {scrollOffset} lines · PgDn or End to jump to bottom
            </Text>
          )}
        </Box>
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

      {questionPrompt && (
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
        />

        <Box justifyContent="space-between" width="100%">
          <Box>
            <Text color="yellow">pgup </Text>
            <Text color="gray">PgUp </Text>
            <Text color="yellow">pgdn </Text>
            <Text color="gray">PgDn </Text>
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
