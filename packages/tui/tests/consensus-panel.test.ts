import { describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  type Model,
  type StopReason,
  text as textBlock,
} from "../src/ai/index.ts";
import type { complete } from "../src/ai/stream.ts";
import { SEED_MODELS } from "../src/cli/main.ts";
import type { ConsensusVoteRow } from "../src/db/minima_db.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { CORPUS_REV, type DistinctPrompt } from "../src/minima/classifier_eval.ts";
import { CLASSIFY_SYSTEM } from "../src/minima/classify.ts";
import { PREMIUM_CANDIDATES } from "../src/minima/config.ts";
import {
  type PanelCallOutcome,
  type Panelist,
  REFERENCE_PANEL,
  buildPanelReport,
  buildReferenceLabels,
  checkPanelDiversity,
  deriveConsensus,
  makePanelCaller,
  makeSpendGuard,
  panelCallSpecs,
  planPanelRun,
  projectPanelCost,
  promptHash,
  renderOutstandingWork,
  renderPanelReport,
  renderPanelRunResult,
  runPanel,
  summarizeOutstanding,
  voteKey,
} from "../src/minima/consensus_panel.ts";
import type { TaskType } from "../src/minima/schemas.ts";

// MUB-216 — the reference panel's pure core. Nothing here calls a model: `runPanel` takes its
// caller as an argument, so the whole billable path is exercised with a fake that spends fake
// money.

/** A panelist with a stated lineage and price, for tests that do not care which model it is. */
function panelist(modelId: string, lineage: string, over: Partial<Panelist> = {}): Panelist {
  return {
    model: {
      id: modelId,
      provider: "faux",
      api: "faux",
      name: modelId,
      cost: { input: 1, output: 1 },
      context_window: 8192,
      max_tokens: 1024,
    },
    lineage,
    outputTokensPerCall: 40,
    reasonsServerSide: false,
    ...over,
  };
}

const A = panelist("model-a", "alpha");
const B = panelist("model-b", "beta");
const C = panelist("model-c", "gamma");
const TRIO = [A, B, C];

const vote = (modelId: string, taskType: TaskType | null) => ({ modelId, taskType });

/** A stored vote row for one prompt/panelist, at the current corpus revision unless overridden. */
function row(
  text: string,
  modelId: string,
  taskType: TaskType | null,
  over: Partial<ConsensusVoteRow> = {},
): ConsensusVoteRow {
  return {
    prompt_hash: promptHash(text),
    model_id: modelId,
    corpus_rev: CORPUS_REV,
    task_type: taskType,
    difficulty: "easy",
    confidence: 0.9,
    created_at: 1,
    ...over,
  };
}

const prompt = (text: string, occurrences = 1): DistinctPrompt => ({ text, occurrences });

// ---------------------------------------------------------------------------

describe("deriveConsensus — the one way a verdict comes from votes", () => {
  test("all panelists on the same label is unanimous", () => {
    const v = deriveConsensus([vote("a", "code"), vote("b", "code"), vote("c", "code")], 3);
    expect(v).toEqual({ kind: "unanimous", label: "code", votes: 3 });
  });

  test("any disagreement is a split, with the labels sorted and de-duplicated", () => {
    const v = deriveConsensus([vote("a", "code"), vote("b", "qa"), vote("c", "code")], 3);
    expect(v).toEqual({ kind: "split", labels: ["code", "qa"], votes: 3 });
  });

  test("two agreeing panelists out of three is INCOMPLETE, never unanimous", () => {
    // The load-bearing case. A panel of three that only answered twice has not agreed
    // unanimously — treating it as agreement would manufacture pseudo-gold out of a
    // panelist that never voted, and it is the reference labels every downstream number
    // rests on.
    const v = deriveConsensus([vote("a", "code"), vote("b", "code")], 3);
    expect(v).toEqual({ kind: "incomplete", votes: 2, panelSize: 3 });
  });

  test("a null label is not a vote — it cannot complete a panel", () => {
    const v = deriveConsensus([vote("a", "code"), vote("b", "code"), vote("c", null)], 3);
    expect(v.kind).toBe("incomplete");
  });

  test("one panelist voting twice counts once — the last vote wins", () => {
    // Total over any input: the ledger's primary key makes this unreachable, but a function
    // that is the single way anyone derives a verdict must not depend on that.
    const v = deriveConsensus([vote("a", "code"), vote("a", "qa"), vote("b", "qa")], 2);
    expect(v).toEqual({ kind: "unanimous", label: "qa", votes: 2 });
  });

  test("no votes, or a nonsense panel size, is incomplete rather than a verdict", () => {
    expect(deriveConsensus([], 3).kind).toBe("incomplete");
    expect(deriveConsensus([vote("a", "code")], 0).kind).toBe("incomplete");
    expect(deriveConsensus([vote("a", "code")], -1).kind).toBe("incomplete");
  });

  test("a panel larger than stated still needs everyone to agree", () => {
    const v = deriveConsensus([vote("a", "code"), vote("b", "code"), vote("c", "qa")], 2);
    expect(v.kind).toBe("split");
  });
});

