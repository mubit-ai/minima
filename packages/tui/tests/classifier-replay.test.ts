import { describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  resetProviderRegistration,
  resetRegistry,
  text as textBlock,
} from "../src/ai/index.ts";
import { CHEAP_FALLBACK_MODELS } from "../src/ai/model_fallback.ts";
import { SEED_MODELS } from "../src/cli/main.ts";
import { MinimaDb, type ReplayLabelRow, type UserPromptRow } from "../src/db/minima_db.ts";
import {
  CORPUS_REV,
  type DistinctPrompt,
  LABEL_INSTRUCTION_TOKENS,
  LABEL_OUTPUT_TOKENS,
} from "../src/minima/classifier_eval.ts";
import { buildScoreReport } from "../src/minima/classifier_eval_wiring.ts";
import {
  CLASSIFY_PROMPT_CHARS,
  REPLAY_MODELS,
  type ReplayModel,
  countTruncated,
  makeReplayCaller,
  planReplayRun,
  projectReplayCost,
  renderReplayCoverage,
  renderReplayOutstanding,
  renderReplayRunResult,
  replayCallSpecs,
  runReplay,
  summarizeReplayOutstanding,
  toModelReplays,
} from "../src/minima/classifier_replay.ts";
import {
  CLASSIFY_CONFIDENCE_FLOOR,
  type ClassifyOutcome,
  TaskClassifier,
  classificationFromParts,
} from "../src/minima/classify.ts";
import { promptHash, voteKey } from "../src/minima/consensus_panel.ts";

// MUB-218 — the producer the scoring instrument was built against and never had. Nothing here
// calls a model: `runReplay` and `makeReplayCaller` both take their collaborator as an argument,
// so the whole billable path is exercised with fakes that spend fake money.

/** A replay model with stated prices, for tests that do not care which model it is. */
function replayModel(modelId: string, over: Partial<ReplayModel> = {}): ReplayModel {
  return {
    model: {
      id: modelId,
      provider: "faux",
      api: "faux",
      name: modelId,
      cost: { input: 1, output: 2 },
      context_window: 8192,
      max_tokens: 1024,
    },
    role: "test",
    outputTokensPerCall: LABEL_OUTPUT_TOKENS,
    ...over,
  };
}

const A = replayModel("model-a");
const B = replayModel("model-b");

const prompt = (text: string, occurrences = 1): DistinctPrompt => ({ text, occurrences });

/** A stored label row, as `listReplayLabels` returns it. */
function row(
  hash: string,
  modelId: string,
  taskType: string | null,
  over: Partial<ReplayLabelRow> = {},
): ReplayLabelRow {
  return {
    prompt_hash: hash,
    model_id: modelId,
    corpus_rev: CORPUS_REV,
    task_type: taskType,
    difficulty: taskType === null ? null : "easy",
    confidence: taskType === null ? null : 0.9,
    created_at: 0,
    ...over,
  };
}

/** A classifier stand-in that reports one scripted outcome and books one cost. */
function scripted(outcome: ClassifyOutcome | null, usd = 0.002) {
  return (
    _m: ReplayModel,
    opts: { onCostUsd?: (n: number) => void; onOutcome?: (o: ClassifyOutcome) => void },
  ) => ({
    classify: async () => {
      opts.onCostUsd?.(usd);
      if (outcome) opts.onOutcome?.(outcome);
      return outcome?.kind === "labelled" ? outcome.classification : null;
    },
  });
}

const LABELLED: ClassifyOutcome = {
  kind: "labelled",
  classification: { taskType: "code", difficulty: "easy", confidence: 0.9 },
  stopReason: "stop",
};

