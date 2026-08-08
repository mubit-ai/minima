import { describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  Message,
  type Model,
  Usage,
  registerModel,
  text,
} from "../src/ai/index.ts";
import {
  AUTO_COMPACT_PCT,
  approxContextTokens,
  contextUsage,
  fmtCtxTokens,
} from "../src/tui/context_meter.ts";

const BIG: Model = {
  id: "ctx-test-200k",
  provider: "faux",
  api: "faux",
  name: "Ctx Test 200k",
  cost: { input: 1, output: 1 },
  context_window: 200_000,
  max_tokens: 4096,
};

const SMALL: Model = { ...BIG, id: "ctx-test-100k", context_window: 100_000 };

registerModel(BIG);
registerModel(SMALL);

const user = (t: string) => new Message({ role: "user", content: t });

/** An assistant reply carrying a provider-reported usage record. */
const reply = (
  u: Partial<Pick<Usage, "input" | "output" | "cache_read" | "cache_write">>,
  model = BIG.id,
) => new AssistantMessage({ content: [text("ok")], model, usage: new Usage(u) });

describe("contextUsage — the cache undercount, pinned", () => {
  test("a cached prompt counts cache_read + cache_write, not just the uncached remainder", () => {
    const msgs = [
      user("q"),
      reply({ input: 5_000, cache_read: 60_000, cache_write: 3_000, output: 2_000 }),
    ];
    const ctx = contextUsage(msgs);
    // 5k uncached + 60k cache read + 3k cache write + 2k output = 70k of a 200k window.
    expect(ctx.usedTokens).toBe(70_000);
    expect(ctx.windowTokens).toBe(200_000);
    expect(ctx.pct).toBeCloseTo(35, 6);
    // The shipped footer divided bare usage.input by the window: 5_000 / 200_000 = 2.5%.
    expect(ctx.pct).not.toBeCloseTo(2.5, 6);
  });

  test("the same session under the legacy flag reproduces the old 2.5%", () => {
    const msgs = [
      user("q"),
      reply({ input: 5_000, cache_read: 60_000, cache_write: 3_000, output: 2_000 }),
    ];
    const ctx = contextUsage(msgs, { legacy: true });
    expect(ctx.usedTokens).toBe(5_000);
    expect(ctx.pct).toBeCloseTo(2.5, 6);
  });
});

describe("contextUsage — the anchor + measured overhead + tail formula", () => {
  test("steady state (anchor is last) is exactly the provider's count, no chars/4 leak", () => {
    const msgs = [user("x".repeat(4_000)), reply({ input: 30_000, output: 500 })];
    const ctx = contextUsage(msgs);
    expect(ctx.usedTokens).toBe(30_500);
    expect(ctx.basis).toBe("exact");
  });

  test("a message appended after the reply adds exactly its chars/4", () => {
    const base = [user("q"), reply({ input: 30_000, output: 500 })];
    const before = contextUsage(base);
    const after = contextUsage([...base, user("y".repeat(4_000))]);
    expect(after.usedTokens - before.usedTokens).toBe(1_000);
    expect(after.basis).toBe("adjusted");
  });

  test("overhead is measured, not guessed: the invisible prompt survives into usedTokens", () => {
    // 3_998 user chars + the reply's own "ok" = 4_000 chars = 1_000 estimated tokens, but
    // the provider counted a 21_000-token prompt. The 20_000-token residue is the system
    // prompt + tool schemas that chars/4 structurally cannot see.
    const msgs = [user("x".repeat(3_998)), reply({ input: 21_000, output: 0 })];
    const ctx = contextUsage(msgs);
    expect(approxContextTokens(msgs)).toBe(1_000);
    expect(ctx.usedTokens).toBe(21_000);
    expect(ctx.usedTokens - approxContextTokens(msgs)).toBe(20_000);
  });

  test("overhead clamps at zero — usedTokens never drops below the raw estimate", () => {
    const msgs = [user("x".repeat(40_000)), reply({ input: 10, output: 0 })];
    const est = approxContextTokens(msgs);
    const ctx = contextUsage(msgs);
    expect(ctx.usedTokens).toBe(est);
    expect(ctx.usedTokens).toBeGreaterThanOrEqual(est);
  });

  test("dropping the anchor (rewind/undo) re-anchors and the number falls", () => {
    const anchored = [
      user("x".repeat(40_000)),
      reply({ input: 50_000, output: 1_000 }),
      user("more"),
    ];
    const full = contextUsage(anchored);
    expect(full.usedTokens).toBe(51_001);
    expect(full.basis).toBe("adjusted");
    const rewound = contextUsage(anchored.slice(0, 1));
    expect(rewound.usedTokens).toBeLessThan(full.usedTokens);
    expect(rewound.basis).toBe("estimated");
  });

  test("KNOWN LIMITATION: a prefix drop that keeps the anchor holds until the next reply", () => {
    // The two chars/4 terms cancel exactly, so "compaction just ran" and "steady state" are
    // arithmetically identical inputs here. compactMessages keeps the last six messages, so
    // the anchor survives and its usage still describes the pre-compaction prompt. The next
    // reply re-anchors and the number corrects itself.
    const anchor = reply({ input: 50_000, output: 1_000 });
    const before = [user("x".repeat(40_000)), user("y".repeat(40_000)), anchor];
    const after = [user("[Compacted 2 messages]"), anchor];
    expect(contextUsage(after).usedTokens).toBe(contextUsage(before).usedTokens);
  });
});