describe("panel diversity — the acceptance criterion, enforced not documented", () => {
  test("the shipped reference panel has three distinct lineages", () => {
    expect(checkPanelDiversity(REFERENCE_PANEL)).toEqual({ ok: true });
    expect(new Set(REFERENCE_PANEL.map((p) => p.lineage)).size).toBe(REFERENCE_PANEL.length);
    expect(REFERENCE_PANEL).toHaveLength(3);
  });

  test("the existing premium list is REJECTED — it is two Anthropic models plus one", () => {
    // The ticket's exact complaint, pinned: reusing PREMIUM_CANDIDATES would inflate agreement,
    // because two models sharing a lineage agreeing is not independent evidence.
    expect(PREMIUM_CANDIDATES).toEqual(["claude-fable-5", "claude-opus-4-8", "gemini-2.5-pro"]);
    const asPanel = PREMIUM_CANDIDATES.map((id) =>
      panelist(id, id.startsWith("claude") ? "anthropic" : "google"),
    );
    expect(checkPanelDiversity(asPanel)).toEqual({ ok: false, repeated: ["anthropic"] });
  });

  test("lineage is not the API provider — two lineages behind one gateway still pass", () => {
    // openrouter serves many lineages, so keying diversity on `provider` would reject an
    // honestly diverse panel and accept a fake one.
    const gateway = [
      panelist("vendor/one", "alpha", { model: { ...A.model, id: "one", provider: "openrouter" } }),
      panelist("vendor/two", "beta", { model: { ...B.model, id: "two", provider: "openrouter" } }),
    ];
    expect(checkPanelDiversity(gateway)).toEqual({ ok: true });
  });

  test("an empty panel is not diverse — it is no panel", () => {
    expect(checkPanelDiversity([]).ok).toBe(false);
  });
});

describe("panel prices are pinned to the harness's own model registry", () => {
  test("every panelist's cost matches the registry entry with the same id", () => {
    // The panel carries its own Model so the projection and the call that gets billed cannot
    // disagree. That freedom is exactly how prices drift, so it is pinned here instead.
    for (const p of REFERENCE_PANEL) {
      const seeded = SEED_MODELS.find((m) => m.id === p.model.id);
      expect(seeded, `${p.model.id} is not in SEED_MODELS`).toBeDefined();
      expect(p.model.cost.input).toBe(seeded!.cost.input);
      expect(p.model.cost.output).toBe(seeded!.cost.output);
      expect(p.model.provider).toBe(seeded!.provider);
      expect(p.model.api).toBe(seeded!.api);
    }
  });

  test("a server-side reasoning panelist declares an allowance well above a bare label", () => {
    // Hidden reasoning tokens bill as output. A 40-token allowance on such a leg understates
    // its cost by an order of magnitude, which is the number the ceiling is chosen against.
    for (const p of REFERENCE_PANEL) {
      if (p.reasonsServerSide) expect(p.outputTokensPerCall).toBeGreaterThan(100);
      else expect(p.outputTokensPerCall).toBe(40);
    }
  });
});

describe("promptHash — the key, and the reason the text is never stored", () => {
  test("is sha256 hex of the exact text, and reveals nothing about it", () => {
    const h = promptHash("fix the parser");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(promptHash("fix the parser"));
    expect(h).not.toContain("fix");
  });

  test("distinctness is on the EXACT text — no trimming, no case folding", () => {
    // The corpus collapses on exact recorded text, so the key has to as well; normalizing here
    // would merge two corpus entries into one label.
    expect(promptHash("fix the parser")).not.toBe(promptHash("Fix the parser"));
    expect(promptHash("fix the parser")).not.toBe(promptHash(" fix the parser "));
  });

  test("voteKey pairs a hash with a panelist and nothing else", () => {
    expect(voteKey("abc", "model-a")).toBe(voteKey("abc", "model-a"));
    expect(voteKey("abc", "model-a")).not.toBe(voteKey("abc", "model-b"));
  });
});

