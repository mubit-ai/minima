/**
 * MUB-239 — the walking skeleton, driven the way a real editor drives it.
 *
 * Every assertion here is something a client could observe from the far side of the pipe:
 * responses to its own requests, notifications it received, and the questions it was asked.
 * Nothing reaches into the server's session object, and nothing calls the serializer directly —
 * a test that could do either would keep passing after the wire broke.
 *
 * The companion file `acp-frames.test.ts` snapshots the emitted frames. Both are needed: golden
 * frames cannot reach the callback direction, and this file cannot notice a renamed field that
 * every assertion here happens to read through a helper.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantMessage, text, thinking, toolCall } from "../src/ai/index.ts";
import { bashTool } from "../src/tools/bash.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import { ACP_MODEL, type AcpHarness, type PermissionAnswer, withAcpHarness } from "./_acp.ts";

/** The two calls every session opens with. Returns the session id the agent minted. */
async function openSession(h: AcpHarness): Promise<string> {
  await h.connection.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  const created = await h.connection.request("session/new", { cwd: h.cwd, mcpServers: [] });
  return created.sessionId;
}

const reply = (t: string) => new AssistantMessage({ content: [text(t)] });
const calls = (...tcs: ReturnType<typeof toolCall>[]) =>
  new AssistantMessage({ content: tcs, stop_reason: "toolUse" });

describe("acp — initialize and capability negotiation", () => {
  test("advertises only what this slice built", async () => {
    await withAcpHarness({}, async (h) => {
      const res = await h.connection.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });

      expect(res.protocolVersion).toBe(1);
      expect(res.agentInfo?.name).toBe("minima");
      expect(res.agentInfo?.version).toBeString();
      // Honest negotiation is acceptance criterion 2 — every one of these is a later slice, and
      // a `true` here would make a client offer a button that does nothing.
      expect(res.agentCapabilities?.loadSession).toBe(false);
      expect(res.agentCapabilities?.promptCapabilities?.image).toBe(false);
      expect(res.agentCapabilities?.promptCapabilities?.audio).toBe(false);
      expect(res.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(false);
      expect(res.agentCapabilities?.mcpCapabilities).toEqual({});
      expect(res.agentCapabilities?.sessionCapabilities).toEqual({});
      // Authentication arrives with MUB-247; advertising a method we cannot service would make
      // a client show a sign-in flow that dead-ends.
      expect(res.authMethods).toEqual([]);
    });
  });

  test("a method this build does not serve answers method-not-found, not a crash", async () => {
    await withAcpHarness({}, async (h) => {
      await openSession(h);
      // session/load is unregistered because `loadSession` is advertised false. A client that
      // ignores the capability gets a clean protocol error and stays connected — which the
      // prompt below proves.
      await expect(
        h.connection.request("session/load", { sessionId: "whatever", cwd: h.cwd, mcpServers: [] }),
      ).rejects.toThrow();

      h.setResponses([reply("still here")]);
      const res = await h.connection.request("session/prompt", {
        sessionId: h.agent.runId!,
        prompt: [{ type: "text", text: "are you alive?" }],
      });
      expect(res.stopReason).toBe("end_turn");
    });
  });
});

describe("acp — session creation", () => {
  test("session/new returns the run id, so the ledger and the thread agree", async () => {
    await withAcpHarness({}, async (h) => {
      const sessionId = await openSession(h);
      expect(sessionId).toBe(h.agent.runId!);
      expect(h.db.getRun(sessionId)).not.toBeNull();
    });
  });

  test("a second session is refused with a clear, non-crashing error", async () => {
    await withAcpHarness({}, async (h) => {
      const first = await openSession(h);

      let message = "";
      try {
        await h.connection.request("session/new", { cwd: h.cwd, mcpServers: [] });
        throw new Error("expected the second session to be refused");
      } catch (exc) {
        message = exc instanceof Error ? exc.message : String(exc);
      }
      expect(message).toContain("one session per process");
      expect(message).toContain("second thread");

      // Non-crashing is the half that matters: the FIRST session still works afterwards.
      h.setResponses([reply("first session still serving")]);
      const res = await h.connection.request("session/prompt", {
        sessionId: first,
        prompt: [{ type: "text", text: "hello" }],
      });
      expect(res.stopReason).toBe("end_turn");
      expect(h.client.assistantText).toBe("first session still serving");
    });
  });

  test("a session for another directory is refused — the cwd is process-wide here", async () => {
    await withAcpHarness({}, async (h) => {
      await h.connection.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      await expect(
        h.connection.request("session/new", { cwd: "/somewhere/else", mcpServers: [] }),
      ).rejects.toThrow(/bound to the directory it was started in/);
    });
  });

  test("MCP servers are refused rather than silently dropped", async () => {
    await withAcpHarness({}, async (h) => {
      await h.connection.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      await expect(
        h.connection.request("session/new", {
          cwd: h.cwd,
          mcpServers: [{ type: "stdio", name: "x", command: "x", args: [], env: [] }],
        }),
      ).rejects.toThrow(/does not act as an MCP client/);
    });
  });

  test("prompting an unknown session names the one this process serves", async () => {
    await withAcpHarness({}, async (h) => {
      await openSession(h);
      await expect(
        h.connection.request("session/prompt", {
          sessionId: "sess-nope",
          prompt: [{ type: "text", text: "hi" }],
        }),
      ).rejects.toThrow(/unknown session sess-nope/);
    });
  });
});

