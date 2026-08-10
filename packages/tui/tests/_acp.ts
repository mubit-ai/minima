/**
 * THE ARC'S ONE TEST SEAM — an in-process ACP client over a duplex stream pair.
 *
 * Every slice of the ACP arc (MUB-239 onward) asserts through here, so this file is as much
 * the deliverable as the server is. The rule it exists to enforce: **a good test at this
 * boundary asserts only what a real client could observe.** The protocol boundary is a process
 * boundary, so a test that reaches past it — inspecting the server's session object, calling a
 * serializer directly, reading the permission state — is testing an implementation detail by
 * definition, and will keep passing after the wire has broken.
 *
 * What that buys, concretely:
 *
 *   1. **The callback direction is covered.** The client RESPONDS: it answers
 *      `session/request_permission` with a real decision, and later slices will serve
 *      `fs/read_text_file` and answer elicitation the same way. Golden frames structurally
 *      cannot reach this — a recording of what the agent emitted says nothing about what
 *      happens when the client answers "deny". That asymmetry is the whole reason a
 *      round-trip client exists alongside the snapshots.
 *   2. **The bytes are real.** The two sides are joined by newline-delimited JSON over byte
 *      streams — `ndJsonStream`, exactly what stdio uses — not by handing message objects
 *      across. Every frame this harness records was serialized, framed, and parsed back. A
 *      field that only survives because both sides share a TypeScript type would not.
 *   3. **The harness underneath is real.** A real `MinimaAgent`, a real `MinimaDb` on a temp
 *      path, the real tool dispatcher and hook stacks. Only three things are faked, and each
 *      is an existing seam with existing prior art: the provider (the faux provider's scripted
 *      responses), the service (`fetch` mocked from the typed `_service.ts` wire builders), and
 *      the clock-free ids normalized on the way out.
 *
 * Hermetic without exception: no network, no spend.
 *
 * Prior art this composes: `acceptance-e2e.test.ts` (agent + db + tools in process),
 * `permissions.test.ts` (driving the prompt seam with plain functions), and
 * `tool-schemas.test.ts` (golden snapshots of a contract shape).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Client,
  type ClientContext,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
  client as clientApp,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { acpFrontEnd, serveAcp } from "../src/acp/index.ts";
import type { AcpFrontEnd } from "../src/acp/index.ts";
import type { AgentTool } from "../src/agent/tools.ts";
import {
  type AssistantMessage,
  type Model,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
} from "../src/ai/index.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { attachPermissionSeam } from "../src/frontend.ts";
import {
  ConstJudge,
  CostMeter,
  type HarnessConfig,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";
import { VERSION } from "../src/version.ts";
import { feedbackResponse, recommendResponse } from "./_service.ts";

/** The model every harness run routes to, unless a test registers its own. */
export const ACP_MODEL: Model = {
  id: "acp-faux",
  provider: "faux",
  api: "faux",
  name: "ACP Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/** One direction of the pipe, with every byte that crossed it kept as parsed frames. */
interface TappedDirection {
  writable: WritableStream<Uint8Array>;
  readable: ReadableStream<Uint8Array>;
  frames: Record<string, unknown>[];
}

/**
 * A byte pipe that records the newline-delimited JSON frames passing through it.
 *
 * Recording HERE rather than at either endpoint is deliberate: the frames a test snapshots are
 * the ones that were actually serialized and shipped, so a field lost in encoding shows up as a
 * missing frame field rather than passing on the strength of a shared type.
 */
function tappedPipe(): TappedDirection {
  const frames: Record<string, unknown>[] = [];
  let partial = "";
  const decoder = new TextDecoder();
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      partial += decoder.decode(chunk, { stream: true });
      let newline = partial.indexOf("\n");
      while (newline !== -1) {
        const line = partial.slice(0, newline).trim();
        partial = partial.slice(newline + 1);
        if (line) {
          try {
            frames.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // A malformed line is the SDK's problem to report; the tap never fails a run.
          }
        }
        newline = partial.indexOf("\n");
      }
      controller.enqueue(chunk);
    },
  });
  return { writable: tap.writable, readable: tap.readable, frames };
}

/**
 * Two ACP `Stream`s wired mouth-to-mouth over ndJSON, as a spawned process's stdio would be.
 * `agentToClient` holds everything the agent emitted — the golden-frame source.
 */