describe("planPanelRun — what is left to pay for", () => {
  const prompts = [prompt("one"), prompt("two")];

  test("with an empty cache, every panelist owes every prompt", () => {
    const plans = planPanelRun(prompts, TRIO, new Set());
    expect(plans).toHaveLength(3);
    expect(plans.map((p) => p.todo.length)).toEqual([2, 2, 2]);
    expect(plans.map((p) => p.cached)).toEqual([0, 0, 0]);
  });

  test("a cached (prompt, panelist) pair drops out of that panelist's work only", () => {
    const cached = new Set([voteKey(promptHash("one"), "model-a")]);
    const plans = planPanelRun(prompts, TRIO, cached);
    expect(plans[0]!.todo.map((w) => w.prompt.text)).toEqual(["two"]);
    expect(plans[0]!.cached).toBe(1);
    expect(plans[1]!.todo).toHaveLength(2);
  });

  test("a fully cached corpus owes nothing — the rerun downstream tickets depend on", () => {
    const cached = new Set(
      TRIO.flatMap((p) => prompts.map((q) => voteKey(promptHash(q.text), p.model.id))),
    );
    const plans = planPanelRun(prompts, TRIO, cached);
    expect(plans.every((p) => p.todo.length === 0)).toBe(true);
    expect(projectPanelCost(plans).totalUsd).toBe(0);
  });
});

describe("projectPanelCost — the figure the ceiling is checked against", () => {
  test("prices only the OUTSTANDING work, per leg, at each panelist's own allowance", () => {
    const prompts = [prompt("x".repeat(400))]; // 100 prompt tokens on the chars/4 heuristic
    const rich = panelist("rich", "alpha", {
      model: { ...A.model, id: "rich", cost: { input: 2, output: 10 } },
      outputTokensPerCall: 250,
      reasonsServerSide: true,
    });
    const est = projectPanelCost(planPanelRun(prompts, [rich], new Set()));
    // input = (100 prompt + 99 instruction) tokens; output = the declared 250-token allowance.
    expect(est.totalInputTokens).toBe(199);
    expect(est.totalOutputTokens).toBe(250);
    expect(est.totalUsd).toBeCloseTo((199 / 1e6) * 2 + (250 / 1e6) * 10, 10);
  });

  test("each leg carries the prices it was costed at, so the total can be re-derived", () => {
    const est = projectPanelCost(planPanelRun([prompt("one")], TRIO, new Set()));
    expect(est.lines.map((l) => l.label)).toEqual([
      "panel: model-a",
      "panel: model-b",
      "panel: model-c",
    ]);
    for (const l of est.lines) {
      expect(l.inputUsdPerMTok).toBe(1);
      expect(l.outputUsdPerMTok).toBe(1);
    }
    expect(est.totalCalls).toBe(3);
  });

  test("panelCallSpecs states the fixed instruction overhead on every leg", () => {
    // CLASSIFY_SYSTEM is ~99 tokens against a ~17-token average prompt here; omitting it
    // understates input by nearly 7x.
    for (const s of panelCallSpecs(TRIO)) {
      expect(s.fixedInputTokensPerCall).toBe(99);
      expect(s.callsPerPrompt).toBe(1);
    }
  });
});

describe("the spend guard — the live cap, watching realized cost as it accrues", () => {
  test("permits dispatch until realized spend reaches the ceiling", () => {
    const g = makeSpendGuard(1.0);
    expect(g.mayDispatch()).toBe(true);
    g.book(0.9);
    expect(g.remainingUsd()).toBeCloseTo(0.1, 10);
    expect(g.mayDispatch()).toBe(true);
    g.book(0.2);
    expect(g.spentUsd()).toBeCloseTo(1.1, 10);
    expect(g.mayDispatch()).toBe(false);
    expect(g.remainingUsd()).toBe(0);
  });

  test("a non-finite or negative booking cannot rewind the cap", () => {
    const g = makeSpendGuard(1.0);
    g.book(Number.NaN);
    g.book(-5);
    expect(g.spentUsd()).toBe(0);
    g.book(1.0);
    expect(g.mayDispatch()).toBe(false);
  });

  test("a zero or nonsense ceiling permits nothing", () => {
    expect(makeSpendGuard(0).mayDispatch()).toBe(false);
    expect(makeSpendGuard(Number.NaN).mayDispatch()).toBe(false);
  });
});

