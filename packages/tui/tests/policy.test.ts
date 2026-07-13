import { describe, expect, test } from "bun:test";
import {
  type GuardEvent,
  type PolicyBundle,
  emitGuardEvent,
  globMatch,
  mergeBundles,
  onGuardEvent,
  resolvePolicy,
} from "../src/agent/policy.ts";

describe("globMatch", () => {
  test("* spans any run of characters, including none", () => {
    expect(globMatch("git *", "git push origin main")).toBe(true);
    expect(globMatch("git *", "git ")).toBe(true);
    expect(globMatch("git *", "git")).toBe(false); // needs the trailing space
    expect(globMatch("*", "anything at all")).toBe(true);
  });
  test("? matches exactly one character", () => {
    expect(globMatch("v?", "v1")).toBe(true);
    expect(globMatch("v?", "v12")).toBe(false);
  });
  test("anchored at both ends — no substring surprises", () => {
    expect(globMatch("push", "git push")).toBe(false);
    expect(globMatch("*push*", "git push origin")).toBe(true);
  });
  test("regex metacharacters in patterns/subjects are literal", () => {
    expect(globMatch("src/**.test.ts", "src/a/b.test.ts")).toBe(true);
    expect(globMatch("a.b", "axb")).toBe(false); // "." is a literal dot, not regex-any
    expect(globMatch("f(x)+", "f(x)+")).toBe(true);
  });
  test("* crosses newlines (bash heredocs)", () => {
    expect(globMatch("git commit*", "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\"")).toBe(true);
  });
});

describe("resolvePolicy — last-match-wins (OpenCode semantics)", () => {
  const bundle: PolicyBundle = {
    name: "build",
    rules: [
      { tool: "*", pattern: "*", action: "allow" }, // catch-all first
      { tool: "bash", pattern: "git push*", action: "ask" },
      { tool: "bash", pattern: "rm -rf*", action: "deny" },
      { tool: "edit", pattern: "*.env", action: "deny" },
    ],
  };

  test("catch-all applies when nothing later matches", () => {
    expect(resolvePolicy(bundle, { tool: "bash", subject: "ls -la" })).toBe("allow");
    expect(resolvePolicy(bundle, { tool: "read", subject: "/etc/hosts" })).toBe("allow");
  });
  test("later specific rules override the catch-all", () => {
    expect(resolvePolicy(bundle, { tool: "bash", subject: "git push origin main" })).toBe("ask");
    expect(resolvePolicy(bundle, { tool: "bash", subject: "rm -rf /tmp/x" })).toBe("deny");
    expect(resolvePolicy(bundle, { tool: "edit", subject: "prod/.env" })).toBe("deny");
  });
  test("rules are tool-scoped: an edit rule never fires for bash", () => {
    expect(resolvePolicy(bundle, { tool: "bash", subject: "touch x.env" })).toBe("allow");
  });
  test("the LAST match wins, not the most specific", () => {
    const b: PolicyBundle = {
      name: "t",
      rules: [
        { tool: "bash", pattern: "git push*", action: "deny" },
        { tool: "bash", pattern: "git *", action: "allow" }, // later, broader → wins
      ],
    };
    expect(resolvePolicy(b, { tool: "bash", subject: "git push origin" })).toBe("allow");
  });
  test("no match at all → fallback (default allow, callers can pass ask)", () => {
    const b: PolicyBundle = { name: "t", rules: [] };
    expect(resolvePolicy(b, { tool: "bash", subject: "ls" })).toBe("allow");
    expect(resolvePolicy(b, { tool: "bash", subject: "ls" }, "ask")).toBe("ask");
  });
});

describe("mergeBundles — per-agent override appended after base", () => {
  test("override rules win because they come later", () => {
    const base: PolicyBundle = {
      name: "build",
      rules: [{ tool: "bash", pattern: "git push*", action: "ask" }],
    };
    const explorer: PolicyBundle = {
      name: "explore",
      rules: [
        { tool: "*", pattern: "*", action: "deny" }, // read-only sub-agent: deny everything…
        { tool: "read", pattern: "*", action: "allow" }, // …except reads
      ],
    };
    const merged = mergeBundles("build+explore", base, explorer);
    expect(resolvePolicy(merged, { tool: "bash", subject: "git push origin" })).toBe("deny");
    expect(resolvePolicy(merged, { tool: "read", subject: "src/index.ts" })).toBe("allow");
    // base is untouched (pure merge)
    expect(base.rules).toHaveLength(1);
  });
});

describe("guard-event bus (stub emitter — wired in A2/A3/A6/B2)", () => {
  test("emit fans out to subscribers; unsubscribe stops delivery", () => {
    const seen: GuardEvent[] = [];
    const off = onGuardEvent((e) => seen.push(e));
    emitGuardEvent({ kind: "doom-loop", detail: "bash repeated 3x with identical input" });
    emitGuardEvent({
      kind: "verify-block",
      stepId: "step-1",
      tier: "yellow",
      detail: "bun test still red (strike 2/3)",
    });
    off();
    emitGuardEvent({ kind: "steps-cap", detail: "explorer hit 40 iterations" });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.kind).toBe("doom-loop");
    expect(seen[1]!.stepId).toBe("step-1");
    expect(seen[1]!.tier).toBe("yellow");
  });
});