export function acpDuplexPair(): {
  agentStream: Stream;
  clientStream: Stream;
  agentToClient: Record<string, unknown>[];
  clientToAgent: Record<string, unknown>[];
  closeClientEnd(): Promise<void>;
} {
  const down = tappedPipe(); // agent -> client
  const up = tappedPipe(); // client -> agent
  return {
    agentStream: ndJsonStream(down.writable, up.readable),
    clientStream: ndJsonStream(up.writable, down.readable),
    agentToClient: down.frames,
    clientToAgent: up.frames,
    /**
     * Break the pipe at the client's end — what the OS does for a real session when the editor
     * process exits and its stdio fds close, and the signal `serveAcp` resolves on.
     *
     * It has to reach the BYTE stream. `ndJsonStream` builds its writable from a `write` handler
     * alone, so closing the `Stream.writable` it hands back never propagates to the transport
     * underneath it, and the agent's reader would sit waiting for a frame that is never coming.
     */
    closeClientEnd: async () => {
      try {
        await up.writable.getWriter().close();
      } catch {
        // Already closed, or a write still holds the lock — either way the pipe is going away.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * How the test client answers `session/request_permission`. Returning an option KIND rather
 * than an option id is what keeps a test honest about the ticket's central safety claim: the
 * client must pick from the options the agent actually offered, so a test that asks for
 * `allow_always` fails outright if the agent never offered one — which is exactly the
 * regression an unscoped or missing "always" would be.
 *
 * `"cancelled"` exercises the outcome a client owes for a permission request still open when
 * the turn is cancelled.
 */
export type PermissionAnswer = "allow_once" | "allow_always" | "reject_once" | "cancelled";

/** Decides one permission request; `index` counts requests within this session, from 0. */
export type PermissionDecider = (
  request: RequestPermissionRequest,
  index: number,
) => PermissionAnswer | Promise<PermissionAnswer>;

/**
 * The in-process editor. Records what it was told, answers what it was asked.
 *
 * Deliberately NOT a mock framework: a real client is a small object with a handful of
 * methods, and writing it out means the test reads like the thing it is standing in for.
 */
/** One permission request as the client saw it. `answered` stays null while the user decides. */
export interface SeenPermissionRequest {
  request: RequestPermissionRequest;
  answered: PermissionAnswer | null;
}

export class AcpTestClient implements Client {
  /** Every `session/update` notification, in arrival order. */
  readonly updates: SessionNotification[] = [];
  /**
   * Every permission request received, in arrival order. Recorded on ARRIVAL, not on answer —
   * a test that waits for "the agent is asking" needs to see the request while the dialog is
   * still open, which is exactly the state cancellation has to settle.
   */
  readonly permissionRequests: SeenPermissionRequest[] = [];

  constructor(private readonly decide: PermissionDecider = () => "allow_once") {}

  sessionUpdate(params: SessionNotification): void {
    this.updates.push(params);
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const seen: SeenPermissionRequest = { request: params, answered: null };
    const index = this.permissionRequests.length;
    this.permissionRequests.push(seen);
    const answer = await this.decide(params, index);
    seen.answered = answer;
    if (answer === "cancelled") return { outcome: { outcome: "cancelled" } };
    const option = params.options.find((o) => o.kind === answer);
    if (!option) {
      // Not a mock's convenience failure — this IS the assertion. An agent that stopped
      // offering a scoped "always" would otherwise pass every behavioural test in the arc.
      throw new Error(
        `no permission option of kind "${answer}" was offered (got: ${params.options
          .map((o) => `${o.kind}:${o.name}`)
          .join(", ")})`,
      );
    }
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }

  /** Text of every `agent_message_chunk`, concatenated — the reply as the user would read it. */
  get assistantText(): string {
    return this.updates
      .map((u) => u.update)
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u.content.type === "text" ? u.content.text : ""))
      .join("");
  }

  /** Text of every `agent_thought_chunk`, concatenated. */
  get thoughtText(): string {
    return this.updates
      .map((u) => u.update)
      .filter((u) => u.sessionUpdate === "agent_thought_chunk")
      .map((u) => (u.content.type === "text" ? u.content.text : ""))
      .join("");
  }

  /** Only the updates of one kind, narrowed. */
  updatesOfKind<K extends SessionNotification["update"]["sessionUpdate"]>(
    kind: K,
  ): Extract<SessionNotification["update"], { sessionUpdate: K }>[] {
    return this.updates
      .map((u) => u.update)
      .filter((u): u is Extract<SessionNotification["update"], { sessionUpdate: K }> => {
        return u.sessionUpdate === kind;
      });
  }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** A captured `/v1/*` exchange plus the payloads, so a test can assert the learning loop. */
export interface MockService {
  fetchLike: (
    url: string,
    init?: { method?: string; body?: string },
  ) => Promise<{
    status: number;
    json: () => Promise<unknown>;
  }>;
  recommendCalls: Record<string, unknown>[];
  feedbackCalls: Record<string, unknown>[];
}

/**
 * `/v1/recommend` + `/v1/feedback` over the TYPED wire builders, so a contract change breaks
 * this at compile time rather than at read-undefined time. Transport stays here (each test file
 * sequences differently); only the payload SHAPE is shared — see `_service.ts`.
 */
export function acpMockService(modelId = ACP_MODEL.id): MockService {
  const recommendCalls: Record<string, unknown>[] = [];
  const feedbackCalls: Record<string, unknown>[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    if (method === "POST" && u.pathname === "/v1/recommend") {
      recommendCalls.push(init?.body ? JSON.parse(init.body) : {});
      return {
        status: 200,
        json: async () =>
          recommendResponse({
            recommendation_id: `rec-${recommendCalls.length}`,
            recommended_model: { model_id: modelId, provider: "faux" },
            decision_basis: "memory",
          }) as unknown,
      };
    }
    if (method === "POST" && u.pathname === "/v1/feedback") {
      feedbackCalls.push(init?.body ? JSON.parse(init.body) : {});
      return { status: 200, json: async () => feedbackResponse() as unknown };
    }
    return { status: 404, json: async () => ({ detail: "not found" }) };
  };
  return { fetchLike, recommendCalls, feedbackCalls };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export interface AcpHarnessOptions {
  /** Scripted provider turns, in order. */
  responses?: AssistantMessage[];
  /** How the client answers permission requests (default: allow once). */
  permissions?: PermissionDecider;
  /** Harness config overrides, merged over the hermetic defaults below. */
  config?: Partial<HarnessConfig>;
  /** Extra models to register alongside {@link ACP_MODEL}. */
  models?: Model[];
  /**
   * The real tools this run may dispatch. Empty by default: a tool a test did not ask for is a
   * tool whose permission prompt it is not expecting, and an unregistered name fails at dispatch
   * without ever reaching the permission seam — which reads like "the gate allowed it".
   */
  tools?: AgentTool[];
}

/** What the body of a harness run gets to work with. */
export interface AcpHarness {
  /**
   * The client's handle on the agent. `request("session/new", …)`, `request("session/prompt", …)`
   * and `notify("session/cancel", …)` are typed by method name — the same calls a real editor
   * makes, spelled the same way.
   */
  readonly connection: ClientContext;
  readonly client: AcpTestClient;
  readonly agent: MinimaAgent;
  readonly db: MinimaDb;
  readonly frontEnd: AcpFrontEnd;
  readonly service: MockService;
  /** The temp directory this run is bound to — the session's only legal `cwd`. */
  readonly cwd: string;
  /** Every frame the agent put on the wire, parsed. See {@link goldenFrames}. */
  readonly emitted: Record<string, unknown>[];
  /** Queue more provider turns mid-run (a second prompt, say). */
  setResponses(responses: AssistantMessage[]): void;
}

/**
 * Stand up a complete ACP session against a real harness, run `body`, and tear everything down.
 *
 * The registry resets and the `finally` are not ceremony: the ai registries are process-global
 * singletons, so a harness that leaked one would make the NEXT test file's failures depend on
 * file ordering. Prior art: `acceptance-e2e.test.ts`.
 *
 * The working directory is a fresh temp dir, and the PROCESS moves into it for the duration.
 * That is not test convenience — it is the production shape: `minima acp` is launched by the
 * editor in the workspace it is about to serve, so the session's `cwd`, the directory the
 * permission state scopes grants against, and the directory tools and shell commands resolve
 * against are all one directory. A harness that let them differ would quietly make relative
 * paths mean two things, and later slices (client-owned IO, the plan spine's verify commands)
 * assert on exactly that agreement. `process.chdir` has prior art here — see `gate.test.ts`.
 */
export async function withAcpHarness<T>(
  opts: AcpHarnessOptions,
  body: (h: AcpHarness) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "acp-seam-"));
  const previousCwd = process.cwd();
  process.chdir(dir);
  const db = new MinimaDb(join(dir, "acp.db"));
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  const models = [ACP_MODEL, ...(opts.models ?? [])];
  for (const m of models) registerModel(m);
  const reg = registerFauxProvider(models);
  reg.setResponses(opts.responses ?? []);

  const service = acpMockService();
  const config = harnessConfig({
    candidates: [ACP_MODEL.id],
    allowOffline: false,
    minimaApiKey: "test-key",
    // Off by default across the seam: each is a later slice's subject, and leaving them on
    // would let this file's frames drift whenever an unrelated feature changed.
    bigPlan: false,
    memoryLedger: false,
    artifacts: false,
    bgJobs: false,
    stopStrikes: 0,
    judgeSampleRate: 0,
    ...opts.config,
  });
  const agent = new MinimaAgent({
    config,
    router: new MinimaRouter({
      client: new MinimaClient({ baseUrl: "http://acp.test", fetch: service.fetchLike }),
      config,
      mapping: new ModelMapping(),
    }),
    meter: new CostMeter(),
    judge: new ConstJudge(null),
    tools: opts.tools ?? [],
  });
  db.ensureProject("acp-test");
  const runId = db.startRun({ projectKey: "acp-test" });
  agent.db = db;
  agent.runId = runId;

  const frontEnd = acpFrontEnd({ cwd: dir, bigPlan: config.bigPlan === true });
  // Mirrors cli/main.ts: the bootstrap puts the front-end's permission seam on the dispatcher's
  // hook stack. Doing it here rather than inside serveAcp keeps the production wiring the thing
  // under test instead of something only the harness knows how to do.
  attachPermissionSeam(agent, frontEnd.permission);

  const { agentStream, clientStream, agentToClient, closeClientEnd } = acpDuplexPair();
  const client = new AcpTestClient(opts.permissions);
  const closed = serveAcp(agentStream, { agent, frontEnd, cwd: dir, sessionId: () => runId });
  const clientConnection = clientApp({ name: "acp-test-client" })
    .onRequest("session/request_permission", ({ params }) => client.requestPermission(params))
    .onNotification("session/update", ({ params }) => client.sessionUpdate(params))
    .connect(clientStream);

  try {
    return await body({
      connection: clientConnection.agent,
      client,
      agent,
      db,
      frontEnd,
      service,
      cwd: dir,
      emitted: agentToClient,
      setResponses: (responses) => reg.setResponses(responses),
    });
  } finally {
    // What a real editor exiting looks like: the client end of the pipe closes, the agent's
    // readable ends, and `serveAcp` resolves. Closing the client CONNECTION alone is not enough —
    // it cancels the client's reader without ending the stream the agent is reading, which is
    // precisely the shutdown bug this teardown would otherwise hide. The bounded race turns a
    // server that never shuts down into a slow test rather than a suite that hangs after green.
    clientConnection.close();
    await closeClientEnd();
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 2000))]);
    reg.unregister();
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    db.close();
    // Restore before the directory goes away: a process sitting in a deleted cwd makes every
    // later test file fail somewhere far from here.
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Golden frames
// ---------------------------------------------------------------------------