describe("acp — a prompt turn", () => {
  test("streams the reply, ends the turn, and still runs the routing loop", async () => {
    await withAcpHarness(
      {
        responses: [new AssistantMessage({ content: [thinking("weighing it"), text("hi there")] })],
      },
      async (h) => {
        const sessionId = await openSession(h);
        const res = await h.connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "say hello" }],
        });

        expect(res.stopReason).toBe("end_turn");
        expect(h.client.assistantText).toBe("hi there");
        expect(h.client.thoughtText).toBe("weighing it");
        // Chunks of one message share a messageId — that is how a client groups them.
        const ids = new Set(h.client.updatesOfKind("agent_message_chunk").map((u) => u.messageId));
        expect(ids.size).toBe(1);

        // The full harness ran behind the socket: routed out, fed back with realized usage.
        expect(h.service.recommendCalls).toHaveLength(1);
        expect(h.service.feedbackCalls).toHaveLength(1);
        const fb = h.service.feedbackCalls[0] as Record<string, unknown>;
        expect(fb.recommendation_id).toBe("rec-1");
        expect(fb.actual_cost_usd as number).toBeGreaterThan(0);
        expect(h.db.getRunDecisions(h.agent.runId!)[0]!.chosen_model).toBe(ACP_MODEL.id);
      },
    );
  });

  test("a resource link reaches the model as the path it names", async () => {
    await withAcpHarness({ responses: [reply("read it")] }, async (h) => {
      const sessionId = await openSession(h);
      await h.connection.request("session/prompt", {
        sessionId,
        prompt: [
          { type: "text", text: "review this" },
          { type: "resource_link", uri: `file://${h.cwd}/notes%20one.md`, name: "notes one.md" },
        ],
      });
      expect(h.agent.lastRoutedTask).toBe(`review this\n${h.cwd}/notes one.md`);
    });
  });

  test("content this build does not advertise is refused, not silently dropped", async () => {
    await withAcpHarness({}, async (h) => {
      const sessionId = await openSession(h);
      await expect(
        h.connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
        }),
      ).rejects.toThrow(/text and resource_link prompt content only/);
    });
  });

  test("a provider failure is a protocol error, not a turn that claims it finished", async () => {
    const exploded = () =>
      new AssistantMessage({
        content: [text("")],
        stop_reason: "error",
        error_message: "provider exploded",
      });
    await withAcpHarness(
      {
        // Three, because the recovery ladder is running behind the socket exactly as it does in
        // a terminal session: a failed rung re-routes and tries again before the turn gives up.
        // Scripting one would have the ladder run out of faux turns and report THAT instead.
        responses: [exploded(), exploded(), exploded()],
      },
      async (h) => {
        const sessionId = await openSession(h);
        await expect(
          h.connection.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "go" }],
          }),
        ).rejects.toThrow(/provider exploded/);
      },
    );
  });

  test("a second prompt while a turn runs is refused with a clear error", async () => {
    await withAcpHarness(
      {
        responses: [calls(toolCall("tc-1", "bash", { command: "echo one" })), reply("done")],
        tools: [bashTool()],
        // Hold the first turn open inside the permission round-trip so the second prompt
        // genuinely overlaps it.
        permissions: async () => {
          await new Promise((r) => setTimeout(r, 60));
          return "allow_once" as PermissionAnswer;
        },
      },
      async (h) => {
        const sessionId = await openSession(h);
        const first = h.connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "run it" }],
        });
        await new Promise((r) => setTimeout(r, 10));
        await expect(
          h.connection.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "and this" }],
          }),
        ).rejects.toThrow(/a turn is already running/);
        expect((await first).stopReason).toBe("end_turn");
      },
    );
  });
});

