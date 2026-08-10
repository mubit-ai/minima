/**
 * `minima acp` — the JSON-RPC-over-stdio server, and the walking skeleton of the editor arc.
 *
 * A third front-end beside the terminal UI and the headless JSON mode, running the SAME harness
 * behind the socket: routing, the tool dispatcher and its hook stacks, the ledger, feedback. That
 * is the arc's load-bearing choice — a reduced embed would have been cheaper, but gate verdicts
 * are the harness's only honest label source, so an editor session that could not produce them
 * would have quietly degraded the evidence base that is the product.
 *
 * ## What this slice serves, and what it does not
 *
 * Registered: `initialize`, `session/new`, `session/prompt`, `session/cancel`. Nothing else, and
 * that is the point of the capabilities block below — a method a later slice has not built is
 * left unregistered, so a client calling it gets a clean method-not-found rather than a
 * half-implementation. Session loading (MUB-243), modes and config options (MUB-245),
 * authentication (MUB-247), and the cost and routing metadata that is this product's whole
 * differentiator (MUB-240) each arrive with their capability, together.
 *
 * ## One session per process
 *
 * A second `session/new` is refused with a clear error, and so is a session for a directory
 * other than the one this process was started in. Serving many sessions is what the protocol
 * expects and is the correct end state, but it means lifting run identity, permission mode and
 * the ambient working directory to be per-session all at once — three load-bearing things, and a
 * refactor that belongs behind a real consumer. Cross-process concurrency is already safe, so a
 * client that wants two threads runs two processes. The limitation is documented in the README.
 *
 * ## A note on the protocol moving
 *
 * Session modes are announced for removal in favour of config options, and several session
 * methods postdate this design. The SDK's generated types are the value here precisely because
 * of that; when the surface moves, the compiler is what finds the call sites.
 */

import { realpathSync } from "node:fs";
import {
  type AgentConnection,
  type AgentContext,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  PROTOCOL_VERSION,
  type PromptRequest,
  type PromptResponse,
  RequestError,
  type SessionUpdate,
  type Stream,
  agent as agentApp,
} from "@agentclientprotocol/sdk";
import type { ContentBlock as AcpContentBlock } from "@agentclientprotocol/sdk";
import { bundleForMode, getMode } from "../agent/modes.ts";
import { AssistantMessage } from "../ai/types.ts";
import { subscribeAgentEvents } from "../frontend.ts";
import type { MinimaAgent } from "../minima/runtime.ts";
import { makeModeGatedBeforeToolCall } from "../tui/permissions.ts";
import { VERSION } from "../version.ts";
import type { AcpFrontEnd } from "./frontend.ts";
import { AcpPermissionBridge } from "./permission.ts";
import { AgentEventSerializer } from "./serializer.ts";

export interface AcpServerDeps {
  agent: MinimaAgent;
  frontEnd: AcpFrontEnd;
  /** The directory this process is bound to — the only `cwd` a session may ask for. */
  cwd: string;
  /** The session's id. The run id, so the ledger and the client's thread store agree. */
  sessionId: () => string;
  /**
   * Run at the top of every prompt, before any model call. The bootstrap uses it to arm the
   * checkpoint hook — a per-PROMPT concern the terminal UI already handles this way, and one an
   * ACP session needs for the same reason: a snapshot per turn, not per session.
   */
  onTurnStart?: () => void;
}

/** What `initialize` advertises. Every `false` here is a later slice, named in the comments. */
export function agentCapabilities(): NonNullable<InitializeResponse["agentCapabilities"]> {
  return {
    // MUB-243. Advertising it before session/load exists would make a reopened editor thread
    // come back empty, which is worse than a client knowing not to offer the button.
    loadSession: false,
    promptCapabilities: {
      // MUB-243 again: images ride with session loading, because advertising them is what makes
      // the resume-drops-images defect reachable, and shipping a known defect into the client
      // most likely to hit it is the alternative that ticket rejects.
      image: false,
      audio: false,
      embeddedContext: false,
    },
    // Acting as an MCP client is out of scope for this arc and owes its own decisions.
    mcpCapabilities: {},
    // list / delete / fork / resume / close: all part of the one-session-per-process
    // limitation above.
    sessionCapabilities: {},
  };
}

/**
 * The prompt's content blocks as one task string.
 *
 * Text and resource links are the protocol's baseline and are the only kinds this slice
 * advertises, so anything else is refused rather than silently dropped — a prompt whose image
 * vanished on the way in produces a model answering a question it cannot see.
 */
