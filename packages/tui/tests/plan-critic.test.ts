import { describe, expect, test } from "bun:test";
import { AssistantMessage, type Model, text } from "../src/ai/index.ts";
import {
  buildCriticPrompt,
  formatCriticNote,
  parseCriticFlags,
  runPlanCritic,
} from "../src/minima/index.ts";

// E1 Planning Critic: prompt shape, fail-quiet parsing, and the run wrapper's skip/cost
// behavior. Hermetic — completeFn is stubbed everywhere.

const META: Model = {
  id: "meta",
  provider: "faux",
  api: "faux",
  name: "Meta",
  cost: { input: 1, output: 1 },
  context_window: 8192,
  max_tokens: 1024,
};

const reply = (t: string) =>
  (async () => new AssistantMessage({ content: [text(t)], stop_reason: "endTurn" })) as never;

describe("plan critic — prompt + parse", () => {
  test("prompt numbers steps and shows each check (or its absence)", () => {
    const p = buildCriticPrompt([
      { action: "add the endpoint", verify: "pytest tests/api" },
      { action: "write docs", verify: null },
    ]);
    expect(p).toContain("1. add the endpoint");
    expect(p).toContain("verify: pytest tests/api");
    expect(p).toContain("2. write docs");
    expect(p).toContain("verify: (none)");
  });

  test("OK → []; FLAGS bullets → list; garbage → null", () => {
    expect(parseCriticFlags("OK")).toEqual([]);
    expect(parseCriticFlags("ok, looks fine")).toEqual([]);
    const flags = parseCriticFlags(
      "FLAGS:\n- step 2: `make lint` passes before the work — non-discriminative\n- step 3: depends on step 4's schema",
    );
    expect(flags).toEqual([
      "step 2: `make lint` passes before the work — non-discriminative",
      "step 3: depends on step 4's schema",
    ]);
    expect(parseCriticFlags("I think this plan is great!")).toBeNull();
  });

  test("flags cap at 6", () => {
    const many = `FLAGS:\n${Array.from({ length: 9 }, (_, i) => `- f${i}`).join("\n")}`;
    expect(parseCriticFlags(many)).toHaveLength(6);
  });

  test("formatCriticNote: silent for null/[], advisory block for findings", () => {
    expect(formatCriticNote(null)).toBe("");
    expect(formatCriticNote([])).toBe("");
    expect(formatCriticNote(["step 1: weak check"])).toContain("Planning critic (advisory");
    expect(formatCriticNote(["step 1: weak check"])).toContain("- step 1: weak check");
  });
});

describe("plan critic — run wrapper", () => {
  const steps = [{ action: "do it", verify: "bun test" }];

  test("returns parsed flags and books spend", async () => {
    const booked: number[] = [];
    const flags = await runPlanCritic({
      metaModel: META,
      steps,
      onCostUsd: (usd) => booked.push(usd),
      completeFn: reply("FLAGS:\n- step 1: check already green"),
    });
    expect(flags).toEqual(["step 1: check already green"]);
    expect(booked).toHaveLength(1);
  });

  test("skips without a model, without steps, or when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await runPlanCritic({ metaModel: null, steps, completeFn: reply("OK") })).toBeNull();
    expect(await runPlanCritic({ metaModel: META, steps: [], completeFn: reply("OK") })).toBeNull();
    expect(
      await runPlanCritic({ metaModel: META, steps, signal: ac.signal, completeFn: reply("OK") }),
    ).toBeNull();
  });

  test("a throwing call is a silent skip, never an error", async () => {
    const flags = await runPlanCritic({
      metaModel: META,
      steps,
      completeFn: (async () => {
        throw new Error("provider down");
      }) as never,
    });
    expect(flags).toBeNull();
  });
});
