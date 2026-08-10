/**
 * MUB-239 — golden snapshots of the frames `minima acp` puts on the wire.
 *
 * The wire format is a contract with software we do not ship and cannot test against, so the
 * failure mode is silent drift: a field renamed, a status dropped, an option quietly restructured,
 * and nothing goes red until an external client breaks in someone else's editor. Behavioural
 * tests do not catch that — they read the fields they know about through helpers, so a frame can
 * grow, shrink or reshape around them and every assertion still passes.
 *
 * These snapshots are the other half of the pair. They cannot reach the callback direction (a
 * recording says nothing about what happens when the client answers "deny"), which is why
 * `acp-e2e.test.ts` exists alongside them and why neither is redundant.
 *
 * Snapshotted from the BYTES: every frame here was serialized by the agent, framed as
 * newline-delimited JSON, and parsed back off the pipe. Only the session id, the temp directory
 * and JSON-RPC request ids are normalized — see `goldenFrames` for why that list is kept short.
 *
 * **Reviewing a diff here is reviewing a protocol change.** If a snapshot moved, the question is
 * not "does the new output look fine" but "would a client written against the old frames still
 * work" — and if the answer is no, that belongs in the ticket, not in a `--update-snapshots`.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AssistantMessage, text, thinking, toolCall } from "../src/ai/index.ts";
import { bashTool } from "../src/tools/bash.ts";
import { writeTool } from "../src/tools/write.ts";
import { type AcpHarness, goldenFrames, withAcpHarness } from "./_acp.ts";

async function openSession(h: AcpHarness): Promise<string> {
  await h.connection.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  const created = await h.connection.request("session/new", { cwd: h.cwd, mcpServers: [] });
  return created.sessionId;
}

describe("acp — golden frames", () => {
  test("handshake, session creation, and a streamed text turn", async () => {
    await withAcpHarness(
      {
        responses: [
          new AssistantMessage({
            content: [thinking("short one"), text("Hello from Minima.")],
          }),
        ],
      },
      async (h) => {
        const sessionId = await openSession(h);
        await h.connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "say hello" }],
        });
        expect(goldenFrames(h.emitted, { sessionId, cwd: h.cwd })).toMatchSnapshot();
      },
    );
  });

  test("a tool call: announcement, the permission request, and the completion update", async () => {
    await withAcpHarness(
      {
        responses: [
          new AssistantMessage({
            content: [toolCall("tc-1", "write", { path: "note.md", content: "hi\n" })],
            stop_reason: "toolUse",
          }),
          new AssistantMessage({ content: [text("Wrote it.")] }),
        ],
        tools: [writeTool()],
      },
      async (h) => {
        const sessionId = await openSession(h);
        // Absolute, so the frame's `locations` entry is stable under normalization rather than
        // depending on where the runner happened to be.
        h.setResponses([
          new AssistantMessage({
            content: [toolCall("tc-1", "write", { path: join(h.cwd, "note.md"), content: "hi\n" })],
            stop_reason: "toolUse",
          }),
          new AssistantMessage({ content: [text("Wrote it.")] }),
        ]);
        await h.connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "write a note" }],
        });
        expect(goldenFrames(h.emitted, { sessionId, cwd: h.cwd })).toMatchSnapshot();
      },
    );
  });

  test("the permission options a bash call offers, scope and all", async () => {
    await withAcpHarness(
      {
        responses: [
          new AssistantMessage({
            content: [toolCall("tc-b", "bash", { command: "pip install ." })],
            stop_reason: "toolUse",
          }),
          new AssistantMessage({ content: [text("Installed.")] }),
        ],
        tools: [bashTool()],
        permissions: () => "reject_once",
      },
      async (h) => {
        const sessionId = await openSession(h);
        await h.connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "install the package" }],
        });
        // The options block is the ticket's central safety claim in wire form: three kinds, the
        // command family named in the "always" label, and no persisted rejection.
        const request = h.emitted.find((f) => f.method === "session/request_permission") as Record<
          string,
          unknown
        >;
        expect(goldenFrames([request], { sessionId, cwd: h.cwd })).toMatchSnapshot();
      },
    );
  });

  test("a denied call fails the tool call rather than vanishing", async () => {
    await withAcpHarness(
      {
        responses: [
          new AssistantMessage({
            content: [toolCall("tc-d", "bash", { command: "rm -rf /" })],
            stop_reason: "toolUse",
          }),
          new AssistantMessage({ content: [text("Understood.")] }),
        ],
        tools: [bashTool()],
        permissions: () => "reject_once",
      },
      async (h) => {
        const sessionId = await openSession(h);
        await h.connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "clean up" }],
        });
        const updates = h.emitted.filter(
          (f) =>
            f.method === "session/update" &&
            typeof f.params === "object" &&
            f.params !== null &&
            ["tool_call", "tool_call_update"].includes(
              String((f.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate),
            ),
        );
        expect(goldenFrames(updates, { sessionId, cwd: h.cwd })).toMatchSnapshot();
      },
    );
  });
});
