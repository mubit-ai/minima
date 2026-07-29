/**
 * Seam-wiring hooks lifted out of app.tsx.
 *
 * Every hook here is the same shape: while the TUI is mounted, install a handler into an
 * externally-held ref (or register an agent hook), and restore/dispose on unmount. Extraction
 * only — the bodies are the effects that used to live inline in HarnessApp, unchanged.
 */

import { useEffect, useRef, useState } from "react";
import { bundleForMode, getMode } from "../agent/modes.ts";
import { emitGuardEvent } from "../agent/policy.ts";
import type { BeforeToolCall } from "../agent/tools.ts";
import type { VerifyConsent } from "../minima/big_plan.ts";
import type { MinimaAgent } from "../minima/runtime.ts";
import type { ChildEvent } from "../minima/spawn.ts";
import { makeCheckpointHook } from "../session/checkpoint.ts";
import type { AskUserRef } from "../tools/question.ts";
import type { QuestionPromptData } from "./app.tsx";
import { type ChildRow, applyChildEvent } from "./child_tree.tsx";
import type { ChatMessage } from "./messages.tsx";
import {
  type PermissionPrompt,
  type PermissionState,
  formatActionLabel,
  makeModeGatedBeforeToolCall,
  planModeBlockReason,
  planModeBlockedTools,
} from "./permissions.ts";

/** Wire the sub-agent event feed so ChildTree stays live during multi-step runs. */
export function useChildTree(
  childEventRef: { handler: ((e: ChildEvent) => void) | null } | undefined,
): Map<string, ChildRow> {
  const [childrenState, setChildrenState] = useState<Map<string, ChildRow>>(new Map());
  useEffect(() => {
    if (!childEventRef) return;
    childEventRef.handler = (e: ChildEvent) => {
      setChildrenState((prev) => {
        const next = new Map(prev);
        next.set(e.childId, applyChildEvent(next.get(e.childId), e));
        return next;
      });
    };
    return () => {
      childEventRef.handler = null;
    };
  }, [childEventRef]);
  return childrenState;
}

/**
 * MP18: swap the plan hooks' consent seam to the overlay-backed checker while the TUI is
 * mounted. Consent keys on the exact command string; bypass mode is blanket consent
 * (acceptEdits needs no case — todowrite is not in its auto bundle, so unseen verifies
 * still prompt). Unmount restores the headless fail-closed default.
 */
export function useVerifyConsent(
  verifyConsentRef: { current: VerifyConsent } | undefined,
  permStateRef: React.MutableRefObject<PermissionState>,
): void {
  useEffect(() => {
    if (!verifyConsentRef) return;
    const headless = verifyConsentRef.current;
    verifyConsentRef.current = (cmd) =>
      getMode() === "bypass" || permStateRef.current.approvedVerifies.has(cmd);
    return () => {
      verifyConsentRef.current = headless;
    };
  }, [verifyConsentRef, permStateRef]);
}

/** `question` tool overlay: the tool awaits a promise resolved by the overlay in the render tree. */
export function useQuestionPrompt(
  askUserRef: AskUserRef | undefined,
): [QuestionPromptData | null, React.Dispatch<React.SetStateAction<QuestionPromptData | null>>] {
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
  return [questionPrompt, setQuestionPrompt];
}

/**
 * Wire the beforeToolCall permission hook, then the plan done-gate (when on) so
 * permission always runs first — first block wins, and no gate check ever executes for a
 * call the user declines.
 *
 * Plan mode DENIES at the dispatcher (Claude Code parity, 2026-07-20 — supersedes the B2
 * ask-every-time flow): the FULL planModeBlockedTools list (permissions.ts, single tested
 * source) hard-blocks with the exit_plan-steering reason, audited as mode-deny. Everything
 * else resolves through the active mode's PolicyBundle (accept-edits auto is cwd-scoped
 * inside the hook), then the normal permission flow.
 *
 * Returns the checkpoint arm callback (null while unmounted) — /ckpt and onSubmit call it.
 */
export function useToolCallHooks(opts: {
  agent: MinimaAgent;
  bigPlanGateBefore?: BeforeToolCall | null;
  resolveRepoTop: () => string | null;
  permStateRef: React.MutableRefObject<PermissionState>;
  setPermPrompt: (p: PermissionPrompt) => void;
  pushMessage: (m: ChatMessage) => void;
}): React.MutableRefObject<(() => void) | null> {
  const { agent, bigPlanGateBefore, resolveRepoTop, permStateRef, setPermPrompt, pushMessage } =
    opts;
  const checkpointArmRef = useRef<(() => void) | null>(null);
  // Stable seam for the callbacks so the hook stack re-registers on `agent` identity only —
  // re-registering per render would reorder permission/checkpoint/gate against each other.
  const cbRef = useRef({ setPermPrompt, pushMessage });
  cbRef.current = { setPermPrompt, pushMessage };
  useEffect(() => {
    const modeGated = makeModeGatedBeforeToolCall({
      state: permStateRef.current,
      promptFn: (prompt) => cbRef.current.setPermPrompt(prompt),
      getBundle: () => bundleForMode(getMode()),
    });
    const disposePermission = agent.addBeforeToolCall(async (ctx) => {
      if (getMode() === "plan") {
        const bigPlanOn = agent.config.bigPlan === true;
        if (planModeBlockedTools(bigPlanOn).includes(ctx.toolCall.name)) {
          emitGuardEvent({
            kind: "mode-deny",
            detail: formatActionLabel(ctx.toolCall.name, ctx.args),
          });
          return { block: true, reason: planModeBlockReason(ctx.toolCall.name, bigPlanOn) };
        }
      }
      return modeGated(ctx);
    });
    // B3: checkpoint snapshot rides between the permission gate (a denied call must not
    // snapshot) and the plan done-gate (a done-gate block after a snapshot is harmless — deduped by
    // tree). Same effect as its neighbors: a separate effect with different deps would lose
    // the relative order on re-registration.
    const ckpt = makeCheckpointHook({
      top: resolveRepoTop,
      db: agent.db ?? null,
      getRunId: () => agent.runId,
      getStepId: () => {
        if (agent.config.bigPlan !== true || !agent.db || !agent.runId) return null;
        const plan = agent.db.getActivePlan(agent.runId);
        return plan ? (agent.db.getInProgressStep(plan.id)?.id ?? null) : null;
      },
      notify: (message) =>
        cbRef.current.pushMessage({ role: "tool", text: message, toolName: "ckpt" }),
    });
    checkpointArmRef.current = ckpt.arm;
    const disposeCkpt = agent.addBeforeToolCall(ckpt.hook);
    const disposeGate = bigPlanGateBefore ? agent.addBeforeToolCall(bigPlanGateBefore) : null;
    return () => {
      disposeGate?.();
      disposeCkpt();
      checkpointArmRef.current = null;
      disposePermission();
    };
  }, [agent, bigPlanGateBefore, resolveRepoTop, permStateRef]);
  return checkpointArmRef;
}
