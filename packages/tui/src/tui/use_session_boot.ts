/**
 * Mount-time bootstrap + mode side-effect hooks lifted out of app.tsx.
 *
 * Extraction only — the bodies are the effects that used to live inline in HarnessApp,
 * unchanged.
 */

import { useEffect, useRef, useState } from "react";
import { type AgentMode, MODE_BADGES } from "../agent/modes.ts";
import type { BudgetStatus } from "../minima/budget.ts";
import { refreshCatalogOnce } from "../minima/catalog.ts";
import type { MinimaAgent } from "../minima/runtime.ts";
import { setFooterBadge } from "./badge_slot.ts";
import { keymapPath, keymapProblems } from "./keymap_file.ts";
import type { ChatMessage } from "./messages.tsx";
import { persistMode } from "./mode_prefs.ts";
import { repoIdentity } from "./projects.ts";
import { anyProviderKeyPresent, keyHint } from "./provider_hints.ts";
import { advance as advanceTip, formatTip, isTipsEnabled } from "./tips.ts";

/**
 * Mode badge in the shared slot (PLAN magenta / ⏵⏵ ACCEPT EDITS green / ⚠ BYPASS red);
 * build shows nothing (the slot stays free for Track A guard flags). Never clears a badge
 * it didn't write (MINIMA_TUI_BADGE seeds survive until the first mode toggle).
 *
 * Also persists the mode per project (bypass excluded inside persistMode) so the next
 * session starts where this one left off — Claude Code behavior.
 *
 * Returns the memoized project key (repoIdentity forks git, so it is resolved at most once) —
 * the task-panel persistence in app.tsx reuses it.
 */
export function useModeEffects(mode: AgentMode): React.MutableRefObject<string | null> {
  const badgeOwnedRef = useRef(false);
  useEffect(() => {
    const badge = MODE_BADGES[mode];
    if (badge) {
      setFooterBadge(badge);
      badgeOwnedRef.current = true;
    } else if (badgeOwnedRef.current) {
      setFooterBadge(null);
      badgeOwnedRef.current = false;
    }
  }, [mode]);

  const projectKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (projectKeyRef.current === null) projectKeyRef.current = repoIdentity(process.cwd());
    persistMode(projectKeyRef.current, mode);
  }, [mode]);
  return projectKeyRef;
}

/**
 * On mount: rotate a startup tip, nudge if routing is set but no model-provider key is, pull
 * the live model catalog (Minima /v1/models + OpenRouter) so /model reflects runnable models
 * rather than just seeds, and route budget signals into the transcript.
 *
 * `setBudgetStatus` / `bumpCatalog` stay owned by the component — /budget, /reconnect and the
 * turn teardown all write them too.
 */
export function useSessionBoot(
  agent: MinimaAgent,
  cb: {
    pushMessage: (m: ChatMessage) => void;
    setBudgetStatus: (s: BudgetStatus | null) => void;
    bumpCatalog: () => void;
  },
): string | null {
  const [startupTip, setStartupTip] = useState<string | null>(null);
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    // Rotate a fresh startup tip for the welcome splash (ON by default; persisted preference).
    if (isTipsEnabled()) setStartupTip(formatTip(advanceTip()));
    if (!anyProviderKeyPresent()) {
      cbRef.current.pushMessage({
        role: "tool",
        toolName: "setup",
        text: `No model-provider API key set — set one to run models: ${keyHint("anthropic")} (or OPENAI/GOOGLE/OPENROUTER). \`/auth\` configures routing only.`,
      });
    }
    // A keymap file that could not be honoured says so ONCE, here. Every problem already
    // names the action it cost and the default it kept, so this never blocks anything —
    // the affected keys simply are what they always were.
    const keymapTrouble = keymapProblems();
    if (keymapTrouble.length > 0) {
      cbRef.current.pushMessage({
        role: "tool",
        toolName: "keymap",
        text: `⚠ ${keymapPath()}\n${keymapTrouble.map((p) => `  • ${p}`).join("\n")}`,
      });
    }
    // One-time bootstrap (memoized): the REGISTRY is process-global, so the catalog must
    // not be re-synced mid-run once (sub-)agents can be in flight.
    void refreshCatalogOnce(agent.config)
      .then((n) => {
        if (n > 0) cbRef.current.bumpCatalog();
      })
      .catch(() => {});
    // Budget signals render as chat notices (not stderr — that would corrupt Ink).
    agent.budget?.setOnEvent((e) => {
      if (e.kind === "threshold" || e.kind === "deny") {
        cbRef.current.pushMessage({
          role: "tool",
          text: `${e.kind === "deny" ? "⛔" : "💰"} ${e.note ?? e.kind}`,
          toolName: "budget",
          isError: e.kind === "deny",
        });
      }
      cbRef.current.setBudgetStatus(agent.budget?.status() ?? null);
    });
    cbRef.current.setBudgetStatus(agent.budget?.status() ?? null);
  }, [agent]);
  return startupTip;
}