describe("acp — permission round-trips", () => {
  test("approving runs the call; the tool call is announced then updated", async () => {
    const flag = "acp-approved.txt";
    await withAcpHarness(
      {
        responses: [
          calls(toolCall("tc-write", "write", { path: flag, content: "approved\n" })),
          reply("wrote it"),
        ],
        tools: [writeTool()],
      },
      async (h) => {
        const sessionId = await openSession(h);
        const res = await h.connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: `create ${flag}` }],
        });

        expect(res.stopReason).toBe("end_turn");
        expect(h.client.permissionRequests).toHaveLength(1);
        const asked = h.client.permissionRequests[0]!.request;
        expect(asked.sessionId).toBe(sessionId);
        expect(asked.toolCall.toolCallId).toBe("tc-write");
        expect(asked.toolCall.name).toBe("write");
        expect(asked.toolCall.kind).toBe("edit");
        expect(asked.toolCall.rawInput).toMatchObject({ path: flag });

        const announced = h.client.updatesOfKind("tool_call");
        expect(announced).toHaveLength(1);
        expect(announced[0]!.toolCallId).toBe("tc-write");
        expect(announced[0]!.status).toBe("in_progress");
        expect(announced[0]!.title).toBe(`write: ${flag}`);
        const updated = h.client.updatesOfKind("tool_call_update");
        expect(updated.at(-1)!.status).toBe("completed");

        // The observable consequence, not the mechanism: the file is on disk.
        expect(existsSync(join(h.cwd, flag))).toBe(true);
        expect(readFileSync(join(h.cwd, flag), "utf8")).toBe("approved\n");
      },
    );
  });

  test("denying blocks the call, tells the model why, and fails the tool call", async () => {
    const flag = "acp-denied.txt";
    await withAcpHarness(
      {
        responses: [
          calls(toolCall("tc-write", "write", { path: flag, content: "nope\n" })),
          reply("understood"),
        ],
        tools: [writeTool()],
        permissions: () => "reject_once",
      },
      async (h) => {
        const sessionId = await openSession(h);
        const res = await h.connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: `create ${flag}` }],
        });

        expect(res.stopReason).toBe("end_turn");
        expect(existsSync(join(h.cwd, flag))).toBe(false);
        const updated = h.client.updatesOfKind("tool_call_update");
        expect(updated.at(-1)!.status).toBe("failed");
        // The refusal reaches the model as a user choice — the framing that stops a model
        // concluding its tools are broken and retrying the same call.
        const refusal = h.agent.agentState.messages.find(
          (m) => m.role === "toolResult" && m.textContent.includes("The user declined"),
        );
        expect(refusal).toBeDefined();
        expect(refusal!.textContent).toContain("not an environment restriction");
      },
    );
  });

  test("a bash 'always' grants the COMMAND FAMILY, and the option name says so", async () => {
    await withAcpHarness(
      {
        responses: [
          calls(toolCall("tc-1", "bash", { command: "git status" })),
          calls(toolCall("tc-2", "bash", { command: "git log -1" })),
          calls(toolCall("tc-3", "bash", { command: "rm -rf nothing" })),
          reply("done"),
        ],
        tools: [bashTool()],
        permissions: (_req, index) => (index === 0 ? "allow_always" : "reject_once"),
      },
      async (h) => {
        const sessionId = await openSession(h);
        await h.connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "inspect the repo" }],
        });

        // Two prompts, not three: `git log` rode the grant `git status` earned, and `rm` did not.
        expect(h.client.permissionRequests).toHaveLength(2);
        const first = h.client.permissionRequests[0]!.request;
        const always = first.options.find((o) => o.kind === "allow_always")!;
        // THE assertion of this ticket's permission decision. An unscoped "always allow bash"
        // would show the user a smaller promise than the one the state actually keeps.
        expect(always.name).toBe("Always allow `git` commands");
        expect(first.options.map((o) => o.kind)).toEqual([
          "allow_once",
          "allow_always",
          "reject_once",
        ]);
        // Persisted rejection is deliberately not offered — it is state this harness has never
        // had, and adding it under cover of a protocol mapping is what the ticket refuses.
        expect(first.options.some((o) => o.kind === "reject_always")).toBe(false);

        expect(h.frontEnd.permissionState.bashGrants.has("git")).toBe(true);
        expect(h.frontEnd.permissionState.allowAlways.has("bash")).toBe(false);
        expect(h.client.permissionRequests[1]!.request.toolCall.toolCallId).toBe("tc-3");
      },
    );
  });

  test("a read 'always' grants the DIRECTORY, and the option name says so", async () => {
    await withAcpHarness(
      {
        responses: [
          calls(toolCall("tc-r1", "read", { path: "a.txt" })),
          calls(toolCall("tc-r2", "read", { path: "b.txt" })),
          reply("read both"),
        ],
        tools: [readTool()],
        permissions: () => "allow_always",
      },
      async (h) => {
        const sessionId = await openSession(h);
        await Bun.write(join(h.cwd, "a.txt"), "alpha\n");
        await Bun.write(join(h.cwd, "b.txt"), "beta\n");

        await h.connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "read the files" }],
        });

        expect(h.client.permissionRequests).toHaveLength(1); // the second read rode the grant
        const always = h.client.permissionRequests[0]!.request.options.find(
          (o) => o.kind === "allow_always",
        )!;
        expect(always.name).toBe(`Always allow reading ${h.cwd}`);
        expect(h.frontEnd.permissionState.allowedDirs.has(h.cwd)).toBe(true);
      },
    );
  });

  test("an 'always' grant is a grant: the same tool is not asked twice", async () => {
    await withAcpHarness(
      {
        responses: [
          calls(toolCall("tc-w1", "write", { path: "one.txt", content: "1\n" })),
          calls(toolCall("tc-w2", "write", { path: "two.txt", content: "2\n" })),
          reply("wrote both"),
        ],
        tools: [writeTool()],
        permissions: () => "allow_always",
      },
      async (h) => {
        const sessionId = await openSession(h);
        await h.connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "write two files" }],
        });

        expect(h.client.permissionRequests).toHaveLength(1);
        expect(h.client.permissionRequests[0]!.request.options[1]!.name).toBe("Always allow write");
        expect(existsSync(join(h.cwd, "one.txt"))).toBe(true);
        expect(existsSync(join(h.cwd, "two.txt"))).toBe(true);
      },
    );
  });

  test("a client that answers 'cancelled' does not get the call run", async () => {
    await withAcpHarness(
      {
        responses: [
          calls(toolCall("tc-w", "write", { path: "cancelled.txt", content: "x\n" })),
          reply("ok"),
        ],
        tools: [writeTool()],
        permissions: () => "cancelled",
      },
      async (h) => {
        const sessionId = await openSession(h);
        await h.connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "write it" }],
        });
        expect(existsSync(join(h.cwd, "cancelled.txt"))).toBe(false);
      },
    );
  });
});

