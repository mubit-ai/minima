/**
 * The terminal UI's half of the front-end contract.
 *
 * Every seam it fills closes over mounted React state, so all this builds is the empty slots;
 * HarnessApp fills them on mount and empties them on unmount. That is what cli/main.ts already
 * did with three hand-rolled refs — what changes is that the set is now named and countable,
 * and that the app fills the contract's slots rather than refs only its own call site knew of.
 *
 * The one seam with a value before the tree mounts is verify consent: a plan's verify commands
 * are model-authored shell, so until there is an overlay to approve them the same fail-closed
 * checker the non-interactive path keeps forever holds the slot. The app swaps in its
 * permission-state-backed checker on mount and puts this one back on unmount.
 */

import type { PromptingFrontEnd } from "../frontend.ts";
import { headlessVerifyConsent } from "../minima/big_plan.ts";

export function terminalFrontEnd(): PromptingFrontEnd {
  return {
    name: "terminal",
    permission: { current: null },
    askUser: { current: null },
    verifyConsent: { current: headlessVerifyConsent() },
    childEvents: { handler: null },
    agentEvents: { listener: null },
    io: { current: null },
  };
}