export function promptText(blocks: readonly AcpContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "resource_link") {
      // A reference to something in the client's workspace. The file path is what the model can
      // act on with the read tool, so a `file://` link is reduced to the path it names.
      const uri = block.uri;
      parts.push(uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri);
    } else {
      throw RequestError.invalidParams(
        { contentType: block.type },
        `minima advertises text and resource_link prompt content only; got "${block.type}"`,
      );
    }
  }
  return parts.join("\n").trim();
}

/** The last assistant message of the run, if any — carries stop_reason and error_message. */
function lastAssistant(agent: MinimaAgent): AssistantMessage | null {
  const messages = agent.agentState.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m instanceof AssistantMessage) return m;
  }
  return null;
}

/**
 * One ACP session over one harness. Holds every piece of per-connection state so the handler
 * registrations below stay thin.
 */
class AcpSession {
  private client: AgentContext | null = null;
  private sessionId: string | null = null;
  private turnActive = false;
  private cancelled = false;
  private unsubscribe: (() => void) | null = null;

  private readonly serializer: AgentEventSerializer;
  private readonly bridge: AcpPermissionBridge;

  constructor(private readonly deps: AcpServerDeps) {
    this.serializer = new AgentEventSerializer((update) => this.send(update), { cwd: deps.cwd });
    this.bridge = new AcpPermissionBridge({
      sessionId: () => this.sessionId ?? "",
      cwd: deps.cwd,
      request: (params) => {
        if (!this.client) throw new Error("acp: no connection");
        return this.client.request("session/request_permission", params);
      },
    });
  }

  /**
   * Fill the front-end's seams. Called once the connection exists, which is the moment this
   * front-end has a user to ask — the same "on mount" point the terminal UI fills its slots at.
   */
  attach(client: AgentContext): void {
    this.client = client;
    const { frontEnd } = this.deps;
    frontEnd.agentEvents.listener = (event) => this.serializer.handle(event);
    this.unsubscribe = subscribeAgentEvents(this.deps.agent, frontEnd.agentEvents);
    frontEnd.permission.current = async (ctx) => {
      // A fresh gate per call, closing over THIS call's id. Tools can dispatch in parallel, so a
      // bridge holding "the call being prompted for" in a field would label a request with a
      // sibling's id. The mode policy is resolved the same way the terminal UI resolves it, which
      // is what keeps the fully-permissive mode a deliberate local act: it is reachable only
      // through the launch flag, never through a protocol call, because this slice advertises no
      // way to set a mode.
      const gate = makeModeGatedBeforeToolCall({
        state: frontEnd.permissionState,
        promptFn: this.bridge.promptFnFor(ctx.toolCall),
        getBundle: () => bundleForMode(getMode()),
      });
      return gate(ctx);
    };
  }

  detach(): void {
    this.bridge.cancelPending();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.deps.frontEnd.agentEvents.listener = null;
    this.deps.frontEnd.permission.current = null;
    this.client = null;
  }

  private send(update: SessionUpdate): void {
    const sessionId = this.sessionId;
    if (!sessionId || !this.client) return;
    // Fire and forget: the SDK serializes writes in call order, and awaiting the socket here
    // would put client backpressure inside the agent's tool dispatch.
    void this.client.notify("session/update", { sessionId, update }).catch(() => {
      // A dead connection is reported by `connection.closed`; a lost notification is not worth
      // failing a turn that is still producing useful work locally.
    });
  }