describe("acp — cancellation", () => {
  test("cancel returns the cancelled stop reason rather than propagating an abort error", async () => {
    await withAcpHarness(
      {
        responses: [
          calls(toolCall("tc-slow", "write", { path: "never.txt", content: "x\n" })),
          reply("unreached"),
        ],
        tools: [writeTool()],
        // The client stalls on the permission dialog — a turn suspended exactly where a real
        // user would be looking at it when they hit cancel.
        permissions: () => new Promise<PermissionAnswer>(() => {}),
      },
      async (h) => {
        const sessionId = await openSession(h);
        const turn = h.connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "write it" }],
        });

        // Wait until the agent is actually asking, then cancel without answering — the case the
        // defensive settle exists for.
        while (h.client.permissionRequests.length === 0) {
          await new Promise((r) => setTimeout(r, 5));
        }
        await h.connection.notify("session/cancel", { sessionId });

        const res = await turn;
        expect(res.stopReason).toBe("cancelled");
        expect(existsSync(join(h.cwd, "never.txt"))).toBe(false);
      },
    );
  });

  test("cancelling another session's id is ignored", async () => {
    await withAcpHarness({ responses: [reply("fine")] }, async (h) => {
      const sessionId = await openSession(h);
      await h.connection.notify("session/cancel", { sessionId: "sess-other" });
      const res = await h.connection.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "still working?" }],
      });
      expect(res.stopReason).toBe("end_turn");
    });
  });
});