describe("REPLAY_MODELS — the models under test, pinned to the registry that prices them", () => {
  test("every replay model's prices and transport match SEED_MODELS", () => {
    // The Model is carried inline so the projection and the billed call cannot disagree. That
    // freedom is exactly how a price goes stale, so the pin is the thing that catches it.
    for (const m of REPLAY_MODELS) {
      const seeded = SEED_MODELS.find((s) => s.id === m.model.id);
      expect(seeded, `${m.model.id} is not in SEED_MODELS`).toBeDefined();
      expect(m.model.cost.input).toBe(seeded!.cost.input);
      expect(m.model.cost.output).toBe(seeded!.cost.output);
      expect(m.model.provider).toBe(seeded!.provider);
      expect(m.model.api).toBe(seeded!.api);
    }
  });

  test("the FIRST model is the one production actually classifies with", () => {
    // Every accuracy figure the readout prints is about this model. `cli/main.ts` builds the
    // production classifier from `config.classifyModel ?? CHEAP_FALLBACK_MODELS[0]`, and
    // `classifyModel` defaults to null — so if this drifted, the headline would describe a model
    // no user runs.
    expect(REPLAY_MODELS[0]?.model.id).toBe(CHEAP_FALLBACK_MODELS[0]);
  });

  test("two models from different providers, so the switch cost is measurable at all", () => {
    expect(REPLAY_MODELS.length).toBeGreaterThanOrEqual(2);
    const providers = new Set(REPLAY_MODELS.map((m) => m.model.provider));
    expect(providers.size).toBe(REPLAY_MODELS.length);
  });

  test("neither model reasons server-side, so the bare label allowance is honest", () => {
    for (const m of REPLAY_MODELS) expect(m.outputTokensPerCall).toBe(LABEL_OUTPUT_TOKENS);
  });
});

describe("replayCallSpecs — the cost leg, charging what the call really sends", () => {
  test("every leg pays the shipped instruction as fixed input", () => {
    // ~99 tokens against a ~17-token average prompt: a silently-defaulted zero understates input
    // by nearly 7x, and this is the number a ceiling gets chosen against.
    for (const spec of replayCallSpecs(REPLAY_MODELS)) {
      expect(spec.fixedInputTokensPerCall).toBe(LABEL_INSTRUCTION_TOKENS);
      expect(spec.callsPerPrompt).toBe(1);
    }
  });

  test("prices come from the model, not from a copy in the eval core", () => {
    const [a] = replayCallSpecs([A]);
    expect(a?.inputUsdPerMTok).toBe(1);
    expect(a?.outputUsdPerMTok).toBe(2);
    expect(a?.label).toBe("replay: model-a");
  });
});

describe("countTruncated — the shipped 8000-char cap, counted rather than assumed away", () => {
  test("counts only entries the cap actually reaches", () => {
    const long = "x".repeat(CLASSIFY_PROMPT_CHARS + 1);
    expect(countTruncated([prompt("short"), prompt(long)])).toBe(1);
    expect(countTruncated([prompt("short")])).toBe(0);
  });

  test("an entry exactly at the cap is NOT truncated — slice(0, N) keeps N characters", () => {
    expect(countTruncated([prompt("x".repeat(CLASSIFY_PROMPT_CHARS))])).toBe(0);
  });
});

describe("planReplayRun — what a run still owes, per model", () => {
  const corpus = [prompt("p1"), prompt("p2")];
  const hashOf = (t: string) => `h:${t}`;

  test("a cached (prompt, model) pair is not owed again; another model still owes it", () => {
    const cached = new Set([voteKey("h:p1", "model-a")]);
    const plans = planReplayRun(corpus, [A, B], cached, hashOf, voteKey);
    expect(plans[0]).toMatchObject({ cached: 1 });
    expect(plans[0]?.todo.map((w) => w.prompt.text)).toEqual(["p2"]);
    expect(plans[1]).toMatchObject({ cached: 0 });
    expect(plans[1]?.todo).toHaveLength(2);
  });

  test("the injected hash is the one used — a second implementation would miss everything", () => {
    // A cache keyed on a different hash reports a total miss and reads as "the classifier has
    // not labelled this corpus", which is a defect wearing a finding's clothes.
    const cached = new Set([voteKey(promptHash("p1"), "model-a")]);
    expect(planReplayRun(corpus, [A], cached, promptHash, voteKey)[0]?.cached).toBe(1);
    expect(planReplayRun(corpus, [A], cached, hashOf, voteKey)[0]?.cached).toBe(0);
  });
});

