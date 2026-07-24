import { describe, expect, test } from "bun:test";

import { AssistantMessage, Message, text, toolCall } from "../src/ai/types.ts";
import {
  CONTEXT_REWIND_EVENT,
  type PendingContextRewind,
  applyPendingContextRewind,
  findRewindAnchor,
  parseContextRewindMarker,
  truncateAfterAnchor,
} from "../src/agent/context_prune.ts";

const user = (t: string) => new Message({ role: "user", content: t });

const assistant = (calls: [string, string][], t = "") =>
  new AssistantMessage({
    content: [...(t ? [text(t)] : []), ...calls.map(([id, name]) => toolCall(id, name))],
    model: "m",
    stop_reason: calls.length ? "toolUse" : "stop",
  });

const result = (id: string, name: string, t: string, isError = false) =>
  new Message({
    role: "toolResult",
    content: t,
    tool_call_id: id,
    tool_name: name,
    is_error: isError,
  });

describe("findRewindAnchor", () => {
  test("no checkpoint anywhere -> null", () => {
    const msgs = [user("go"), assistant([["r1", "read"]]), result("r1", "read", "stuff")];
    expect(findRewindAnchor(msgs)).toBeNull();
  });

  test("latest unconsumed checkpoint wins (nested checkpoints)", () => {
    const msgs = [
      user("go"),
      assistant([["cp1", "checkpoint"]]),
      result("cp1", "checkpoint", "Checkpoint set"),
      assistant([["cp2", "checkpoint"]]),
      result("cp2", "checkpoint", "Checkpoint set"),
    ];
    expect(findRewindAnchor(msgs)).toBe("cp2");
  });

  test("a successful rewind consumes all prior checkpoints", () => {
    const msgs = [
      user("go"),
      assistant([["cp1", "checkpoint"]]),
      result("cp1", "checkpoint", "Checkpoint set"),
      assistant([["rw1", "rewind"]]),
      result("rw1", "rewind", "Context rewound to checkpoint."),
    ];
    expect(findRewindAnchor(msgs)).toBeNull();
  });

  test("an errored rewind does NOT consume the checkpoint", () => {
    const msgs = [
      user("go"),
      assistant([["cp1", "checkpoint"]]),
      result("cp1", "checkpoint", "Checkpoint set"),
      assistant([["rw1", "rewind"]]),
      result("rw1", "rewind", "Error: report: required", true),
    ];
    expect(findRewindAnchor(msgs)).toBe("cp1");
  });

  test("an errored checkpoint result is not an anchor", () => {
    const msgs = [
      user("go"),
      assistant([["cp1", "checkpoint"]]),
      result("cp1", "checkpoint", "Error: boom", true),
    ];
    expect(findRewindAnchor(msgs)).toBeNull();
  });

  test("anchor erased by a compaction-style summary rewrite -> null", () => {
    const msgs = [
      user("[Compacted 12 messages]\nUser: go\nTool(checkpoint): Checkpoint set"),
      assistant([["r1", "read"]]),
      result("r1", "read", "stuff"),
    ];
    expect(findRewindAnchor(msgs)).toBeNull();
  });
});

describe("truncateAfterAnchor", () => {
  test("cuts everything after the anchor toolResult", () => {
    const msgs = [
      user("go"),
      assistant([["cp1", "checkpoint"]]),
      result("cp1", "checkpoint", "Checkpoint set"),
      assistant([["p1", "probe"]]),
      result("p1", "probe", "PROBE"),
    ];
    const cut = truncateAfterAnchor(msgs, "cp1");
    expect(cut).not.toBeNull();
    expect(cut).toEqual(msgs.slice(0, 3));
  });

  test("missing anchor -> null", () => {
    const msgs = [user("go"), assistant([["p1", "probe"]]), result("p1", "probe", "PROBE")];
    expect(truncateAfterAnchor(msgs, "ghost")).toBeNull();
  });
});