describe("runPanel — the billable path, driven by a fake caller", () => {
  const prompts = [prompt("one"), prompt("two")];

  /** A caller that answers every panelist with `label` at a fixed price. */
  const caller =
    (outcome: (p: Panelist, text: string) => PanelCallOutcome) =>
    async (p: Panelist, text: string) =>
      outcome(p, text);

  test("records one vote per call and reports what it spent", async () => {
    const written: unknown[] = [];
    const res = await runPanel({
      plans: planPanelRun(prompts, TRIO, new Set()),
      corpusRev: CORPUS_REV,
      call: caller(() => ({
        kind: "labelled",
        taskType: "code",
        difficulty: "easy",
        confidence: 0.9,
        usd: 0.001,
      })),
      record: (v) => written.push(v),
      guard: makeSpendGuard(10),
      concurrency: 2,
    });
    expect(res.attempted).toBe(6);
    expect(res.labelled).toBe(6);
    expect(res.spentUsd).toBeCloseTo(0.006, 10);
    expect(written).toHaveLength(6);
    expect(written[0]).toMatchObject({ corpusRev: CORPUS_REV, taskType: "code" });
  });

  test("an unusable reply is CACHED as a null label — deterministic, so a rerun should not pay again", () => {
    // Mirrors the shipped classifier's own distinction, so a parse failure means the same thing
    // on both sides of the comparison MUB-218 will make.
    const written: { taskType?: unknown }[] = [];
    return runPanel({
      plans: planPanelRun([prompt("one")], [A], new Set()),
      corpusRev: CORPUS_REV,
      call: caller(() => ({ kind: "unusable", usd: 0.001 })),
      record: (v) => written.push(v),
      guard: makeSpendGuard(10),
    }).then((res) => {
      expect(res.unusable).toBe(1);
      expect(written).toHaveLength(1);
      expect(written[0]!.taskType).toBeNull();
    });
  });

  test("a FAILED call writes no row, so a rerun retries it", async () => {
    // A transient 429 must not permanently poison a label.
    const written: unknown[] = [];
    const res = await runPanel({
      plans: planPanelRun([prompt("one")], [A], new Set()),
      corpusRev: CORPUS_REV,
      call: caller(() => ({ kind: "failed", usd: 0 })),
      record: (v) => written.push(v),
      guard: makeSpendGuard(10),
    });
    expect(res.failed).toBe(1);
    expect(written).toHaveLength(0);
  });

  test("a caller that throws is a failure, never an exception out of the run", async () => {
    const res = await runPanel({
      plans: planPanelRun([prompt("one")], [A], new Set()),
      corpusRev: CORPUS_REV,
      call: async () => {
        throw new Error("connection reset");
      },
      record: () => {},
      guard: makeSpendGuard(10),
    });
    expect(res.failed).toBe(1);
  });

  test("the live cap stops dispatch mid-run and reports what it skipped", async () => {
    const written: unknown[] = [];
    const res = await runPanel({
      plans: planPanelRun(prompts, TRIO, new Set()),
      corpusRev: CORPUS_REV,
      call: caller(() => ({ kind: "labelled", taskType: "qa", confidence: 1, usd: 1 })),
      record: (v) => written.push(v),
      guard: makeSpendGuard(2),
      concurrency: 1,
    });
    // Serial dispatch: the third call is refused because $2 of $2 is already spent.
    expect(res.attempted).toBe(2);
    expect(res.skippedForCeiling).toBe(4);
    expect(written).toHaveLength(2);
    expect(res.ceilingHit).toBe(true);
  });

  test("a ledger that rejects a write STOPS the run rather than keep buying", async () => {
    // Persistence is the product here. A run whose writes are failing would go on paying for
    // labels nothing stores — at a few hundred paid calls that is real money spent on nothing.
    let calls = 0;
    const res = await runPanel({
      plans: planPanelRun(prompts, TRIO, new Set()),
      corpusRev: CORPUS_REV,
      call: caller(() => {
        calls++;
        return { kind: "labelled", taskType: "code", confidence: 1, usd: 0.01 };
      }),
      record: () => {
        throw new Error("SQLITE_BUSY");
      },
      guard: makeSpendGuard(10),
      concurrency: 1,
    });
    expect(res.ledgerFailed).toBe(true);
    expect(calls).toBe(1);
    expect(res.skippedForLedger).toBe(5);
    // It stopped for the ledger, not for money — the two exits must stay distinguishable.
    expect(res.ceilingHit).toBe(false);
    expect(res.spentUsd).toBeCloseTo(0.01, 10);
  });

  test("nothing outstanding spends nothing and calls no one", async () => {
    let calls = 0;
    const res = await runPanel({
      plans: planPanelRun([], TRIO, new Set()),
      corpusRev: CORPUS_REV,
      call: async () => {
        calls++;
        return { kind: "failed", usd: 0 };
      },
      record: () => {},
      guard: makeSpendGuard(10),
    });
    expect(calls).toBe(0);
    expect(res).toMatchObject({ attempted: 0, spentUsd: 0, ceilingHit: false });
  });
});