describe("summarizeReplayOutstanding — what --spend would pay, and what it cannot reproduce", () => {
  const corpus = [prompt("p1"), prompt("p2")];

  test("the cached share is denominated in corpus x models, not corpus", () => {
    const cached = new Set([voteKey(promptHash("p1"), "model-a")]);
    const work = summarizeReplayOutstanding(
      planReplayRun(corpus, [A, B], cached, promptHash, voteKey),
      corpus,
      CORPUS_REV,
    );
    expect(work.labelsCached).toMatchObject({ n: 1, d: 4 });
    expect(work.cost.totalCalls).toBe(3);
  });

  test("a fully cached corpus projects zero, so a rerun is free (ADR 0006)", () => {
    const cached = new Set(
      [A, B].flatMap((m) => corpus.map((p) => voteKey(promptHash(p.text), m.model.id))),
    );
    const work = summarizeReplayOutstanding(
      planReplayRun(corpus, [A, B], cached, promptHash, voteKey),
      corpus,
      CORPUS_REV,
    );
    expect(work.cost.totalCalls).toBe(0);
    expect(work.cost.totalUsd).toBe(0);
  });

  test("the truncation count rides along, and the renderer prints it even at zero", () => {
    const work = summarizeReplayOutstanding(
      planReplayRun(corpus, [A], new Set(), promptHash, voteKey),
      corpus,
      CORPUS_REV,
    );
    expect(work.truncatedEntries).toBe(0);
    expect(renderReplayOutstanding(work)).toContain(`entries over ${CLASSIFY_PROMPT_CHARS} chars`);
  });

  test("outstanding cost prices only the todo, at the leg's own prices", () => {
    const plans = planReplayRun([prompt("abcd")], [A], new Set(), promptHash, voteKey);
    const cost = projectReplayCost(plans);
    // 1 char-quad -> 1 token, + 99 fixed = 100 input; 40 output.
    expect(cost.lines[0]).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 40 });
  });
});

describe("makeReplayCaller — the THREE causes of a null, which cache differently", () => {
  test("a parsed reply is a label carrying its realized cost", async () => {
    const out = await makeReplayCaller(scripted(LABELLED))(A, "fix the parser");
    expect(out).toMatchObject({ kind: "labelled", usd: 0.002 });
    expect(out.kind === "labelled" && out.classification.taskType).toBe("code");
  });

  test("a complete reply that will not parse is UNUSABLE — deterministic, so it caches", async () => {
    const out = await makeReplayCaller(scripted({ kind: "unusable", stopReason: "stop" }))(A, "x");
    expect(out.kind).toBe("unusable");
  });

  test("a provider error is a FAILURE, named as one — retryable, writes nothing", async () => {
    const out = await makeReplayCaller(scripted({ kind: "provider-error" }))(A, "x");
    expect(out).toMatchObject({ kind: "failed", cause: "provider-error" });
  });

  test("a transport failure or timeout is a DIFFERENT failure, and stays distinguishable", async () => {
    const out = await makeReplayCaller(scripted({ kind: "transport-error" }))(A, "x");
    expect(out).toMatchObject({ kind: "failed", cause: "transport-error" });
  });

  test("a TRUNCATED reply is a failure, not a cached non-answer — MUB-216's bug, refused", async () => {
    // The expensive bug this pins, and the one place the replay deliberately diverges from
    // classify.ts. That classifier parses a `length` reply because its cache is an in-memory
    // per-session Map that costs nothing to rebuild. Here the cache is a durable, money-backed
    // ledger row: storing a truncation as a null label would permanently exclude a prompt that
    // was already paid for, from a model that could still have labelled it.
    const truncated = await makeReplayCaller(
      scripted({ kind: "labelled", ...LABELLED, stopReason: "length" }),
    )(A, "x");
    expect(truncated).toMatchObject({ kind: "failed", cause: "truncated" });
    const aborted = await makeReplayCaller(scripted({ kind: "unusable", stopReason: "aborted" }))(
      A,
      "x",
    );
    expect(aborted).toMatchObject({ kind: "failed", cause: "truncated" });
  });

  test("a truncated call still billed, so the money is reported even though nothing is stored", async () => {
    const out = await makeReplayCaller(scripted({ kind: "unusable", stopReason: "length" }, 0.004))(
      A,
      "x",
    );
    expect(out.usd).toBe(0.004);
  });

  test("a classifier that reports nothing is not entitled to a stored answer", async () => {
    // Unreachable through the shipped classifier, which reports on every path it takes. A
    // substitute that stays silent gets a retryable failure rather than a cached null.
    const out = await makeReplayCaller(scripted(null))(A, "x");
    expect(out).toMatchObject({ kind: "failed", cause: "transport-error" });
  });
});

