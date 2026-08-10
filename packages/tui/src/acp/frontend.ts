/**
 * The editor transport's half of the front-end contract (frontend.ts).
 *
 * Third implementation after the terminal UI and the non-interactive run modes. Like the
 * terminal UI, most of what it fills closes over a connection that does not exist yet, so this
 * builds the slots and `serveAcp` fills them once the client is on the other end — the same
 * late binding the contract was written for, and the reason every seam is a mutable slot.
 *
 * What it declares, seam by seam:
 *
 *   permission — a real slot, and a real permission STATE behind it. This front-end has a user
 *     to ask, so it prompts; see acp/permission.ts for the decision mapping and why the
 *     grant's scope has to reach the option label.
 *   askUser — null for now. The `question` tool's ladder over the protocol (elicitation when
 *     the client advertises it, a synthesized permission request when not) is MUB-248's
 *     subject, and dressing every question up as an approve/deny dialog in the meantime is the
 *     alternative that ticket rejects. Until then the tool tells the model to proceed on its
 *     best assumption — the same answer the non-interactive path gives, for the same reason.
 *   verifyConsent — the fail-CLOSED checker, unchanged. MUB-242 is where an editor session
 *     starts running its plan-spine gates, and it carries an ADR to do it: a gate approved
 *     through a remote client is a new trust claim, not a wiring detail. That slice replaces
 *     this slot with a lookup against the permission state built here, which is why the state
 *     is threaded out below rather than hidden.
 *   childEvents — null. Sub-agent progress over the protocol is MUB-246; a delegated child's
 *     result still returns through the task tool, so today a long delegation is quiet rather
 *     than lost.
 *   agentEvents — the slot the serializer occupies for the life of the connection.
 *   io — null: this build reads and writes the working tree directly. Routing file IO through
 *     the client is MUB-241, and it is contingent on a probe that has not been run.
 */

import type { PromptingFrontEnd } from "../frontend.ts";
import { headlessVerifyConsent } from "../minima/big_plan.ts";
import { type PermissionState, createPermissionState } from "../tui/permissions.ts";

/** The ACP front-end, plus the permission state its seam decides against. */
export interface AcpFrontEnd extends PromptingFrontEnd {
  readonly name: "acp";
  /**
   * Session-scoped grants: directories approved for reading, bash command families, whole-tool
   * "always" grants, and the verify commands the user has seen. Exposed because it is the state
   * MUB-242 reads to let an approved verification command count as consent, and because a test
   * asserting a grant persisted is asserting against the thing that actually holds it.
   */
  readonly permissionState: PermissionState;
}

export interface AcpFrontEndOptions {
  /** The session's working directory — the scope for directory and edit-family grants. */
  cwd: string;
  /** Plan verification on? Changes how a todowrite's verify commands are described and gated. */
  bigPlan: boolean;
  /** Project key for persisted bash grants; omit to keep grants session-only. */
  projectKey?: string;
}

export function acpFrontEnd(opts: AcpFrontEndOptions): AcpFrontEnd {
  const permissionState = createPermissionState(opts.cwd, {
    bigPlan: opts.bigPlan,
    ...(opts.projectKey ? { projectKey: opts.projectKey } : {}),
  });
  return {
    name: "acp",
    permission: { current: null },
    askUser: { current: null },
    verifyConsent: { current: headlessVerifyConsent() },
    childEvents: { handler: null },
    agentEvents: { listener: null },
    io: { current: null },
    permissionState,
  };
}