describe("makePanelCaller — how a reply becomes a vote, or fails to", () => {
  /** A stubbed completion with a given stop reason and body, priced at a fixed cost. */
  const reply = (text: string, stop_reason: StopReason, usd = 0.002) =>
    (async () =>
      new AssistantMessage({
        content: [textBlock(text)],
        stop_reason,
        usage: { cost: { total: usd } },
      })) as unknown as typeof complete;

  const label = '{"task_type":"code","difficulty":"easy","confidence":0.9}';

  test("a complete, parseable reply is a labelled vote carrying its realized cost", async () => {
    const out = await makePanelCaller(reply(label, "stop"))(A, "fix the parser");
    expect(out).toMatchObject({
      kind: "labelled",
      taskType: "code",
      difficulty: "easy",
      usd: 0.002,
    });
  });

  test("a complete reply that will not parse is UNUSABLE — cached, so a rerun does not re-pay", async () => {
    const out = await makePanelCaller(reply("I think this is a coding task!", "stop"))(A, "x");
    expect(out.kind).toBe("unusable");
  });

  test("a TRUNCATED reply is a failure, not a cached non-answer", async () => {
    // The expensive bug this pins. Two of three panelists reason server-side into the same
    // max_tokens budget, so `length` is reachable — and caching it as a null vote would exclude
    // an already-paid-for prompt permanently, from a panel that could still have labelled it.
    // This is where the panel deliberately diverges from classify.ts, which sets no max_tokens.
    const out = await makePanelCaller(reply("", "length"))(A, "x");
    expect(out.kind).toBe("failed");
    expect(out.usd).toBe(0.002); // it still billed — the money is gone either way
  });

  test("an aborted or errored call is a failure too", async () => {
    expect((await makePanelCaller(reply("", "aborted"))(A, "x")).kind).toBe("failed");
    expect((await makePanelCaller(reply("", "error"))(A, "x")).kind).toBe("failed");
  });

  test("a reply with no usable cost figure books zero rather than NaN", async () => {
    const noUsage = (async () =>
      new AssistantMessage({
        content: [textBlock(label)],
        stop_reason: "stop",
      })) as unknown as typeof complete;
    const out = await makePanelCaller(noUsage)(A, "x");
    expect(out.usd).toBe(0);
  });

  test("the panelist's own model is what gets called, and the instruction is the shipped one", async () => {
    // The panel is a stronger-models replay of the exact call under test; if the instruction
    // drifted from CLASSIFY_SYSTEM, a measured gap would be prompt difference, not capability.
    let sawModel = "";
    let sawSystem = "";
    const spy = (async (model: Model, ctx: { system_prompt?: string }) => {
      sawModel = model.id;
      sawSystem = ctx.system_prompt ?? "";
      return new AssistantMessage({ content: [textBlock(label)], stop_reason: "stop" });
    }) as unknown as typeof complete;
    await makePanelCaller(spy)(B, "ship the thing");
    expect(sawModel).toBe("model-b");
    expect(sawSystem).toBe(CLASSIFY_SYSTEM);
  });
});

describe("buildReferenceLabels — the pseudo-gold set MUB-218 and MUB-226 consume", () => {
  const corpus = [prompt("p1"), prompt("p2"), prompt("p3")];
  const votes: ConsensusVoteRow[] = [
    row("p1", "model-a", "code"),
    row("p1", "model-b", "code"),
    row("p1", "model-c", "code"),
    row("p2", "model-a", "code"),
    row("p2", "model-b", "qa"),
    row("p2", "model-c", "code"),
    row("p3", "model-a", "qa"),
    row("p3", "model-b", "qa"),
    row("p3", "model-c", null),
  ];

  test("only unanimous panels earn a label, keyed by prompt hash", () => {
    const labels = buildReferenceLabels(corpus, TRIO, votes, CORPUS_REV);
    expect(labels.get(promptHash("p1"))).toBe("code");
    expect(labels.size).toBe(1);
  });

  test("split and incomplete prompts are ABSENT, never present with a null", () => {
    // A caller iterating this map must not be able to score a prompt that has no reference label.
    const labels = buildReferenceLabels(corpus, TRIO, votes, CORPUS_REV);
    expect(labels.has(promptHash("p2"))).toBe(false);
    expect(labels.has(promptHash("p3"))).toBe(false);
  });

  test("it agrees with the report's headline count — one quorum rule, not two", () => {
    const labels = buildReferenceLabels(corpus, TRIO, votes, CORPUS_REV);
    const report = buildPanelReport(corpus, TRIO, votes, CORPUS_REV);
    expect(labels.size).toBe(report.referenceLabels);
    expect(labels.size).toBe(report.unanimity.n);
  });

  test("a stale corpus revision yields no labels at all", () => {
    const stale = votes.map((v) => ({ ...v, corpus_rev: "r1-before" }));
    expect(buildReferenceLabels(corpus, TRIO, stale, CORPUS_REV).size).toBe(0);
  });
});