describe("runReplay — the paid loop, driven by a fake that spends fake money", () => {
  const corpus = [prompt("p1"), prompt("p2"), prompt("p3")];
  const plansFor = (models: readonly ReplayModel[]) =>
    planReplayRun(corpus, models, new Set(), promptHash, voteKey);
  const guard = (maxUsd: number) => {
    let spent = 0;
    return {
      mayDispatch: () => spent < maxUsd,
      book: (u: number) => {
        spent += u;
      },
    };
  };

  test("writes each label as it lands, so an interrupted run keeps what it paid for", async () => {
    const written: string[] = [];
    const res = await runReplay({
      plans: plansFor([A]),
      corpusRev: CORPUS_REV,
      call: async () => ({ kind: "labelled", classification: LABELLED.classification, usd: 0.001 }),
      record: (l) => {
        written.push(l.promptHash);
      },
      guard: guard(10),
      concurrency: 1,
    });
    expect(res).toMatchObject({ attempted: 3, labelled: 3, unusable: 0, failed: 0 });
    expect(written).toHaveLength(3);
    expect(written).toContain(promptHash("p1"));
  });

  test("stores the RAW self-report, never the post-floor label", async () => {
    // The floor is the thing this whole evaluation argues about. A label filtered on it would
    // leave the reliability curve with no evidence at all in the region under argument.
    const belowFloor = CLASSIFY_CONFIDENCE_FLOOR - 0.3;
    const written: (number | null)[] = [];
    await runReplay({
      plans: plansFor([A]),
      corpusRev: CORPUS_REV,
      call: async () => ({
        kind: "labelled",
        classification: { taskType: "code", difficulty: "easy", confidence: belowFloor },
        usd: 0,
      }),
      record: (l) => {
        written.push(l.confidence);
      },
      guard: guard(10),
    });
    expect(written).toEqual([belowFloor, belowFloor, belowFloor]);
  });

  test("a failed call writes NO row, so a rerun retries exactly those", async () => {
    let writes = 0;
    const res = await runReplay({
      plans: plansFor([A]),
      corpusRev: CORPUS_REV,
      call: async () => ({ kind: "failed", cause: "provider-error", usd: 0.001 }),
      record: () => {
        writes++;
      },
      guard: guard(10),
    });
    expect(writes).toBe(0);
    expect(res.failed).toBe(3);
  });

  test("an unusable reply DOES write a row — a paid, deterministic non-answer", async () => {
    const written: (string | null)[] = [];
    const res = await runReplay({
      plans: plansFor([A]),
      corpusRev: CORPUS_REV,
      call: async () => ({ kind: "unusable", usd: 0.001 }),
      record: (l) => {
        written.push(l.taskType);
      },
      guard: guard(10),
    });
    expect(res.unusable).toBe(3);
    expect(written).toEqual([null, null, null]);
  });

  test("the three failure causes are counted apart, never summed into one", async () => {
    // A run rate-limited by its provider and a run whose replies are being truncated are not the
    // same finding, and only one of them is fixed by re-running.
    const causes = ["provider-error", "transport-error", "truncated"] as const;
    let i = 0;
    const res = await runReplay({
      plans: plansFor([A]),
      corpusRev: CORPUS_REV,
      call: async () => ({ kind: "failed", cause: causes[i++ % 3]!, usd: 0 }),
      record: () => {},
      guard: guard(10),
      concurrency: 1,
    });
    expect(res.failedByCause).toEqual({
      "provider-error": 1,
      "transport-error": 1,
      truncated: 1,
    });
    expect(res.failed).toBe(3);
    expect(renderReplayRunResult(res, 1)).toContain("1 provider error");
  });

  test("the live cap stops DISPATCH — calls not made are reported, not silently dropped", async () => {
    let calls = 0;
    const res = await runReplay({
      plans: plansFor([A]),
      corpusRev: CORPUS_REV,
      call: async () => {
        calls++;
        return { kind: "labelled", classification: LABELLED.classification, usd: 1 };
      },
      record: () => {},
      guard: guard(1),
      concurrency: 1,
    });
    expect(calls).toBe(1);
    expect(res).toMatchObject({ attempted: 1, skippedForCeiling: 2, ceilingHit: true });
  });

  test("a ledger that rejects a write STOPS the run — persistence is the product", async () => {
    let calls = 0;
    const res = await runReplay({
      plans: plansFor([A]),
      corpusRev: CORPUS_REV,
      call: async () => {
        calls++;
        return { kind: "labelled", classification: LABELLED.classification, usd: 0 };
      },
      record: () => {
        throw new Error("disk full");
      },
      guard: guard(10),
      concurrency: 1,
    });
    expect(calls).toBe(1);
    expect(res).toMatchObject({ ledgerFailed: true, skippedForLedger: 2 });
  });

  test("a caller that throws is one failed call, and the run continues", async () => {
    let calls = 0;
    const res = await runReplay({
      plans: plansFor([A]),
      corpusRev: CORPUS_REV,
      call: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { kind: "labelled", classification: LABELLED.classification, usd: 0 };
      },
      record: () => {},
      guard: guard(10),
      concurrency: 1,
    });
    expect(res).toMatchObject({ attempted: 3, labelled: 2 });
    expect(res.failedByCause["transport-error"]).toBe(1);
  });

  test("a fully cached plan dispatches nothing and spends nothing", async () => {
    let calls = 0;
    const cached = new Set(corpus.map((p) => voteKey(promptHash(p.text), "model-a")));
    const res = await runReplay({
      plans: planReplayRun(corpus, [A], cached, promptHash, voteKey),
      corpusRev: CORPUS_REV,
      call: async () => {
        calls++;
        return { kind: "failed", cause: "provider-error", usd: 0 };
      },
      record: () => {},
      guard: guard(10),
    });
    expect(calls).toBe(0);
    expect(res).toMatchObject({ attempted: 0, spentUsd: 0, ceilingHit: false });
  });
});

