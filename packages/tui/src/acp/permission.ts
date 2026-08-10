/**
 * Tool-call permission, bound to the protocol's permission request.
 *
 * ACP has a user to ask, so this front-end fills seam 1 for real rather than inheriting the
 * non-interactive default of no permission hook at all — that default exists only because a
 * piped run has nobody to ask, and the justification does not carry across.
 *
 * ## The mapping, and the one thing it must not get wrong
 *
 * The harness's three decisions map one-to-one onto three of the protocol's four option kinds:
 *
 *     allow  → allow_once      run this call
 *     always → allow_always    run it and record the grant
 *     deny   → reject_once     refuse this call
 *
 * `reject_always` is deliberately NOT offered. Persisted rejection is state the harness has
 * never had, and adding it here would smuggle a feature in under a protocol mapping: it raises
 * precedence questions against the existing last-matching-rule-wins policy grammar that deserve
 * their own decision. The other rejected alternative was once-only decisions with no
 * persistence at all, which produces exactly the prompt storm persisted grants exist to prevent.
 *
 * **The grant's scope rides in the option's free-text `name`.** This is the part that would be a
 * safety regression if it were wrong. A bash "always" is not a grant over the bash tool — it is a
 * grant over the command families in that one command, so the option reads *"Always allow `pip`
 * commands"*. A read "always" is a grant over one directory tree, so it reads *"Always allow
 * reading /repo/src"*. Rendering either as a bare "always allow" would show the user a smaller
 * promise than the one they are making, and would be worse than what the terminal UI already
 * shows.
 *
 * Crucially, the label is not computed here. It comes off the `PermissionPrompt` that
 * `checkPermission` builds, produced by the same code that records the grant a few lines later.
 * A second derivation living in this file could drift from what is actually granted, and a
 * drifted safety label is worse than no label.
 */

import type {
  PermissionOption,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { ToolCall } from "../ai/types.ts";
import type { PermissionDecision, PermissionPrompt, PromptFn } from "../tui/permissions.ts";
import { titleFor, toolCallLocations, toolKindFor } from "./serializer.ts";

/** Stable option ids. They are ours to choose and the client echoes one back verbatim. */
export const ALLOW_ONCE = "allow-once";
export const ALLOW_ALWAYS = "allow-always";
export const REJECT_ONCE = "reject-once";

/**
 * The options offered for one prompt, scope included.
 *
 * The fallback label is the honest one for the tools whose "always" really is whole-tool:
 * write/edit/apply_patch/todowrite/task record `allowAlways.add(toolName)`. (The edit family's
 * grant additionally re-prompts for a target outside the project directory — the terminal UI
 * labels that case the same way, and matching it is the bar this ticket sets.)
 */
export function permissionOptions(prompt: PermissionPrompt): PermissionOption[] {
  return [
    { optionId: ALLOW_ONCE, name: "Allow once", kind: "allow_once" },
    {
      optionId: ALLOW_ALWAYS,
      name: prompt.alwaysLabel ?? `Always allow ${prompt.toolName}`,
      kind: "allow_always",
    },
    { optionId: REJECT_ONCE, name: `Deny ${prompt.toolName}`, kind: "reject_once" },
  ];
}

/**
 * The client's outcome, as a harness decision.
 *
 * Everything that is not an explicit grant denies. A cancelled outcome is the client telling us
 * the turn is being cancelled while this request was open; an unrecognised option id is a client
 * bug or a protocol drift. Neither is a reason to run the call.
 */
export function decisionForOutcome(outcome: RequestPermissionOutcome): PermissionDecision {
  if (outcome.outcome !== "selected") return "deny";
  if (outcome.optionId === ALLOW_ONCE) return "allow";
  if (outcome.optionId === ALLOW_ALWAYS) return "always";
  return "deny";
}

/** The permission request for one pending call. */
export function permissionRequest(
  sessionId: string,
  toolCall: ToolCall,
  prompt: PermissionPrompt,
  cwd: string,
): RequestPermissionRequest {
  const args = prompt.args ?? null;
  const update: ToolCallUpdate = {
    toolCallId: toolCall.id,
    title: titleFor(toolCall.name, args),
    name: toolCall.name,
    kind: toolKindFor(toolCall.name),
    status: "pending",
    ...(args ? { rawInput: args } : {}),
    locations: toolCallLocations(toolCall.name, args, cwd),
    // What the terminal UI puts on screen before the user decides — the diff, or the plan's
    // verify commands rendered as the shell they are. Carried as text because that is the shape
    // the harness already produces; a structured `diff` block would show a nicer view and is a
    // refinement, not a different decision.
    ...(prompt.diffPreview
      ? {
          content: [
            {
              type: "content" as const,
              content: { type: "text" as const, text: prompt.diffPreview },
            },
          ],
        }
      : {}),
  };
  return { sessionId, toolCall: update, options: permissionOptions(prompt) };
}

export interface PermissionBridgeDeps {
  sessionId: () => string;
  cwd: string;
  /** Sends `session/request_permission` and resolves with the client's answer. */
  request: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}

/**
 * Turns the harness's prompt seam into protocol round-trips.
 *
 * One bridge per session; one {@link promptFnFor} per pending tool call. Binding the tool call
 * into the closure rather than into a field is not style — tools can dispatch in parallel, so a
 * shared "call currently being prompted for" would attach the wrong id to a request under
 * exactly the concurrency the harness supports.
 */
export class AcpPermissionBridge {
  /** Every prompt still waiting on the client, so cancellation can settle them. */
  private readonly pending = new Set<(decision: PermissionDecision) => void>();

  constructor(private readonly deps: PermissionBridgeDeps) {}

  /** How many requests are still open — the cancellation path's only observable. */
  get pendingCount(): number {
    return this.pending.size;
  }

  promptFnFor(toolCall: ToolCall): PromptFn {
    return (prompt: PermissionPrompt) => {
      let settled = false;
      const settle = (decision: PermissionDecision): void => {
        if (settled) return;
        settled = true;
        this.pending.delete(settle);
        prompt.resolve(decision);
      };
      this.pending.add(settle);
      void this.deps
        .request(permissionRequest(this.deps.sessionId(), toolCall, prompt, this.deps.cwd))
        .then((response) => settle(decisionForOutcome(response.outcome)))
        // A transport failure, a client that never answers, a connection that closed
        // mid-decision: all of them deny. The alternative — leaving the promise pending —
        // wedges the turn on a question nobody will answer.
        .catch(() => settle("deny"));
    };
  }

  /**
   * Settle every open request as denied.
   *
   * A well-behaved client resolves its pending permission requests as cancelled when it cancels
   * a turn, and that path already lands on "deny" through {@link decisionForOutcome}. This is
   * the defensive half: a client that cancels and simply forgets would otherwise leave the run
   * blocked on a dialog it has already dismissed, and the turn could never report `cancelled`.
   */
  cancelPending(): void {
    for (const settle of [...this.pending]) settle("deny");
  }
}