describe("outstanding work and the run readout — reported numbers, out of the shell", () => {
  const corpus = [prompt("one"), prompt("two")];

  test("the cached share is a rate over corpus x panel, not over the corpus", () => {
    // "3 of 6 votes cached" and "3 of 2 prompts cached" are different claims; the denominator
    // is the only thing that says which was meant.
    const cached = new Set([
      voteKey(promptHash("one"), "model-a"),
      voteKey(promptHash("one"), "model-b"),
      voteKey(promptHash("two"), "model-a"),
    ]);
    const w = summarizeOutstanding(planPanelRun(corpus, TRIO, cached), corpus.length, CORPUS_REV);
    expect(w.votesCached).toEqual({ n: 3, d: 6, pct: 50 });
    expect(w.cost.totalCalls).toBe(3);
    expect(renderOutstandingWork(w)).toContain("3/6 (50.0%)");
    expect(renderOutstandingWork(w)).toContain(CORPUS_REV);
  });

  test("a fully cached panel reports every vote cached and no cost", () => {
    const all = new Set(
      TRIO.flatMap((p) => corpus.map((q) => voteKey(promptHash(q.text), p.model.id))),
    );
    const w = summarizeOutstanding(planPanelRun(corpus, TRIO, all), corpus.length, CORPUS_REV);
    expect(w.votesCached).toEqual({ n: 6, d: 6, pct: 100 });
    expect(w.cost.totalUsd).toBe(0);
  });

  test("the run readout states realized against projected, with its denominator", () => {
    const out = renderPanelRunResult(
      {
        attempted: 10,
        labelled: 9,
        unusable: 1,
        failed: 0,
        skippedForCeiling: 0,
        ceilingHit: false,
        skippedForLedger: 0,
        ledgerFailed: false,
        spentUsd: 0.5,
      },
      1.0,
    );
    expect(out).toContain("10 calls · 9 labelled · 1 unusable · 0 failed");
    // The percentage needs no separate denominator: both figures it divides are on the line.
    expect(out).toContain("realized $0.5000 against a $1.0000 projection (50.0% of it)");
  });

  test("a zero projection reports n/a rather than dividing by it", () => {
    const out = renderPanelRunResult(
      {
        attempted: 0,
        labelled: 0,
        unusable: 0,
        failed: 0,
        skippedForCeiling: 0,
        ceilingHit: false,
        skippedForLedger: 0,
        ledgerFailed: false,
        spentUsd: 0,
      },
      0,
    );
    expect(out).toContain("(n/a of it)");
  });

  test("failed calls are called out as the thing a rerun would pay for", () => {
    const base = {
      attempted: 5,
      labelled: 4,
      unusable: 0,
      skippedForCeiling: 0,
      ceilingHit: false,
      skippedForLedger: 0,
      ledgerFailed: false,
      spentUsd: 0.1,
    };
    expect(renderPanelRunResult({ ...base, failed: 1 }, 0.1)).toContain("re-running pays only");
    expect(renderPanelRunResult({ ...base, failed: 0 }, 0.1)).not.toContain("re-running pays only");
  });
});