describe("toModelReplays — the cache read back, and the distinction the scorer depends on", () => {
  const corpus = ["p1", "p2", "p3"];
  const h = (t: string) => promptHash(t);
  const resolve = (rows: readonly ReplayLabelRow[], models = [A]) =>
    toModelReplays(corpus, rows, models, { corpusRev: CORPUS_REV, hashOf: promptHash });

  test("a stored NULL label is PRESENT with a null — the classifier answered and declined", () => {
    const r = resolve([row(h("p1"), "model-a", null)]);
    expect(r.replays[0]?.labels).toEqual([{ text: "p1", classification: null }]);
    expect(r.perModel[0]?.abstentions).toBe(1);
  });

  test("a MISSING row is ABSENT — a gap in coverage, not an abstention", () => {
    // Folding the second into the first would let a truncated replay report itself as a
    // fail-open rate. `scoreReplay` reads presence, so this is where that could go wrong.
    const r = resolve([row(h("p1"), "model-a", "code")]);
    expect(r.replays[0]?.labels.map((l) => l.text)).toEqual(["p1"]);
    expect(r.perModel[0]?.labelled).toMatchObject({ n: 1, d: 3 });
  });

  test("the text comes from the live corpus, never from the cache", () => {
    // The stored row is a hash and the hash is one-way, so this is the only possible direction.
    const r = resolve([row(h("p2"), "model-a", "code")]);
    expect(r.replays[0]?.labels[0]?.text).toBe("p2");
    expect(JSON.stringify(r.replays)).not.toContain(h("p2"));
  });

  test("a row at another corpus revision is absent, and counted (ADR 0001)", () => {
    const r = resolve([row(h("p1"), "model-a", "code", { corpus_rev: "r1-old" })]);
    expect(r.rowsAtOtherRev).toBe(1);
    expect(r.replays).toHaveLength(0);
  });

  test("a row whose prompt has left the corpus is counted, never recoverable", () => {
    const r = resolve([row(h("p1"), "model-a", "code"), row(h("gone"), "model-a", "code")]);
    expect(r.rowsWithoutCorpusEntry).toBe(1);
  });

  test("a row from a model outside the replay set is counted apart", () => {
    const r = resolve([row(h("p1"), "some-other-model", "code")]);
    expect(r.rowsOutsideModelSet).toBe(1);
    expect(r.replays).toHaveLength(0);
  });

  test("a label that no longer re-admits through the shipped rules is DROPPED and counted", () => {
    // `corpus_rev` versions the CORPUS, not the taxonomy. A row written under a task type that
    // has since been removed would otherwise reconstitute and be scored against the panel as
    // merely wrong — a silently false number with nothing else in the system to catch it.
    const r = resolve([
      row(h("p1"), "model-a", "no-such-task-type"),
      row(h("p2"), "model-a", "code", { confidence: 4 }),
      row(h("p3"), "model-a", "code"),
    ]);
    expect(r.perModel[0]?.unreadable).toBe(2);
    expect(r.replays[0]?.labels.map((l) => l.text)).toEqual(["p3"]);
  });

  test("a model with no stored label at all is OMITTED, not returned as an empty pass", () => {
    // "Never run" and "ran and answered nothing" are different claims, and the readout's
    // `unreplayed` row is denominated in a replay that happened.
    const r = resolve([row(h("p1"), "model-a", "code")], [A, B]);
    expect(r.replays.map((x) => x.modelId)).toEqual(["model-a"]);
    expect(r.perModel.map((x) => x.modelId)).toEqual(["model-a", "model-b"]);
    expect(r.perModel[1]?.labelled).toMatchObject({ n: 0, d: 3 });
  });

  test("the coverage readout states the context hint it could not reproduce", () => {
    const rendered = renderReplayCoverage(resolve([row(h("p1"), "model-a", "code")]));
    expect(rendered).toContain("session context");
    expect(rendered).toContain("PERMISSIVE");
    // Counts and model ids only. No prompt text, no hash.
    expect(rendered).not.toContain("p1");
    expect(rendered).not.toContain(h("p1"));
  });
});