describe("applyPendingContextRewind", () => {
  const build = () => {
    const msgs = [
      user("go"),
      assistant([["cp1", "checkpoint"]]),
      result("cp1", "checkpoint", "Checkpoint set"),
      assistant([
        ["p1", "probe"],
        ["p2", "probe"],
      ]),
      result("p1", "probe", "PROBE-ONE"),
      result("p2", "probe", "PROBE-TWO"),
      assistant([["rw1", "rewind"]]),
      result("rw1", "rewind", "Context rewound to checkpoint."),
    ];
    return msgs;
  };

  test("prunes between anchor and rewind assistant; both slice edges stay paired", () => {
    const msgs = build();
    const state = {
      messages: msgs,
      pendingContextRewind: {
        anchorToolCallId: "cp1",
        rewindToolCallId: "rw1",
      } as PendingContextRewind | null,
    };
    applyPendingContextRewind(state);
    expect(state.messages).toEqual([msgs[0]!, msgs[1]!, msgs[2]!, msgs[6]!, msgs[7]!]);
    expect(state.pendingContextRewind).toBeNull();
    for (let i = 0; i < state.messages.length; i++) {
      const m = state.messages[i]!;
      if (m instanceof AssistantMessage && m.toolCalls.length) {
        for (let j = 0; j < m.toolCalls.length; j++) {
          const r = state.messages[i + 1 + j]!;
          expect(r.role).toBe("toolResult");
          expect(r.tool_call_id).toBe(m.toolCalls[j]!.id);
        }
      }
      if (m.role === "toolResult") {
        const owner = state.messages
          .slice(0, i)
          .reverse()
          .find((x) => x instanceof AssistantMessage) as AssistantMessage | undefined;
        expect(owner?.toolCalls.some((c) => c.id === m.tool_call_id)).toBe(true);
      }
    }
  });

  test("null pending is a no-op", () => {
    const msgs = build();
    const state = { messages: msgs, pendingContextRewind: null };
    applyPendingContextRewind(state);
    expect(state.messages).toBe(msgs);
  });

  test("missing anchor -> no prune, field still cleared", () => {
    const msgs = build();
    const state = {
      messages: msgs,
      pendingContextRewind: {
        anchorToolCallId: "ghost",
        rewindToolCallId: "rw1",
      } as PendingContextRewind | null,
    };
    applyPendingContextRewind(state);
    expect(state.messages).toEqual(build());
    expect(state.pendingContextRewind).toBeNull();
  });

  test("missing rewind assistant -> no prune, field still cleared", () => {
    const msgs = build();
    const state = {
      messages: msgs,
      pendingContextRewind: {
        anchorToolCallId: "cp1",
        rewindToolCallId: "ghost",
      } as PendingContextRewind | null,
    };
    applyPendingContextRewind(state);
    expect(state.messages).toEqual(build());
    expect(state.pendingContextRewind).toBeNull();
  });
});

describe("parseContextRewindMarker", () => {
  test("valid payload round-trips", () => {
    const m = parseContextRewindMarker({
      anchor_tool_call_id: "cp1",
      rewind_tool_call_id: "rw1",
      report: "found it",
      report_chars: 8,
    });
    expect(m).toEqual({ anchor_tool_call_id: "cp1", rewind_tool_call_id: "rw1", report: "found it" });
  });

  test("rewind_tool_call_id is optional", () => {
    const m = parseContextRewindMarker({ anchor_tool_call_id: "cp1", report: "r" });
    expect(m).toEqual({ anchor_tool_call_id: "cp1", rewind_tool_call_id: null, report: "r" });
  });

  test("malformed payloads -> null", () => {
    expect(parseContextRewindMarker(null)).toBeNull();
    expect(parseContextRewindMarker("x")).toBeNull();
    expect(parseContextRewindMarker({})).toBeNull();
    expect(parseContextRewindMarker({ anchor_tool_call_id: "" })).toBeNull();
    expect(parseContextRewindMarker({ anchor_tool_call_id: 3, report: "r" })).toBeNull();
  });

  test("event type constant is the collision-safe name", () => {
    expect(CONTEXT_REWIND_EVENT).toBe("context_rewind");
  });
});