describe("buildPanelReport — the headline output, with every denominator attached", () => {
  const corpus = [prompt("p1"), prompt("p2"), prompt("p3"), prompt("p4")];

  function votes(): ConsensusVoteRow[] {
    return [
      // p1: unanimous `code`
      row("p1", "model-a", "code"),
      row("p1", "model-b", "code"),
      row("p1", "model-c", "code"),
      // p2: unanimous `qa`
      row("p2", "model-a", "qa"),
      row("p2", "model-b", "qa"),
      row("p2", "model-c", "qa"),
      // p3: 2-1 split, code vs reasoning
      row("p3", "model-a", "code"),
      row("p3", "model-b", "code"),
      row("p3", "model-c", "reasoning"),
      // p4: incomplete — model-c never produced a usable label
      row("p4", "model-a", "code"),
      row("p4", "model-b", "code"),
      row("p4", "model-c", null),
    ];
  }

  test("unanimity is reported over COMPLETE panels, and coverage over the corpus", () => {
    const r = buildPanelReport(corpus, TRIO, votes(), CORPUS_REV);
    expect(r.corpusPrompts).toBe(4);
    expect(r.completePanels).toEqual({ n: 3, d: 4, pct: 75 });
    expect(r.unanimity).toEqual({ n: 2, d: 3, pct: 66.7 });
    expect(r.split).toBe(1);
    expect(r.incomplete).toBe(1);
  });

  test("a split is excluded from the scored set and counted, per the acceptance criteria", () => {
    const r = buildPanelReport(corpus, TRIO, votes(), CORPUS_REV);
    expect(r.referenceLabels).toBe(2);
    expect(r.excludedSplit).toBe(1);
    expect(r.excludedIncomplete).toBe(1);
    expect(r.referenceLabels + r.excludedSplit + r.excludedIncomplete).toBe(r.corpusPrompts);
  });

  test("per-task-type unanimity uses `named by at least one panelist` as its denominator", () => {
    // A split prompt lands in the denominator of EVERY label named on it, so these denominators
    // deliberately sum to more than the corpus. The alternative — attributing a split to its
    // majority label — would hide exactly the disagreement this report exists to surface.
    const r = buildPanelReport(corpus, TRIO, votes(), CORPUS_REV);
    const byLabel = Object.fromEntries(r.perLabel.map((l) => [l.label, l.unanimous]));
    expect(byLabel.code).toEqual({ n: 1, d: 2, pct: 50 }); // p1 unanimous, p3 named-but-split
    expect(byLabel.qa).toEqual({ n: 1, d: 1, pct: 100 });
    expect(byLabel.reasoning).toEqual({ n: 0, d: 1, pct: 0 });
  });

  test("the task types the panel most often disagrees on come back ranked, as pairs", () => {
    const r = buildPanelReport(corpus, TRIO, votes(), CORPUS_REV);
    expect(r.topDisagreements[0]).toEqual({ labels: ["code", "reasoning"], count: 1 });
  });

  test("per-panelist coverage and pairwise agreement — the diversity premise, measured", () => {
    const r = buildPanelReport(corpus, TRIO, votes(), CORPUS_REV);
    expect(r.panelists.find((p) => p.modelId === "model-c")!.usable).toEqual({
      n: 3,
      d: 4,
      pct: 75,
    });
    // Pairwise is over prompts BOTH panelists labelled — so it spans p4, which is incomplete
    // for the panel but labelled by both a and b. A pair's reliability is not conditioned on a
    // third panelist having shown up.
    const ab = r.pairwise.find((p) => p.a === "model-a" && p.b === "model-b")!;
    expect(ab.agree).toEqual({ n: 4, d: 4, pct: 100 });
    const ac = r.pairwise.find((p) => p.a === "model-a" && p.b === "model-c")!;
    expect(ac.agree).toEqual({ n: 2, d: 3, pct: 66.7 });
  });

  test("votes from another corpus revision are ignored, not counted as labels", () => {
    const stale = votes().map((v) => ({ ...v, corpus_rev: "r1-before" }));
    const r = buildPanelReport(corpus, TRIO, stale, CORPUS_REV);
    expect(r.completePanels.n).toBe(0);
    expect(r.unanimity).toEqual({ n: 0, d: 0, pct: null });
  });

  test("votes for prompts no longer in the corpus are ignored", () => {
    const r = buildPanelReport([prompt("p1")], TRIO, votes(), CORPUS_REV);
    expect(r.corpusPrompts).toBe(1);
    expect(r.completePanels).toEqual({ n: 1, d: 1, pct: 100 });
  });

  test("votes from a model outside the panel do not complete a panel", () => {
    const withStranger = [...votes(), row("p4", "model-z", "code")];
    const r = buildPanelReport(corpus, TRIO, withStranger, CORPUS_REV);
    expect(r.completePanels.n).toBe(3);
  });

  test("an unlabelled corpus reports zero over its real denominator, never a bare zero", () => {
    const r = buildPanelReport(corpus, TRIO, [], CORPUS_REV);
    expect(r.completePanels).toEqual({ n: 0, d: 4, pct: 0 });
    expect(r.unanimity).toEqual({ n: 0, d: 0, pct: null });
    expect(r.perLabel).toEqual([]);
  });
});