describe("the ledger round trip — a rerun is free, and reads back what was written", () => {
  test("a label survives a write and a read at the same revision", () => {
    const db = new MinimaDb(":memory:");
    try {
      db.upsertReplayLabel({
        promptHash: promptHash("p1"),
        modelId: "model-a",
        corpusRev: CORPUS_REV,
        taskType: "code",
        difficulty: "easy",
        confidence: 0.42,
      });
      const rows = db.listReplayLabels(CORPUS_REV);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ task_type: "code", confidence: 0.42 });
      // Sub-floor confidence survives the round trip — the curve needs exactly this region.
      expect(rows[0]!.confidence).toBeLessThan(CLASSIFY_CONFIDENCE_FLOOR);
    } finally {
      db.close();
    }
  });

  test("the prompt text is nowhere in the row", () => {
    const db = new MinimaDb(":memory:");
    try {
      db.upsertReplayLabel({
        promptHash: promptHash("a secret prompt"),
        modelId: "model-a",
        corpusRev: CORPUS_REV,
        taskType: "code",
      });
      expect(JSON.stringify(db.listReplayLabels(CORPUS_REV))).not.toContain("a secret prompt");
    } finally {
      db.close();
    }
  });

  test("re-running the same model over the same prompt REPLACES rather than accumulates", () => {
    const db = new MinimaDb(":memory:");
    try {
      const base = { promptHash: promptHash("p1"), modelId: "model-a", corpusRev: CORPUS_REV };
      db.upsertReplayLabel({ ...base, taskType: "code" });
      db.upsertReplayLabel({ ...base, taskType: "qa" });
      const rows = db.listReplayLabels(CORPUS_REV);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.task_type).toBe("qa");
    } finally {
      db.close();
    }
  });

  test("a read at another revision is a MISS, not a stale label", () => {
    const db = new MinimaDb(":memory:");
    try {
      db.upsertReplayLabel({
        promptHash: promptHash("p1"),
        modelId: "model-a",
        corpusRev: "r1-old",
        taskType: "code",
      });
      expect(db.listReplayLabels(CORPUS_REV)).toHaveLength(0);
      expect(db.listReplayLabels("r1-old")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("the replay's rows do NOT land in the consensus vote table", () => {
    // ADR 0008's whole reason for a second table: the subject under test must never be readable
    // as the reference it is scored against.
    const db = new MinimaDb(":memory:");
    try {
      db.upsertReplayLabel({
        promptHash: promptHash("p1"),
        modelId: "model-a",
        corpusRev: CORPUS_REV,
        taskType: "code",
      });
      expect(db.listConsensusVotes(CORPUS_REV)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("end to end — the readout stops printing em dashes", () => {
  const userRow = (id: string, ts: number, text: string): UserPromptRow => ({
    id,
    run_id: "r1",
    ts,
    agent_id: null,
    text,
  });

  test("cached labels turn `never replayed 238/238` into real accuracy and a real curve", () => {
    // The whole ticket, at its seam: ledger rows in, numbers out. Before the producer existed
    // this same call printed an em dash in every cell.
    const texts = ["alpha", "beta", "gamma", "delta"];
    const prompts = texts.map((t, i) => userRow(`e${i}`, 1_000 + i, t));
    const votes = texts.flatMap((t) =>
      ["claude-opus-4-8", "gpt-5.6-sol", "gemini-2.5-pro"].map((modelId) => ({
        prompt_hash: promptHash(t),
        model_id: modelId,
        corpus_rev: CORPUS_REV,
        task_type: "code",
      })),
    );
    const replayLabels = texts.map((t, i) =>
      row(promptHash(t), REPLAY_MODELS[0]!.model.id, i === 0 ? "qa" : "code", {
        confidence: 0.9,
      }),
    );

    const { report, coverage } = buildScoreReport(
      { prompts, decisions: [], votes, replayLabels },
      { scope: "test", targetCorrectness: 0.75 },
    );

    const model = report.models[0];
    expect(model?.modelId).toBe(REPLAY_MODELS[0]!.model.id);
    // Three of four match the unanimous panel; the first was called `qa` against a `code` panel.
    expect(model?.accuracy.whole.correct.rate).toMatchObject({ n: 3, d: 4 });
    expect(model?.accuracy.whole.unreplayed.rate).toMatchObject({ n: 0, d: 4 });
    // The curve has evidence in the top bin, which is what it never had before.
    const top = model?.reliability.whole.at(-1);
    expect(top?.correct.rate).toMatchObject({ n: 3, d: 4 });
    expect(coverage.perModel[0]?.labelled).toMatchObject({ n: 4, d: 4 });
  });

  test("with no cached labels it still reports, as the unreplayed readout it always was", () => {
    const prompts = [userRow("e0", 1_000, "alpha")];
    const { report, coverage } = buildScoreReport(
      { prompts, decisions: [], votes: [] },
      { scope: "test", targetCorrectness: 0.75 },
    );
    expect(report.models[0]?.modelId).toBe("(no classifier replay recorded)");
    expect(report.models[0]?.accuracy.whole.unreplayed.rate).toMatchObject({ n: 1, d: 1 });
    expect(coverage.replays).toHaveLength(0);
  });

  test("a stored abstention scores as `abstained`, never as a wrong answer", () => {
    const prompts = [userRow("e0", 1_000, "alpha")];
    const votes = ["claude-opus-4-8", "gpt-5.6-sol", "gemini-2.5-pro"].map((modelId) => ({
      prompt_hash: promptHash("alpha"),
      model_id: modelId,
      corpus_rev: CORPUS_REV,
      task_type: "code",
    }));
    const { report } = buildScoreReport(
      {
        prompts,
        decisions: [],
        votes,
        replayLabels: [row(promptHash("alpha"), REPLAY_MODELS[0]!.model.id, null)],
      },
      { scope: "test", targetCorrectness: 0.75 },
    );
    const acc = report.models[0]?.accuracy.whole;
    expect(acc?.abstained.rate).toMatchObject({ n: 1, d: 1 });
    expect(acc?.scored).toBe(0);
  });
});

describe("classificationFromParts — the shipped admission rules, on the way out too", () => {
  test("admits exactly what the parser admits", () => {
    expect(classificationFromParts("code", "easy", 0.9)).toEqual({
      taskType: "code",
      difficulty: "easy",
      confidence: 0.9,
    });
  });

  test("refuses a type, a difficulty or a confidence the shipped rules would not accept", () => {
    expect(classificationFromParts("nonsense", "easy", 0.9)).toBeNull();
    expect(classificationFromParts("code", "nonsense", 0.9)).toBeNull();
    expect(classificationFromParts("code", "easy", 1.5)).toBeNull();
    expect(classificationFromParts("code", "easy", null)).toBeNull();
  });
});

describe("TaskClassifier.onOutcome — the hook that makes the causes distinguishable", () => {
  const CLS: Model = {
    id: "cls-model",
    provider: "faux",
    api: "faux",
    name: "Classifier",
    cost: { input: 0.5, output: 1 },
    context_window: 8192,
    max_tokens: 4096,
  };
  const LABEL = '{"task_type":"code","difficulty":"easy","confidence":0.9}';

  /** Run one classify against a scripted faux reply, returning what the hook saw. */
  async function outcomeOf(reply: AssistantMessage | null): Promise<ClassifyOutcome | null> {
    resetRegistry();
    resetProviderRegistration();
    const reg = registerFauxProvider([CLS]);
    if (reply) reg.state.responses.push(reply);
    let seen: ClassifyOutcome | null = null;
    try {
      await new TaskClassifier(CLS, {
        onOutcome: (o) => {
          seen = o;
        },
      }).classify("do the thing");
    } finally {
      reg.unregister();
    }
    return seen;
  }

  test("a parsed reply reports `labelled` with the classification and the stop reason", async () => {
    const out = await outcomeOf(
      new AssistantMessage({ content: [textBlock(LABEL)], stop_reason: "stop" }),
    );
    expect(out).toMatchObject({ kind: "labelled", stopReason: "stop" });
    expect(out?.kind === "labelled" && out.classification.taskType).toBe("code");
  });

  test("a complete reply that will not parse reports `unusable`", async () => {
    const out = await outcomeOf(
      new AssistantMessage({ content: [textBlock("I think it's code!")], stop_reason: "stop" }),
    );
    expect(out).toMatchObject({ kind: "unusable", stopReason: "stop" });
  });

  test("a truncated reply reports its `length` stop reason, so a durable cache can refuse it", async () => {
    const out = await outcomeOf(
      new AssistantMessage({ content: [textBlock('{"task_type":"co')], stop_reason: "length" }),
    );
    expect(out).toMatchObject({ kind: "unusable", stopReason: "length" });
  });

  test("a provider error reports `provider-error`, distinct from anything parseable", async () => {
    // An empty faux queue yields a stop_reason: "error" response, the same shape a real
    // provider failure takes.
    expect(await outcomeOf(null)).toEqual({ kind: "provider-error" });
  });

  test("a thrown call reports `transport-error`", async () => {
    // No provider registered for this api at all, so `stream()` throws before any request.
    let seen: ClassifyOutcome | null = null;
    const orphan: Model = { ...CLS, api: "no-such-api" };
    const result = await new TaskClassifier(orphan, {
      onOutcome: (o) => {
        seen = o;
      },
    }).classify("x");
    expect(result).toBeNull();
    expect(seen).toEqual({ kind: "transport-error" });
  });

  test("a hook that throws cannot break classification", async () => {
    resetRegistry();
    resetProviderRegistration();
    const reg = registerFauxProvider([CLS]);
    reg.state.responses.push(
      new AssistantMessage({ content: [textBlock(LABEL)], stop_reason: "stop" }),
    );
    try {
      const cls = await new TaskClassifier(CLS, {
        onOutcome: () => {
          throw new Error("observer blew up");
        },
      }).classify("x");
      expect(cls?.taskType).toBe("code");
    } finally {
      reg.unregister();
    }
  });

  test("a memo hit makes no call and reports nothing, because nothing happened", async () => {
    resetRegistry();
    resetProviderRegistration();
    const reg = registerFauxProvider([CLS]);
    reg.state.responses.push(
      new AssistantMessage({ content: [textBlock(LABEL)], stop_reason: "stop" }),
    );
    let reports = 0;
    try {
      const classifier = new TaskClassifier(CLS, {
        onOutcome: () => {
          reports++;
        },
      });
      await classifier.classify("same text");
      await classifier.classify("same text");
      expect(reports).toBe(1);
    } finally {
      reg.unregister();
    }
  });
});
