/**
 * The front-end contract (src/frontend.ts) — what each front-end declares it fills.
 *
 * The declarations ARE the deliverable: the non-interactive path registering no permission
 * hook was true before this contract existed too, and cost nothing to overlook. These pin the
 * statements so a later change to one has to be a change to the statement.
 *
 * Behaviour is covered where it always was — run-modes.test.ts for the non-interactive path
 * (untouched, deliberately: it is the regression guard that this contract changed nothing),
 * permissions.test.ts and the plan suites for the terminal UI. Nothing here drives a run.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Listener } from "../src/agent/agent.ts";
import type { BeforeToolCall, BeforeToolCallContext } from "../src/agent/tools.ts";
import {
  type PermissionSeam,
  attachPermissionSeam,
  subscribeAgentEvents,
} from "../src/frontend.ts";
import { nonInteractiveFrontEnd } from "../src/run_modes.ts";
import { terminalFrontEnd } from "../src/tui/frontend.ts";
import { readSource } from "./_source.ts";

const PRIOR_ALLOW_VERIFY = process.env.MINIMA_TUI_ALLOW_VERIFY;
afterEach(() => {
  if (PRIOR_ALLOW_VERIFY === undefined) delete process.env.MINIMA_TUI_ALLOW_VERIFY;
  else process.env.MINIMA_TUI_ALLOW_VERIFY = PRIOR_ALLOW_VERIFY;
});

describe("the non-interactive front-end declares today's behaviour", () => {
  test("it registers NO permission hook — a null seam, not an empty one", () => {
    // The absence this contract exists to make visible. Closing it is MUB-249's call, not a
    // side effect of naming the seams: flipping this to a slot is a breaking change to a
    // shipped surface and has to be argued in a ticket of its own.
    expect(nonInteractiveFrontEnd("print").permission).toBeNull();
    expect(nonInteractiveFrontEnd("json").permission).toBeNull();
  });

  test("there is nobody to ask, and nothing to render child events into", () => {
    const front = nonInteractiveFrontEnd("print");
    expect(front.askUser.current).toBeNull();
    expect(front.childEvents.handler).toBeNull();
    expect(front.io.current).toBeNull();
  });

  test("verify consent stays fail-CLOSED unless MINIMA_TUI_ALLOW_VERIFY=1 opts in", () => {
    const consent = nonInteractiveFrontEnd("json").verifyConsent.current;
    delete process.env.MINIMA_TUI_ALLOW_VERIFY;
    expect(consent("bun test")).toBe(false);
    process.env.MINIMA_TUI_ALLOW_VERIFY = "1";
    expect(consent("bun test")).toBe(true);
  });

  test("only --mode json watches the event stream", () => {
    expect(nonInteractiveFrontEnd("json").agentEvents.listener).not.toBeNull();
    // --print reads the final assistant message off the agent once the run is over.
    expect(nonInteractiveFrontEnd("print").agentEvents.listener).toBeNull();
  });
});

describe("the terminal front-end declares slots it fills on mount", () => {
  test("every seam it serves is an EMPTY slot, not an absence", () => {
    const front = terminalFrontEnd();
    expect(front.permission).not.toBeNull();
    expect(front.permission?.current).toBeNull();
    expect(front.askUser.current).toBeNull();
    expect(front.childEvents.handler).toBeNull();
    expect(front.agentEvents.listener).toBeNull();
    expect(front.io.current).toBeNull();
  });

  test("verify consent is fail-closed before the overlay exists to approve anything", () => {
    delete process.env.MINIMA_TUI_ALLOW_VERIFY;
    expect(terminalFrontEnd().verifyConsent.current("bun test")).toBe(false);
  });
});

// The two attachments the bootstrap makes, driven the way it drives them. Both read their
// slot per call — the terminal UI fills its seams on mount, long after the harness attached
// to them, and empties them again on unmount, so a snapshot at attach time would be wrong in
// both directions.
describe("attaching a seam is late-bound in both directions", () => {
  function fakeDispatcher() {
    const hooks: BeforeToolCall[] = [];
    return {
      hooks,
      addBeforeToolCall(hook: BeforeToolCall) {
        hooks.push(hook);
        return () => {
          hooks.splice(hooks.indexOf(hook), 1);
        };
      },
    };
  }
  const CALL = {
    toolCall: { id: "c1", name: "bash", arguments: {} },
    args: {},
    context: {},
  } as unknown as BeforeToolCallContext;

  test("an empty permission slot is no opinion; filling it arms the gate", async () => {
    const dispatcher = fakeDispatcher();
    const seam: PermissionSeam = { current: null };
    const dispose = attachPermissionSeam(dispatcher, seam);
    const hook = dispatcher.hooks[0]!;

    // Pre-mount (and every tool call of a front-end that simply never fills it).
    expect(await hook(CALL)).toBeNull();

    seam.current = async () => ({ block: true, reason: "denied by the overlay" });
    expect(await hook(CALL)).toEqual({ block: true, reason: "denied by the overlay" });

    // Unmount empties the slot: no opinion again, exactly like the hook being gone.
    seam.current = null;
    expect(await hook(CALL)).toBeNull();
    dispose();
    expect(dispatcher.hooks).toHaveLength(0);
  });

  test("the event seam is read per event, not captured at subscribe time", () => {
    const listeners: Listener[] = [];
    const source = {
      subscribe(listener: Listener) {
        listeners.push(listener);
        return () => {
          listeners.splice(listeners.indexOf(listener), 1);
        };
      },
    };
    const seam = { listener: null } as { listener: Listener | null };
    const dispose = subscribeAgentEvents(source, seam);

    const seen: string[] = [];
    seam.listener = (event) => {
      seen.push(event.type);
    };
    for (const l of listeners) l({ type: "agent_start" });
    expect(seen).toEqual(["agent_start"]);

    seam.listener = null;
    for (const l of listeners) l({ type: "turn_start" });
    expect(seen).toEqual(["agent_start"]);
    dispose();
    expect(listeners).toHaveLength(0);
  });
});

// Criterion 2 — no seam is bound outside the contract. The four slots cli/main.ts hands to
// tools and hooks come off the front-end, and the app receives the contract rather than a
// handful of loose refs. Wiring pins, because the alternative (a ref hand-rolled beside the
// contract) type-checks perfectly and is invisible at review.
describe("cli/main.ts takes every seam off the front-end (wiring pins)", () => {
  const main = readSource("cli/main.ts");

  test("the bootstrap-visible seams are the contract's slots", () => {
    expect(main).toContain("const verifyConsentRef = frontEnd.verifyConsent;");
    expect(main).toContain("const childEventRef = frontEnd.childEvents;");
    expect(main).toContain("const askUserRef = frontEnd.askUser;");
    expect(main).toContain(
      "if (frontEnd.permission) attachPermissionSeam(agent, frontEnd.permission);",
    );
  });
});