describe("contextUsage — anchor selection", () => {
  test("the LAST reply with a real prompt wins", () => {
    const ctx = contextUsage([
      user("q1"),
      reply({ input: 10_000, output: 100 }),
      user("q2"),
      reply({ input: 25_000, output: 500 }),
    ]);
    expect(ctx.inputTokens).toBe(25_000);
    expect(ctx.outputTokens).toBe(500);
    expect(ctx.usedTokens).toBe(25_500);
  });

  test("a zero-usage assistant is not an anchor and does not crash the search", () => {
    // A base Message with role "assistant" passes isAssistant but carries no `usage` at all,
    // and AssistantMessage defaults to an all-zero Usage — neither may anchor.
    const bare = new Message({ role: "assistant", content: "bare" });
    const zeroed = new AssistantMessage({ content: [text("ok")], model: BIG.id });
    const ctx = contextUsage([user("q"), bare, zeroed]);
    expect(ctx.basis).toBe("estimated");
    expect(ctx.inputTokens).toBe(0);
    expect(ctx.usedTokens).toBe(approxContextTokens([user("q"), bare, zeroed]));
  });

  test("no anchor falls back to chars/4 — byte-identical to the pre-unification basis", () => {
    const msgs = [user("q1"), user("q2"), user("x".repeat(400))];
    const ctx = contextUsage(msgs, { fallbackWindow: 1_000 });
    expect(ctx.basis).toBe("estimated");
    expect(ctx.usedTokens).toBe(approxContextTokens(msgs));
    expect(ctx.pct).toBeCloseTo((100 * approxContextTokens(msgs)) / 1_000, 6);
  });
});

describe("contextUsage — window resolution and the explicit UNKNOWN state", () => {
  test("the anchor's own registered model wins over the fallback", () => {
    const ctx = contextUsage([reply({ input: 50_000, output: 0 }, SMALL.id)], {
      fallbackWindow: 200_000,
    });
    expect(ctx.windowTokens).toBe(100_000);
    expect(ctx.pct).toBeCloseTo(50, 6);
  });

  test("an unregistered model falls back to the supplied window", () => {
    const ctx = contextUsage([reply({ input: 5_000, output: 50 }, "ghost-model")], {
      fallbackWindow: 50_000,
    });
    expect(ctx.windowTokens).toBe(50_000);
    expect(ctx.pct).toBeCloseTo(10.1, 6);
  });

  test("no registered model and no fallback → UNKNOWN, never a confident 0%", () => {
    const ctx = contextUsage([reply({ input: 5_000, output: 50 }, "ghost-model")]);
    expect(ctx.windowTokens).toBeNull();
    expect(ctx.pct).toBeNull();
    expect(ctx.usedTokens).toBe(5_050); // the tokens are still real
  });

  test("a zero/negative fallback window is unresolvable, not a divisor", () => {
    expect(
      contextUsage([reply({ input: 1, output: 0 }, "ghost")], { fallbackWindow: 0 }).pct,
    ).toBeNull();
    expect(contextUsage([], { fallbackWindow: null }).pct).toBeNull();
    expect(contextUsage([]).usedTokens).toBe(0);
  });

  test("pct is not clamped above 100 — an over-full context reads over-full", () => {
    const ctx = contextUsage([reply({ input: 2_000, output: 0 }, "ghost")], {
      fallbackWindow: 1_000,
    });
    expect(ctx.pct).toBeGreaterThan(100);
    expect(ctx.pct).toBeCloseTo(200, 6);
  });
});