  initialize(_params: InitializeRequest): InitializeResponse {
    return {
      // The one version this build speaks. A client asking for something else gets told what we
      // do speak and decides for itself, which is what the protocol asks of both sides.
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "minima", title: "Minima", version: VERSION },
      agentCapabilities: agentCapabilities(),
      // MUB-247 wires the existing browser login to a real method. Until then: none advertised,
      // and missing Minima credentials keep degrading to unrouted operation rather than blocking.
      authMethods: [],
    };
  }

  newSession(params: NewSessionRequest): NewSessionResponse {
    if (this.sessionId) {
      throw RequestError.invalidRequest(
        { existingSessionId: this.sessionId },
        [
          `minima serves one session per process. Session ${this.sessionId} is already open —`,
          "start another `minima acp` process for a second thread (concurrent processes are safe).",
        ].join(" "),
      );
    }
    if (params.mcpServers && params.mcpServers.length > 0) {
      throw RequestError.invalidParams(
        { mcpServers: params.mcpServers.length },
        [
          "minima does not act as an MCP client, so the MCP servers in this request would not be",
          "reachable to the agent. Refusing rather than starting a session whose tools are",
          "silently missing.",
        ].join(" "),
      );
    }
    const requested = realPath(params.cwd);
    const bound = realPath(this.deps.cwd);
    if (requested !== bound) {
      throw RequestError.invalidParams(
        { requested: params.cwd, bound: this.deps.cwd },
        [
          `minima is bound to the directory it was started in (${bound}); this session asked`,
          `for ${requested}. Start \`minima acp\` in that directory instead — the working`,
          "directory is process-wide in this build.",
        ].join(" "),
      );
    }
    this.sessionId = this.deps.sessionId();
    return { sessionId: this.sessionId };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    this.requireSession(params.sessionId);
    if (this.turnActive) {
      // Stricter than the spec, on purpose and only for now: MUB-248 makes a mid-turn prompt the
      // NEXT turn, which is the right answer and needs a queue with its own turn-boundary rules.
      // Until it exists, refusing says so out loud rather than resolving two requests against
      // one turn.
      throw RequestError.invalidRequest(
        {},
        "a turn is already running in this session; cancel it or wait for it to finish",
      );
    }
    const task = promptText(params.prompt);
    if (!task) throw RequestError.invalidParams({}, "prompt carried no text content");

    this.turnActive = true;
    this.cancelled = false;
    this.serializer.startTurn();
    this.deps.onTurnStart?.();
    try {
      await this.deps.agent.promptRouted(task);
    } finally {
      this.turnActive = false;
    }

    // Cancellation is a stop reason, not an error: the run was stopped on purpose and whatever
    // it did before that is real work the client should keep.
    if (this.cancelled) return { stopReason: "cancelled" };

    const failure = this.serializer.streamError ?? errorMessageOf(lastAssistant(this.deps.agent));
    if (failure) {
      // A provider failure produced no answer. `end_turn` would tell the client the turn
      // completed, and none of the stop reasons means "broke"; a protocol error is the honest
      // channel and is what the headless path's non-zero exit already says.
      throw RequestError.internalError({}, failure);
    }
    return { stopReason: "end_turn" };
  }

  cancel(params: CancelNotification): void {
    if (params.sessionId !== this.sessionId) return;
    this.cancelled = true;
    this.deps.agent.abort();
    // A client that cancels owes a `cancelled` outcome on every open permission request, and
    // that path denies. This is the defensive half: a client that forgets would otherwise leave
    // the run blocked on a dialog it has already dismissed, and the turn could never report.
    this.bridge.cancelPending();
  }

  private requireSession(sessionId: string): void {
    if (!this.sessionId) {
      throw RequestError.invalidRequest({}, "no session — call session/new first");
    }
    if (sessionId !== this.sessionId) {
      throw RequestError.invalidParams(
        { sessionId, open: this.sessionId },
        `unknown session ${sessionId}; this process serves ${this.sessionId}`,
      );
    }
  }
}

/** The hard-failure message a finished run carries, or null when it produced an answer. */
function errorMessageOf(last: AssistantMessage | null): string | null {
  if (last?.stop_reason !== "error") return null;
  return last.error_message || "provider error";
}

/** Resolve symlinks so /tmp and /private/tmp compare equal; unresolvable paths compare raw. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Serve one ACP client over `stream`, resolving when the connection closes.
 *
 * `connect` runs the connect handler synchronously, so the front-end's seams are filled before
 * any request can be dispatched — the ordering that lets the permission slot be armed by the
 * time the first tool call reaches the dispatcher.
 */
export function serveAcp(stream: Stream, deps: AcpServerDeps): Promise<void> {
  const session = new AcpSession(deps);
  const app = agentApp({ name: "minima" })
    .onConnect((connection: AgentConnection) => session.attach(connection.client))
    .onRequest("initialize", ({ params }) => session.initialize(params))
    .onRequest("session/new", ({ params }) => session.newSession(params))
    .onRequest("session/prompt", ({ params }) => session.prompt(params))
    .onNotification("session/cancel", ({ params }) => session.cancel(params));
  const connection = app.connect(stream);
  return connection.closed.finally(() => session.detach());
}