/**
 * The emitted frames, with everything that legitimately varies between runs replaced by a
 * stable token: the run id, the temp directory, the JSON-RPC request id, and the harness
 * version.
 *
 * That list is deliberately short and named item by item. A blanket "strip anything that
 * changed" would quietly absorb a real regression the first time the wire format moved, which
 * is the exact failure golden frames exist to catch. Note what is NOT stripped — the VALUES are
 * replaced, never the keys, so a frame that stopped carrying `version` or `sessionId` at all
 * still shows up as a diff.
 */
export function goldenFrames(
  frames: Record<string, unknown>[],
  subs: { sessionId?: string; cwd?: string } = {},
): unknown[] {
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      if (subs.sessionId) out = out.split(subs.sessionId).join("<session>");
      if (subs.cwd) out = out.split(subs.cwd).join("<cwd>");
      // Always: `agentInfo.version` is the running harness version, so leaving it in would make
      // every release bump look like a protocol change and train reviewers to re-bless diffs.
      out = out.split(VERSION).join("<version>");
      return out;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // The JSON-RPC id is transport bookkeeping, not contract: it counts requests, so an
        // added round-trip anywhere upstream would otherwise renumber every later frame.
        obj[k] = k === "id" ? "<id>" : replace(v);
      }
      return obj;
    }
    return value;
  };
  return frames.map(replace);
}