describe("contextUsage — the MINIMA_TUI_CONTEXT_METER=0 legacy branch", () => {
  test("reproduces the old bare-input numbers exactly", () => {
    const msgs = [
      user("q1"),
      reply({ input: 10_000, output: 100 }, SMALL.id),
      user("q2"),
      reply({ input: 25_000, output: 500 }, SMALL.id),
    ];
    const ctx = contextUsage(msgs, { legacy: true });
    expect(ctx.inputTokens).toBe(25_000);
    expect(ctx.outputTokens).toBe(500);
    expect(ctx.usedTokens).toBe(25_000);
    expect(ctx.pct).toBeCloseTo(25, 6);
  });

  test("an unresolvable window collapses to 0, not null — the old silent-zero contract", () => {
    const ctx = contextUsage([reply({ input: 5_000, output: 50 }, "ghost-model")], {
      legacy: true,
    });
    expect(ctx.pct).toBe(0);
    expect(ctx.inputTokens).toBe(5_000);
  });

  test("no assistant / no usage → zeros, never NaN", () => {
    const empty = contextUsage([], { legacy: true });
    expect(empty).toEqual({
      usedTokens: 0,
      windowTokens: null,
      pct: 0,
      basis: "estimated",
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(contextUsage([user("only a prompt")], { legacy: true }).pct).toBe(0);
    const bare = contextUsage([new AssistantMessage({ content: [text("bare")] })], {
      legacy: true,
    });
    expect(Number.isFinite(bare.pct as number)).toBe(true);
    expect(bare.inputTokens).toBe(0);
  });

  test("legacy ignores the tail entirely — it only ever reads the last reply", () => {
    const base = [user("q"), reply({ input: 30_000, output: 500 }, SMALL.id)];
    const before = contextUsage(base, { legacy: true });
    const after = contextUsage([...base, user("y".repeat(400_000))], { legacy: true });
    expect(after.usedTokens).toBe(before.usedTokens);
  });
});

describe("contextUsage — the footer stats it replaced (was footerStatsFromMessages, B1.2)", () => {
  test("the reply's own output now counts: 25% becomes 25.5%", () => {
    // The old helper divided bare usage.input by the window and ignored the reply itself.
    // The output tokens are part of the NEXT request's prompt, so they belong in the count.
    const ctx = contextUsage([
      user("q1"),
      reply({ input: 10_000, output: 100 }, SMALL.id),
      user("q2"),
      reply({ input: 25_000, output: 500 }, SMALL.id),
    ]);
    expect(ctx.inputTokens).toBe(25_000);
    expect(ctx.outputTokens).toBe(500);
    expect(ctx.pct).toBeCloseTo(25.5, 6);
  });

  test("unregistered model + fallback window: 10% becomes 10.1%", () => {
    const ctx = contextUsage([reply({ input: 5_000, output: 50 }, "ghost-model")], {
      fallbackWindow: 50_000,
    });
    expect(ctx.pct).toBeCloseTo(10.1, 6);
    expect(ctx.inputTokens).toBe(5_000);
  });

  test("the old zero-safety block becomes the explicit-UNKNOWN contract", () => {
    expect(contextUsage([]).pct).toBeNull();
    expect(contextUsage([user("only a prompt")]).pct).toBeNull();
    const noWindow = contextUsage([reply({ input: 5_000, output: 50 }, "ghost-model")]);
    expect(noWindow.pct).toBeNull(); // was a confident 0
    expect(noWindow.usedTokens).toBe(5_050);
    const bare = contextUsage([new AssistantMessage({ content: [text("bare")] })]);
    expect(bare.pct).toBeNull();
    expect(bare.inputTokens).toBe(0);
  });
});

describe("context meter helpers", () => {
  test("AUTO_COMPACT_PCT is the single 80 both the footer and the trigger read", () => {
    expect(AUTO_COMPACT_PCT).toBe(80);
  });

  test("fmtCtxTokens", () => {
    expect(fmtCtxTokens(0)).toBe("0");
    expect(fmtCtxTokens(-5)).toBe("0");
    expect(fmtCtxTokens(840)).toBe("840");
    expect(fmtCtxTokens(999)).toBe("999");
    expect(fmtCtxTokens(1_000)).toBe("1k");
    expect(fmtCtxTokens(68_000)).toBe("68k");
    expect(fmtCtxTokens(200_000)).toBe("200k");
    expect(fmtCtxTokens(1_000_000)).toBe("1M");
    expect(fmtCtxTokens(1_500_000)).toBe("1.5M");
    expect(fmtCtxTokens(2_000_000)).toBe("2M");
  });

  test("approxContextTokens is chars/4 over textContent", () => {
    expect(approxContextTokens([])).toBe(0);
    expect(approxContextTokens([user("x".repeat(400))])).toBe(100);
    expect(approxContextTokens([user("abc")])).toBe(1);
  });
});