describe("renderPanelReport — what a reader is allowed to quote", () => {
  const corpus = [prompt("deploy the thing"), prompt("what does this regex do")];
  const rendered = () =>
    renderPanelReport(
      buildPanelReport(
        corpus,
        TRIO,
        [
          row("deploy the thing", "model-a", "code"),
          row("deploy the thing", "model-b", "code"),
          row("deploy the thing", "model-c", "code"),
          row("what does this regex do", "model-a", "qa"),
          row("what does this regex do", "model-b", "code"),
          row("what does this regex do", "model-c", "qa"),
        ],
        CORPUS_REV,
      ),
    );

  test("contains no prompt text — the corpus is the owner's own traffic", () => {
    const out = rendered();
    expect(out).not.toContain("deploy the thing");
    expect(out).not.toContain("what does this regex do");
    expect(out).not.toContain(promptHash("deploy the thing"));
  });

  test("states plainly that consensus is not truth, and that blind spots survive diversity", () => {
    expect(rendered().toLowerCase()).toContain("consensus is not truth");
    expect(rendered().toLowerCase()).toContain("blind spot");
  });

  test("names the corpus revision and the panel's lineages", () => {
    const out = rendered();
    expect(out).toContain(CORPUS_REV);
    for (const p of TRIO) expect(out).toContain(p.lineage);
  });

  test("every rate printed carries its denominator", () => {
    // A bare percentage over single-digit support is the most likely way this evaluation
    // misleads, so no figure may appear without the count it came from.
    for (const line of rendered().split("\n")) {
      const pct = line.match(/\d+\.\d%/);
      if (pct) expect(line).toMatch(/\d+\/\d+/);
    }
  });

  test("says which task types the panel disagreed on", () => {
    expect(rendered()).toContain("code");
    expect(rendered()).toContain("qa");
  });
});

describe("the ledger round-trip (ADR 0001's storage contract)", () => {
  function ledger(): MinimaDb {
    return new MinimaDb(":memory:");
  }

  test("a vote survives the write and comes back scoped to its revision", () => {
    const db = ledger();
    db.upsertConsensusVote({
      promptHash: promptHash("fix the parser"),
      modelId: "model-a",
      corpusRev: CORPUS_REV,
      taskType: "code",
      difficulty: "easy",
      confidence: 0.9,
      ts: 1,
    });
    const rows = db.listConsensusVotes(CORPUS_REV);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model_id: "model-a", task_type: "code", confidence: 0.9 });
    expect(db.listConsensusVotes("r1-before")).toHaveLength(0);
    db.close();
  });

  test("the ledger stores the hash and never the text", () => {
    const db = ledger();
    const text = "a prompt that must not be readable back";
    db.upsertConsensusVote({ promptHash: promptHash(text), modelId: "m", corpusRev: CORPUS_REV });
    const dumped = JSON.stringify(db.listConsensusVotes(CORPUS_REV));
    expect(dumped).not.toContain("must not be readable");
    expect(dumped).toContain(promptHash(text));
    db.close();
  });

  test("one row per (prompt_hash, model_id) — a re-vote replaces, never accumulates", () => {
    const db = ledger();
    const h = promptHash("one");
    db.upsertConsensusVote({
      promptHash: h,
      modelId: "m",
      corpusRev: CORPUS_REV,
      taskType: "code",
    });
    db.upsertConsensusVote({ promptHash: h, modelId: "m", corpusRev: CORPUS_REV, taskType: "qa" });
    const rows = db.listConsensusVotes(CORPUS_REV);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.task_type).toBe("qa");
    db.close();
  });

  test("re-labelling at a new revision moves the row's revision — the old rev goes cold", () => {
    const db = ledger();
    const h = promptHash("one");
    db.upsertConsensusVote({
      promptHash: h,
      modelId: "m",
      corpusRev: "r1-before",
      taskType: "code",
    });
    db.upsertConsensusVote({
      promptHash: h,
      modelId: "m",
      corpusRev: CORPUS_REV,
      taskType: "code",
    });
    expect(db.listConsensusVotes("r1-before")).toHaveLength(0);
    expect(db.listConsensusVotes(CORPUS_REV)).toHaveLength(1);
    db.close();
  });

  test("two panelists on one prompt are two rows — the individual votes, not a verdict", () => {
    const db = ledger();
    const h = promptHash("one");
    db.upsertConsensusVote({
      promptHash: h,
      modelId: "a",
      corpusRev: CORPUS_REV,
      taskType: "code",
    });
    db.upsertConsensusVote({ promptHash: h, modelId: "b", corpusRev: CORPUS_REV, taskType: "qa" });
    const rows = db.listConsensusVotes(CORPUS_REV);
    expect(rows).toHaveLength(2);
    expect(
      deriveConsensus(
        rows.map((r) => ({ modelId: r.model_id, taskType: r.task_type as TaskType | null })),
        2,
      ).kind,
    ).toBe("split");
    db.close();
  });

  test("a null task_type round-trips as a cached non-answer, not as a missing row", () => {
    const db = ledger();
    db.upsertConsensusVote({ promptHash: promptHash("one"), modelId: "m", corpusRev: CORPUS_REV });
    const rows = db.listConsensusVotes(CORPUS_REV);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.task_type).toBeNull();
    db.close();
  });
});
