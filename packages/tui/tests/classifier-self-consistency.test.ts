import { describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  resetProviderRegistration,
  resetRegistry,
  text as textBlock,
} from "../src/ai/index.ts";
import { MinimaDb, type UserPromptRow } from "../src/db/minima_db.ts";
import {
  CORPUS_REV,
  DEFAULT_SAMPLES,
  type DistinctPrompt,
  LABEL_INSTRUCTION_TOKENS,
  MIN_SAMPLES,
  REGIME_BOUNDARY_TS,
  corpusPrompts,
  decideInvocation,
  resolveSamples,
} from "../src/minima/classifier_eval.ts";
import {
  DEFAULT_CONFIDENCE_BOUNDARIES,
  MIN_REPORTABLE_SUPPORT,
  segmentCorpus,
} from "../src/minima/classifier_eval_score.ts";
import {
  REPLAY_MODELS,
  REPLAY_OUTPUT_TOKENS,
  type ReplayModel,
  makeReplayCaller,
} from "../src/minima/classifier_replay.ts";
import {
  PILOT_ENTRIES,
  PILOT_MIN_VARYING,
  SAMPLED_MODEL,
  SAMPLING_TEMPERATURE,
  type SelfConsistencySampleWrite,
  type StoredSelfConsistencySample,
  checkSamplerNonDegenerate,
  isReadableSample,
  pilotEntries,
  planSampling,
  projectSamplingCost,
  projectSamplingLane,
  renderSamplingOutstanding,
  runSampling,
  sampleKey,
  selfConsistencyCallSpecs,
  summarizeSamplingOutstanding,
} from "../src/minima/classifier_self_consistency.ts";
import {
  type PromptSelfConsistency,
  SELF_CONSISTENCY_LIMITS,
  biasBlock,
  buildSelfConsistencyReport,
  directionOf,
  renderSelfConsistencyReport,
  resolutionBand,
} from "../src/minima/classifier_self_consistency_report.ts";
import { CLASSIFY_CONFIDENCE_FLOOR, TaskClassifier } from "../src/minima/classify.ts";
import { promptHash, voteKey } from "../src/minima/consensus_panel.ts";

// MUB-217. Nothing here calls a real model: `runSampling` and `makeReplayCaller` both take their
// collaborator as an argument, so the billable path is exercised by a fake that spends fake money.
// The one exception is the faux-provider test that pins trap 1 through the REAL default factory —
// which is the whole point of it.

const KEY_OF = (hash: string, modelId: string, i: number): string =>
  sampleKey(voteKey, hash, modelId, i);

const prompt = (text: string, occurrences = 1): DistinctPrompt => ({ text, occurrences });

function fauxModel(id = "faux-classifier"): ReplayModel {
  return {
    model: {
      id,
      provider: "faux",
      api: "faux",
      name: id,
      cost: { input: 1, output: 2 },
      context_window: 8192,
      max_tokens: 1024,
    } as Model,
    role: "test",
    outputTokensPerCall: REPLAY_OUTPUT_TOKENS,
  };
}

const M = fauxModel();

/** A stored draw, as `listSelfConsistencySamples` returns it. */
function draw(
  text: string,
  sampleIndex: number,
  taskType: string | null,
  difficulty: string | null,
  confidence: number | null,
  over: Partial<StoredSelfConsistencySample> = {},
): StoredSelfConsistencySample {
  return {
    prompt_hash: promptHash(text),
    model_id: M.model.id,
    sample_index: sampleIndex,
    corpus_rev: CORPUS_REV,
    temperature: SAMPLING_TEMPERATURE,
    task_type: taskType,
    difficulty,
    confidence,
    ...over,
  };
}

const BEFORE_TS = REGIME_BOUNDARY_TS - 1000;

function userRow(id: string, text: string, ts = BEFORE_TS): UserPromptRow {
  return { id, run_id: "r1", ts, agent_id: null, text };
}

/**
 * A corpus of `n` prompts, and `samples` draws each, all agreeing on `(taskType, difficulty)` for
 * `agree` of them and disagreeing on difficulty for the rest.
 */
function fixture(opts: {
  prompts: number;
  samples: number;
  agree: number;
  confidence: number;
  ts?: (i: number) => number;
}) {
  const corpus: UserPromptRow[] = [];
  const samples: StoredSelfConsistencySample[] = [];
  for (let p = 0; p < opts.prompts; p++) {
    const text = `prompt-${p}`;
    corpus.push(userRow(`u${p}`, text, opts.ts?.(p) ?? BEFORE_TS));
    for (let i = 0; i < opts.samples; i++) {
      samples.push(draw(text, i, "code", i < opts.agree ? "easy" : "hard", opts.confidence));
    }
  }
  return { corpus, samples };
}

const CFG = {
  scope: "test",
  samples: 10,
  corpusRev: CORPUS_REV,
  modelId: M.model.id,
  hashOf: promptHash,
};

// ---------------------------------------------------------------------------

describe("trap 1 — the per-session memo, which turns ten draws into one call", () => {
  test("ten draws construct TEN classifiers, never one reused", async () => {
    // `TaskClassifier` memoizes on `Bun.hash(task)`. One instance across ten draws answers nine of
    // them from its own Map: no call, no cost, no outcome — and a perfect 1.0 self-consistency
    // computed from a single sample. `makeReplayCaller` constructs a fresh classifier per call and
    // is imported UNCHANGED for exactly this reason; this counts the constructions.
    let constructed = 0;
    const call = makeReplayCaller((_m, opts) => {
      constructed += 1;
      return {
        classify: async () => {
          opts.onCostUsd?.(0.001);
          opts.onOutcome?.({
            kind: "labelled",
            classification: { taskType: "code", difficulty: "easy", confidence: 0.9 },
            stopReason: "stop",
          });
          return { taskType: "code" as const, difficulty: "easy" as const, confidence: 0.9 };
        },
      };
    });
    const plan = planSampling([prompt("p1")], M, 10, new Set(), promptHash, KEY_OF);
    const written: SelfConsistencySampleWrite[] = [];
    const result = await runSampling({
      plan,
      corpusRev: CORPUS_REV,
      call,
      record: (s) => {
        written.push(s);
      },
      guard: { mayDispatch: () => true, book: () => {} },
    });
    expect(constructed).toBe(10);
    expect(result.attempted).toBe(10);
    expect(written).toHaveLength(10);
    expect(written.map((w) => w.sampleIndex).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  test("through the REAL default factory: ten draws are ten provider calls", async () => {
    // The seam above proves the caller constructs ten; this proves the SHIPPED default factory
    // really does reach the provider ten times, with no substitution anywhere.
    resetRegistry();
    resetProviderRegistration();
    const reg = registerFauxProvider([M.model]);
    try {
      reg.setResponses(
        Array.from(
          { length: 10 },
          () =>
            new AssistantMessage({
              content: [textBlock('{"task_type":"code","difficulty":"easy","confidence":0.9}')],
            }),
        ),
      );
      const plan = planSampling(
        [prompt("same text every time")],
        M,
        10,
        new Set(),
        promptHash,
        KEY_OF,
      );
      const result = await runSampling({
        plan,
        corpusRev: CORPUS_REV,
        call: makeReplayCaller(),
        record: () => {},
        guard: { mayDispatch: () => true, book: () => {} },
      });
      expect(reg.state.callCount).toBe(10);
      expect(result.labelled).toBe(10);
    } finally {
      reg.unregister();
      resetProviderRegistration();
      resetRegistry();
    }
  });

  test("the trap, demonstrated: ONE shared classifier answers ten asks with one call", async () => {
    // Not a test of this lane — a test of the thing this lane must not do. If this ever stops
    // being true the guarantee above is free, and the comment explaining it should change.
    resetRegistry();
    resetProviderRegistration();
    const reg = registerFauxProvider([M.model]);
    try {
      reg.setResponses(
        Array.from(
          { length: 10 },
          () =>
            new AssistantMessage({
              content: [textBlock('{"task_type":"code","difficulty":"easy","confidence":0.9}')],
            }),
        ),
      );
      const shared = new TaskClassifier(M.model, {});
      for (let i = 0; i < 10; i++) await shared.classify("same text every time");
      expect(reg.state.callCount).toBe(1);
    } finally {
      reg.unregister();
      resetProviderRegistration();
      resetRegistry();
    }
  });
});

describe("trap 3 — the key carries the draw index, so ten draws are ten rows", () => {
  test("ten sample indices survive as ten rows", () => {
    const db = new MinimaDb(":memory:");
    try {
      for (let i = 0; i < 10; i++) {
        db.upsertSelfConsistencySample({
          promptHash: promptHash("p1"),
          modelId: "model-a",
          sampleIndex: i,
          corpusRev: CORPUS_REV,
          temperature: SAMPLING_TEMPERATURE,
          taskType: "code",
          difficulty: i < 6 ? "easy" : "hard",
          confidence: 0.95,
        });
      }
      const rows = db.listSelfConsistencySamples(CORPUS_REV);
      expect(rows).toHaveLength(10);
      expect(new Set(rows.map((r) => r.sample_index)).size).toBe(10);
    } finally {
      db.close();
    }
  });

  test("the SHIPPED caches would have collapsed those ten to one — which is why this table exists", () => {
    const db = new MinimaDb(":memory:");
    try {
      for (let i = 0; i < 10; i++) {
        db.upsertReplayLabel({
          promptHash: promptHash("p1"),
          modelId: "model-a",
          corpusRev: CORPUS_REV,
          taskType: "code",
          difficulty: i < 6 ? "easy" : "hard",
        });
      }
      // One row, no error, last write wins: a modal frequency of 1.0 by construction.
      expect(db.listReplayLabels(CORPUS_REV)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("re-running ONE draw replaces that draw and leaves the others alone", () => {
    const db = new MinimaDb(":memory:");
    try {
      const base = {
        promptHash: promptHash("p1"),
        modelId: "model-a",
        corpusRev: CORPUS_REV,
        temperature: SAMPLING_TEMPERATURE,
      };
      db.upsertSelfConsistencySample({ ...base, sampleIndex: 0, taskType: "code" });
      db.upsertSelfConsistencySample({ ...base, sampleIndex: 1, taskType: "qa" });
      db.upsertSelfConsistencySample({ ...base, sampleIndex: 1, taskType: "creative" });
      const rows = db.listSelfConsistencySamples(CORPUS_REV);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.task_type)).toEqual(["code", "creative"]);
    } finally {
      db.close();
    }
  });

  test("a read at another revision is a MISS, and draws never land in the other two tables", () => {
    const db = new MinimaDb(":memory:");
    try {
      db.upsertSelfConsistencySample({
        promptHash: promptHash("p1"),
        modelId: "model-a",
        sampleIndex: 0,
        corpusRev: "r1-old",
        temperature: SAMPLING_TEMPERATURE,
        taskType: "code",
      });
      expect(db.listSelfConsistencySamples(CORPUS_REV)).toHaveLength(0);
      expect(db.listSelfConsistencySamples("r1-old")).toHaveLength(1);
      expect(db.listReplayLabels("r1-old")).toHaveLength(0);
      expect(db.listConsensusVotes("r1-old")).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("the raw self-report survives the round trip, sub-floor and all", () => {
    const db = new MinimaDb(":memory:");
    try {
      db.upsertSelfConsistencySample({
        promptHash: promptHash("p1"),
        modelId: "model-a",
        sampleIndex: 0,
        corpusRev: CORPUS_REV,
        temperature: SAMPLING_TEMPERATURE,
        taskType: "code",
        difficulty: "easy",
        confidence: 0.42,
      });
      const row = db.listSelfConsistencySamples(CORPUS_REV)[0];
      expect(row?.confidence).toBe(0.42);
      expect(row?.confidence).toBeLessThan(CLASSIFY_CONFIDENCE_FLOOR);
      expect(row?.temperature).toBe("provider default, unset");
    } finally {
      db.close();
    }
  });

  test("sampleKey separates draws that voteKey alone would collide", () => {
    const h = promptHash("p1");
    expect(KEY_OF(h, "m", 0)).not.toBe(KEY_OF(h, "m", 1));
    // Composed from the ONE key shape, applied twice — no second delimiter is declared anywhere.
    expect(KEY_OF(h, "m", 3)).toBe(voteKey(voteKey(h, "m"), "3"));
  });
});

describe("trap 2 — a degenerate sampler is indistinguishable from a perfect one", () => {
  const pilot = Array.from({ length: PILOT_ENTRIES }, (_, i) => prompt(`prompt-${i}`));
  const opts = { modelId: M.model.id, hashOf: promptHash };

  test("no draws at all is its own verdict, not a degenerate one", () => {
    expect(checkSamplerNonDegenerate(pilot, [], opts)).toEqual({ kind: "no-samples" });
  });

  test("byte-identical draws on every pilot prompt is DEGENERATE — the full run is not authorized", () => {
    const rows = pilot.flatMap((p) =>
      Array.from({ length: 10 }, (_, i) => draw(p.text, i, "code", "easy", 0.95)),
    );
    const v = checkSamplerNonDegenerate(pilot, rows, opts);
    expect(v.kind).toBe("degenerate");
    if (v.kind === "degenerate") {
      expect(v.varying).toMatchObject({ n: 0, d: 10 });
      expect(v.threshold).toBe(PILOT_MIN_VARYING);
      expect(v.draws).toBe(100);
    }
  });

  test("one varying prompt is still not enough — the criterion is two", () => {
    const rows = pilot.flatMap((p, idx) =>
      Array.from({ length: 10 }, (_, i) =>
        draw(p.text, i, "code", idx === 0 && i > 4 ? "hard" : "easy", 0.95),
      ),
    );
    expect(checkSamplerNonDegenerate(pilot, rows, opts).kind).toBe("degenerate");
  });

  test("two varying prompts clears it, and a confidence that moves counts as variation", () => {
    // CLASSIFY_SYSTEM asks for all three fields, so a run returning the same pair with a moving
    // confidence is demonstrably sampling. A tuple of task type alone would fail a working sampler.
    const rows = pilot.flatMap((p, idx) =>
      Array.from({ length: 10 }, (_, i) =>
        draw(p.text, i, "code", "easy", idx < 2 && i > 4 ? 0.85 : 0.95),
      ),
    );
    const v = checkSamplerNonDegenerate(pilot, rows, opts);
    expect(v.kind).toBe("ok");
    if (v.kind === "ok") expect(v.varying).toMatchObject({ n: 2, d: 10 });
  });

  test("a prompt whose draws all FAILED counts as unsampled, not as 'did not vary'", () => {
    // A provider outage must not read as a degenerate sampler: those prompts have no rows at all.
    const rows = pilot
      .slice(0, 2)
      .flatMap((p) =>
        Array.from({ length: 10 }, (_, i) => draw(p.text, i, "code", i > 4 ? "hard" : "easy", 0.9)),
      );
    const v = checkSamplerNonDegenerate(pilot, rows, opts);
    expect(v.kind).toBe("ok");
    if (v.kind === "ok") expect(v.varying).toMatchObject({ n: 2, d: 2 });
  });

  test("the renderer prints an ABORT BANNER instead of a headline when the verdict is not ok", () => {
    const f = fixture({ prompts: 12, samples: 10, agree: 10, confidence: 0.95 });
    const out = renderSelfConsistencyReport(buildSelfConsistencyReport(f, CFG));
    expect(out).toContain("ABORT");
    expect(out).toContain("THE SAMPLER LOOKS DEGENERATE");
    expect(out).not.toContain("HEADLINE");
  });

  test("…and prints the headline when it is ok", () => {
    const f = fixture({ prompts: 12, samples: 10, agree: 6, confidence: 0.95 });
    const out = renderSelfConsistencyReport(buildSelfConsistencyReport(f, CFG));
    expect(out).toContain("HEADLINE");
    expect(out).not.toContain("ABORT");
    expect(out).toContain("its true predictive distribution");
  });

  test("an empty cache aborts too — a modal frequency over zero draws is not a finding", () => {
    const out = renderSelfConsistencyReport(
      buildSelfConsistencyReport({ corpus: [userRow("u0", "p0")], samples: [] }, CFG),
    );
    expect(out).toContain("ABORT — NO DRAWS AT THIS CORPUS REVISION");
    expect(out).not.toContain("HEADLINE");
  });
});

describe("trap 5 — the PAIR is the primary comparand, task type alone is secondary", () => {
  test("task-type-alone is always >= the pair, per prompt and in aggregate", () => {
    // Six draws of code/easy and four of code/hard: the pair modal is 6/10, task type is 10/10.
    // Reading the second as the headline would report perfect self-consistency on a prompt whose
    // difficulty the classifier could not repeat.
    const f = fixture({ prompts: 12, samples: 10, agree: 6, confidence: 0.95 });
    const r = buildSelfConsistencyReport(f, CFG);
    for (const p of r.perPrompt) {
      expect(p.pairFrequency.rate.n).toBe(6);
      expect(p.taskTypeFrequency.rate.n).toBe(10);
      expect(p.taskTypeFrequency.rate.n).toBeGreaterThanOrEqual(p.pairFrequency.rate.n);
    }
    const w = r.bias.whole;
    expect(w.modalTaskTypeFrequency.rate.pct).toBeGreaterThanOrEqual(
      w.modalFrequency.rate.pct as number,
    );
    // And the understatement is QUANTIFIED, not merely asserted: 0.95-0.6 vs 0.95-1.0.
    expect(w.meanGap).toBeCloseTo(0.35, 6);
    expect(w.meanTaskTypeGap).toBeCloseTo(-0.05, 6);
  });

  test("the readout labels which one is primary", () => {
    const f = fixture({ prompts: 12, samples: 10, agree: 6, confidence: 0.95 });
    const out = renderSelfConsistencyReport(buildSelfConsistencyReport(f, CFG));
    expect(out).toContain("modal freq (PAIR, primary)");
    expect(out).toContain("secondary, >= primary");
    expect(out).toContain("modal-label frequency (PAIR)");
  });

  test("a modal tie is flagged; the frequency is unaffected and the choice is deterministic", () => {
    const corpus = [userRow("u0", "p0")];
    const samples = [
      ...Array.from({ length: 5 }, (_, i) => draw("p0", i, "code", "easy", 0.9)),
      ...Array.from({ length: 5 }, (_, i) => draw("p0", i + 5, "code", "hard", 0.9)),
    ];
    const r = buildSelfConsistencyReport({ corpus, samples }, CFG);
    const p = r.perPrompt[0] as PromptSelfConsistency;
    expect(p.tied).toBe(true);
    expect(p.pairFrequency.rate).toMatchObject({ n: 5, d: 10 });
    expect(p.modalPair).toBe("code/easy");
  });
});

describe("direction of bias (AC 3) — the sign is the finding", () => {
  test("the band is 1/(2n) and widens as n falls", () => {
    expect(resolutionBand(10)).toBe(0.05);
    expect(resolutionBand(2)).toBe(0.25);
    expect(resolutionBand(20)).toBe(0.025);
  });

  test("a 0.95 self-report against a 1.0 observed frequency is INDISTINGUISHABLE at n=10", () => {
    // The exact case the ticket calls out. Note the float: `0.95 - 1.0` is -0.050000000000000044,
    // strictly outside a bare 0.05 comparison, so an unrounded implementation would report the
    // most common self-report in this corpus as underconfident.
    expect(Math.abs(0.95 - 1.0) > 0.05).toBe(true);
    expect(directionOf(0.95 - 1.0, resolutionBand(10))).toBe("indistinguishable");
  });

  test("outside the band, the sign decides", () => {
    expect(directionOf(0.35, 0.05)).toBe("overconfident");
    expect(directionOf(-0.35, 0.05)).toBe("underconfident");
    // Boundary inclusive both ways: exactly the band is not a direction.
    expect(directionOf(0.05, 0.05)).toBe("indistinguishable");
    expect(directionOf(-0.05, 0.05)).toBe("indistinguishable");
    expect(directionOf(0.050001, 0.05)).toBe("overconfident");
  });

  test("the band comes from the DRAWS IN HAND, not from the --samples a reader passed", () => {
    // A lane read at n=10 whose rows were bought at 4 must be bucketed at +/-0.125, not +/-0.05.
    // Taking the band from the flag is the direction that MANUFACTURES a direction of bias: a
    // gap of 0.1 over four draws would read `overconfident` on evidence that cannot resolve it.
    const corpus = [userRow("u0", "p0")];
    const samples = [
      ...Array.from({ length: 3 }, (_, i) => draw("p0", i, "code", "easy", 0.85)),
      draw("p0", 3, "code", "hard", 0.85),
    ];
    const r = buildSelfConsistencyReport({ corpus, samples }, CFG); // CFG says samples: 10
    const p = r.perPrompt[0] as PromptSelfConsistency;
    expect(p.draws).toBe(4);
    expect(p.band).toBe(resolutionBand(4)); // 0.125, not the header's 0.05
    expect(p.gap).toBeCloseTo(0.1, 6); // 0.85 - 3/4
    expect(p.direction).toBe("indistinguishable");
    // …and at the flag's band it would have been called overconfident, which is the whole point.
    expect(directionOf(p.gap as number, resolutionBand(10))).toBe("overconfident");
  });

  test("a depth that disagrees with the stated n is flagged in the readout, never silent", () => {
    const corpus = [userRow("u0", "p0")];
    const samples = Array.from({ length: 4 }, (_, i) =>
      draw("p0", i, "code", i < 3 ? "easy" : "hard", 0.85),
    );
    const r = buildSelfConsistencyReport({ corpus, samples }, CFG);
    expect(r.coverage.drawsPerPrompt).toEqual({ min: 4, max: 4 });
    const out = renderSelfConsistencyReport(r);
    expect(out).toContain("draws per sampled entry      4");
    expect(out).toContain("the ledger's depth does not match the stated n=10");
  });

  test("…and is not flagged when it agrees", () => {
    const f = fixture({ prompts: 12, samples: 10, agree: 6, confidence: 0.95 });
    const out = renderSelfConsistencyReport(buildSelfConsistencyReport(f, CFG));
    expect(out).not.toContain("does not match the stated n");
  });

  test("the middle arm is never called 'calibrated', and the readout says why", () => {
    const dirs = new Set([directionOf(0, 0.05), directionOf(1, 0.05), directionOf(-1, 0.05)]);
    expect([...dirs].sort()).toEqual(["indistinguishable", "overconfident", "underconfident"]);
    expect(SELF_CONSISTENCY_LIMITS.join("\n")).toContain("'indistinguishable', NOT 'calibrated'");
  });

  test("the three-way mix shares ONE denominator and sums to the whole", () => {
    // The guard that stops a sign flip cancelling to zero and reading as calibration.
    const entries: PromptSelfConsistency[] = [
      ...Array.from({ length: 5 }, () => entry(0.4)),
      ...Array.from({ length: 5 }, () => entry(-0.4)),
      ...Array.from({ length: 2 }, () => entry(0.0)),
    ];
    const b = biasBlock(entries, 0.05);
    expect(b.meanGap).toBeCloseTo(0, 6); // a mean alone would read as perfect calibration
    expect(b.meanAbsGap).toBeCloseTo(0.333333, 5);
    expect(b.over.rate.d).toBe(b.prompts);
    expect(b.under.rate.d).toBe(b.prompts);
    expect(b.indistinguishable.rate.d).toBe(b.prompts);
    expect(b.over.rate.n + b.under.rate.n + b.indistinguishable.rate.n).toBe(b.prompts);
    expect(b.over.rate.n).toBe(5);
    expect(b.under.rate.n).toBe(5);
  });

  test("the mean is unreachable without the mix — they are one block, printed together", () => {
    const f = fixture({ prompts: 12, samples: 10, agree: 6, confidence: 0.95 });
    const out = renderSelfConsistencyReport(buildSelfConsistencyReport(f, CFG));
    const block = out.slice(out.indexOf("Gap, whole corpus"));
    for (const needle of [
      "mean gap (signed, PRIMARY)",
      "mean ABSOLUTE gap",
      "overconfident",
      "underconfident",
      "indistinguishable",
    ]) {
      expect(block).toContain(needle);
    }
  });

  test("segmented by regime, and the segments sum to the whole", () => {
    const f = fixture({
      prompts: 12,
      samples: 10,
      agree: 6,
      confidence: 0.95,
      ts: (i) => (i < 7 ? BEFORE_TS : REGIME_BOUNDARY_TS + 1000),
    });
    const r = buildSelfConsistencyReport(f, CFG);
    expect(r.bias.before.prompts).toBe(7);
    expect(r.bias.after.prompts).toBe(5);
    expect(r.bias.spanning.prompts).toBe(0);
    expect(r.bias.before.prompts + r.bias.after.prompts + r.bias.spanning.prompts).toBe(
      r.bias.whole.prompts,
    );
    const out = renderSelfConsistencyReport(r);
    expect(out).toContain("By regime");
    expect(out).toContain("spanning");
  });

  test("binned by confidence, with CLASSIFY_CONFIDENCE_FLOOR as a bin edge", () => {
    const f = fixture({ prompts: 12, samples: 10, agree: 6, confidence: 0.95 });
    const r = buildSelfConsistencyReport(f, CFG);
    expect(r.byConfidence.map((b) => b.minConfidence)).toContain(CLASSIFY_CONFIDENCE_FLOOR);
    expect(DEFAULT_CONFIDENCE_BOUNDARIES).toContain(CLASSIFY_CONFIDENCE_FLOOR);
    // Every prompt reported 0.95, so the whole population lands in the top bin and nowhere else.
    const populated = r.byConfidence.filter((b) => b.bias.prompts > 0);
    expect(populated).toHaveLength(1);
    expect(populated[0]?.label).toBe(">=0.90");
    expect(r.byConfidence.reduce((n, b) => n + b.bias.prompts, 0)).toBe(r.bias.whole.prompts);
  });
});

/** A per-prompt result with a stated gap and nothing else that matters to `biasBlock`. */
function entry(gap: number): PromptSelfConsistency {
  return {
    hashPrefix: "0".repeat(12),
    segment: "before",
    draws: 10,
    abstentions: 0,
    modalPair: "code/easy",
    pairFrequency: { rate: { n: 6, d: 10, pct: 60 }, minSupport: 10, reportable: true },
    modalTaskType: "code",
    taskTypeFrequency: { rate: { n: 10, d: 10, pct: 100 }, minSupport: 10, reportable: true },
    tied: false,
    selfReport: 0.6 + gap,
    gap,
    taskTypeGap: gap - 0.4,
    direction: directionOf(gap, 0.05),
  };
}

describe("the denominator, abstentions, and the support bar", () => {
  test("at the default n the per-prompt denominator is exactly MIN_REPORTABLE_SUPPORT", () => {
    // The strongest structural argument for n=10, and the reason no readout passes a lower bar.
    expect(DEFAULT_SAMPLES).toBe(MIN_REPORTABLE_SUPPORT);
    const f = fixture({ prompts: 12, samples: 10, agree: 6, confidence: 0.95 });
    const r = buildSelfConsistencyReport(f, CFG);
    for (const p of r.perPrompt) {
      expect(p.draws).toBe(MIN_REPORTABLE_SUPPORT);
      expect(p.pairFrequency.reportable).toBe(true);
    }
  });

  test("below it, every per-prompt figure prints as n/d† rather than a percentage", () => {
    const f = fixture({ prompts: 12, samples: 4, agree: 3, confidence: 0.95 });
    const r = buildSelfConsistencyReport(f, { ...CFG, samples: 4 });
    for (const p of r.perPrompt) expect(p.pairFrequency.reportable).toBe(false);
    expect(renderSelfConsistencyReport(r)).toContain("3/4†");
  });

  test("an abstention stays in the denominator and cannot be the modal LABEL", () => {
    // Declining is a real outcome of the predictive distribution. Dropping it would let a model
    // that answers three times in ten report a perfect 3/3.
    const corpus = [userRow("u0", "p0")];
    const samples = [
      ...Array.from({ length: 3 }, (_, i) => draw("p0", i, "code", "easy", 0.9)),
      ...Array.from({ length: 7 }, (_, i) => draw("p0", i + 3, null, null, null)),
    ];
    const p = buildSelfConsistencyReport({ corpus, samples }, CFG)
      .perPrompt[0] as PromptSelfConsistency;
    expect(p.draws).toBe(10);
    expect(p.abstentions).toBe(7);
    expect(p.pairFrequency.rate).toMatchObject({ n: 3, d: 10 });
    expect(p.modalPair).toBe("code/easy");
  });

  test("a prompt whose every draw abstained has no modal label and contributes no gap", () => {
    const corpus = [userRow("u0", "p0")];
    const samples = Array.from({ length: 10 }, (_, i) => draw("p0", i, null, null, null));
    const r = buildSelfConsistencyReport({ corpus, samples }, CFG);
    expect(r.perPrompt[0]?.modalPair).toBeNull();
    expect(r.perPrompt[0]?.gap).toBeNull();
    expect(r.bias.whole.prompts).toBe(0);
    expect(r.coverage.entriesAllAbstained).toBe(1);
  });
});

describe("planning, cost and the pilot", () => {
  test("the sampled model IS the shipped default classifier, not a second declaration of it", () => {
    expect(SAMPLED_MODEL).toBe(REPLAY_MODELS[0] as ReplayModel);
    expect(SAMPLED_MODEL.model.id).toBe("claude-haiku-4-5");
  });

  test("the dry-run leg is n calls per prompt at the model's own prices", () => {
    const [spec] = selfConsistencyCallSpecs(10);
    expect(spec).toMatchObject({
      callsPerPrompt: 10,
      inputUsdPerMTok: SAMPLED_MODEL.model.cost.input,
      outputUsdPerMTok: SAMPLED_MODEL.model.cost.output,
      fixedInputTokensPerCall: LABEL_INSTRUCTION_TOKENS,
      outputTokensPerCall: SAMPLED_MODEL.outputTokensPerCall,
    });
    expect(spec?.label).toContain("x10");
  });

  test("the projection is re-derivable by hand", () => {
    // One 4-char prompt: 1 input token + 99 instruction = 100 in per call, 150 out per call.
    // 10 draws at $1/$5 per Mtok = 10*(100/1e6*1) + 10*(150/1e6*5) = 0.001 + 0.0075 = 0.0085.
    const e = projectSamplingLane([prompt("abcd")], 10, SAMPLED_MODEL);
    expect(e.totalCalls).toBe(10);
    expect(e.totalInputTokens).toBe(1000);
    expect(e.totalOutputTokens).toBe(1500);
    expect(e.totalUsd).toBeCloseTo(0.0085, 6);
  });

  test("the pilot is the first ten entries in first-appearance order — deterministic", () => {
    const corpus = Array.from({ length: 30 }, (_, i) => prompt(`prompt-${i}`));
    expect(pilotEntries(corpus).map((p) => p.text)).toEqual(
      Array.from({ length: 10 }, (_, i) => `prompt-${i}`),
    );
    expect(pilotEntries(corpus)).toEqual(pilotEntries(corpus));
    expect(pilotEntries(corpus.slice(0, 4))).toHaveLength(4);
  });

  test("the pilot the PLANNER buys is the pilot the REPORT checks", () => {
    // Two pipelines reach the corpus — `corpusPrompts` for the planner, `segmentCorpus` for the
    // report — and both end in `distinctPrompts`, so both are in first-appearance order. If they
    // ever diverged, the run would buy one set of ten and the abort criterion would be evaluated
    // over another, which is a verdict about prompts nobody sampled.
    const rows = Array.from({ length: 25 }, (_, i) =>
      userRow(`u${i}`, `prompt-${i}`, BEFORE_TS + i),
    );
    const plannerPilot = pilotEntries(corpusPrompts(rows)).map((p) => p.text);
    const reportPilot = pilotEntries(segmentCorpus(rows, REGIME_BOUNDARY_TS)).map((p) => p.text);
    expect(plannerPilot).toEqual(reportPilot);
    expect(plannerPilot).toHaveLength(PILOT_ENTRIES);
    expect(plannerPilot[0]).toBe("prompt-0");
  });

  test("the leg's prices travel with every figure, so the total is re-derivable by hand", () => {
    const corpus = [prompt("abcd")];
    const w = summarizeSamplingOutstanding(
      planSampling(corpus, SAMPLED_MODEL, 10, new Set(), promptHash, KEY_OF),
      planSampling(corpus, SAMPLED_MODEL, 10, new Set(), promptHash, KEY_OF),
      corpus,
      CORPUS_REV,
    );
    expect(w.inputUsdPerMTok).toBe(SAMPLED_MODEL.model.cost.input);
    expect(w.outputUsdPerMTok).toBe(SAMPLED_MODEL.model.cost.output);
    expect(renderSamplingOutstanding(w)).toContain("$1/$5 per Mtok");
  });

  test("pilot draws PREPAY the same draws of the full lane — a re-run is a cache hit", () => {
    const corpus = Array.from({ length: 30 }, (_, i) => prompt(`prompt-${i}`));
    const pilotPlan = planSampling(pilotEntries(corpus), M, 10, new Set(), promptHash, KEY_OF);
    expect(pilotPlan.todo).toHaveLength(100);
    const bought = new Set(pilotPlan.todo.map((w) => KEY_OF(w.hash, M.model.id, w.sampleIndex)));
    // The pilot re-run now owes nothing…
    expect(planSampling(pilotEntries(corpus), M, 10, bought, promptHash, KEY_OF).todo).toHaveLength(
      0,
    );
    // …and the full lane owes 300 - 100 rather than all 300.
    const full = planSampling(corpus, M, 10, bought, promptHash, KEY_OF);
    expect(full.todo).toHaveLength(200);
    expect(full.cached).toBe(100);
  });

  test("the unit of work is the DRAW: a partially-sampled prompt owes only its missing draws", () => {
    const cached = new Set([
      KEY_OF(promptHash("p1"), M.model.id, 0),
      KEY_OF(promptHash("p1"), M.model.id, 1),
    ]);
    const plan = planSampling([prompt("p1")], M, 10, cached, promptHash, KEY_OF);
    expect(plan.todo).toHaveLength(8);
    expect(plan.cached).toBe(2);
    expect(plan.todo.map((w) => w.sampleIndex)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(projectSamplingCost(plan).totalCalls).toBe(8);
    expect(projectSamplingCost(plan).prompts).toBe(1);
  });

  test("BOTH gross projections are printed, always, so neither can go stale", () => {
    const corpus = Array.from({ length: 30 }, (_, i) => prompt(`prompt-${i}`));
    const w = summarizeSamplingOutstanding(
      planSampling(corpus, SAMPLED_MODEL, 10, new Set(), promptHash, KEY_OF),
      planSampling(pilotEntries(corpus), SAMPLED_MODEL, 10, new Set(), promptHash, KEY_OF),
      corpus,
      CORPUS_REV,
    );
    expect(w.fullLane.totalCalls).toBe(300);
    expect(w.pilotLane.totalCalls).toBe(100);
    expect(w.drawsCached).toMatchObject({ n: 0, d: 300 });
    const out = renderSamplingOutstanding(w);
    expect(out).toContain("FULL LANE from scratch");
    expect(out).toContain("PILOT from scratch");
    expect(out).toContain("provider default, unset");
    expect(out).toContain("samples per prompt (n)       10");
  });
});

describe("the argv decision (the CLI)", () => {
  test("--samples parses forgivingly, like the row cap and unlike the ceiling", () => {
    expect(resolveSamples(null)).toBe(DEFAULT_SAMPLES);
    for (const bad of ["abc", "0", "-5", "", "NaN"]) {
      expect(resolveSamples(bad), `samples: ${bad}`).toBe(DEFAULT_SAMPLES);
    }
    expect(resolveSamples("20")).toBe(20);
    expect(resolveSamples("7.9")).toBe(7);
  });

  test("--samples is FLOORED at 2: at n=1 the modal frequency is 1.0 by construction", () => {
    expect(resolveSamples("1")).toBe(MIN_SAMPLES);
    expect(MIN_SAMPLES).toBe(2);
    expect(decideInvocation(["--samples=1"])).toMatchObject({ samples: 2 });
  });

  test("every arm carries the sample count, so a projection and a spend cannot disagree on n", () => {
    for (const argv of [
      [],
      ["--correlate"],
      ["--adjudicate"],
      ["--self-consistency"],
      ["--score", "--target-correctness=0.85"],
      ["--spend"],
      ["--spend", "--max-usd=1"],
    ]) {
      expect(decideInvocation([...argv, "--samples=4"]), argv.join(" ")).toMatchObject({
        samples: 4,
      });
    }
  });

  test("--self-consistency is read-only and is decided INSIDE the no-spend branch", () => {
    expect(decideInvocation(["--self-consistency", "--project=minima", "--limit=50"])).toEqual({
      kind: "self-consistency",
      project: "minima",
      dbPath: null,
      rowCap: 50,
      samples: 10,
    });
    // A --spend in the same argv is still answered by the guard, in both directions.
    expect(decideInvocation(["--self-consistency", "--spend"])).toMatchObject({
      kind: "refuse-spend",
      reason: "missing-ceiling",
    });
    expect(decideInvocation(["--self-consistency", "--spend", "--max-usd=0.05"]).kind).toBe(
      "spend",
    );
  });

  test("it is APPENDED to the precedence, so no existing combined argv moved", () => {
    expect(decideInvocation(["--correlate", "--self-consistency"]).kind).toBe("correlate");
    expect(
      decideInvocation(["--score", "--target-correctness=0.85", "--self-consistency"]).kind,
    ).toBe("score");
    expect(decideInvocation(["--adjudicate", "--self-consistency"]).kind).toBe("adjudicate");
    expect(decideInvocation(["--self-consistency"]).kind).toBe("self-consistency");
  });

  test("--pilot is a MODIFIER, never a verb: on its own it decides a read-only mode", () => {
    expect(decideInvocation(["--pilot"]).kind).toBe("dry-run");
    expect(decideInvocation(["--pilot", "--self-consistency"]).kind).toBe("self-consistency");
    expect(decideInvocation(["--pilot", "--max-usd=9"]).kind).toBe("dry-run");
    // It is read only on the arm that already earned permission.
    expect(decideInvocation(["--spend", "--max-usd=1", "--pilot"])).toMatchObject({
      kind: "spend",
      pilot: true,
    });
    expect(decideInvocation(["--spend", "--max-usd=1"])).toMatchObject({ pilot: false });
    // And it cannot supply the affirmative it never stated.
    expect(decideInvocation(["--spend", "--pilot"])).toMatchObject({ kind: "refuse-spend" });
  });

  test("--help still outranks everything, including a fully-formed pilot spend", () => {
    expect(decideInvocation(["--spend", "--max-usd=1", "--pilot", "--help"]).kind).toBe("help");
    expect(decideInvocation(["--self-consistency", "--help"]).kind).toBe("help");
  });

  test("the guard's invariant, re-enumerated over the flags MUB-217 added", () => {
    // The property, re-derived rather than restated: `spend` is reachable ONLY from --spend plus a
    // valid --max-usd, with no --help. The two new flags are on the axis rather than spot-checked,
    // because a flag that spends nothing is exactly the kind that opens a path by interacting.
    const axes = {
      spend: [[], ["--spend"]],
      ceiling: [[], ["--max-usd=0.05"], ["--max-usd=abc"]],
      help: [[], ["--help"]],
      selfConsistency: [[], ["--self-consistency"]],
      pilot: [[], ["--pilot"]],
      samples: [[], ["--samples=4"], ["--samples=1"], ["--samples=abc"]],
    };
    let spendable = 0;
    for (const spend of axes.spend) {
      for (const ceiling of axes.ceiling) {
        for (const help of axes.help) {
          for (const sc of axes.selfConsistency) {
            for (const pilot of axes.pilot) {
              for (const samples of axes.samples) {
                const argv = [...spend, ...ceiling, ...help, ...sc, ...pilot, ...samples];
                const valid = ceiling[0] === "--max-usd=0.05";
                const expected = help.length
                  ? "help"
                  : spend.length === 0
                    ? sc.length
                      ? "self-consistency"
                      : "dry-run"
                    : valid
                      ? "spend"
                      : "refuse-spend";
                const decided = decideInvocation(argv);
                expect(decided.kind, `argv: ${argv.join(" ") || "(none)"}`).toBe(expected);
                if (decided.kind === "spend") {
                  spendable++;
                  expect(argv).toContain("--spend");
                  expect(argv).toContain("--max-usd=0.05");
                  expect(argv).not.toContain("--help");
                }
                // The effective n is never below the floor, whatever was stated.
                if (decided.kind !== "help") {
                  expect(decided.samples).toBeGreaterThanOrEqual(MIN_SAMPLES);
                }
                expect(decideInvocation([...argv].reverse()).kind).toBe(expected);
              }
            }
          }
        }
      }
    }
    // --spend × valid ceiling × no help × self-consistency(2) × pilot(2) × samples(4) = 16.
    // Neither new flag adds a spendable argv or removes one.
    expect(spendable).toBe(16);
  });
});

describe("running the sampling — every guarantee runReplay bought, kept", () => {
  const okCall = (usd = 0.001) =>
    makeReplayCaller((_m, opts) => ({
      classify: async () => {
        opts.onCostUsd?.(usd);
        opts.onOutcome?.({
          kind: "labelled",
          classification: { taskType: "code", difficulty: "easy", confidence: 0.9 },
          stopReason: "stop",
        });
        return { taskType: "code" as const, difficulty: "easy" as const, confidence: 0.9 };
      },
    }));

  test("draws are written one at a time, each carrying its index and the temperature", async () => {
    const written: SelfConsistencySampleWrite[] = [];
    const plan = planSampling([prompt("p1")], M, 3, new Set(), promptHash, KEY_OF);
    await runSampling({
      plan,
      corpusRev: CORPUS_REV,
      call: okCall(),
      record: (s) => {
        written.push(s);
      },
      guard: { mayDispatch: () => true, book: () => {} },
      concurrency: 1,
    });
    expect(written.map((w) => w.sampleIndex)).toEqual([0, 1, 2]);
    expect(new Set(written.map((w) => w.temperature))).toEqual(new Set([SAMPLING_TEMPERATURE]));
    expect(written.every((w) => w.confidence === 0.9)).toBe(true);
  });

  test("a ledger that rejects a write STOPS the run rather than buying draws nothing stores", async () => {
    const plan = planSampling([prompt("p1")], M, 10, new Set(), promptHash, KEY_OF);
    const r = await runSampling({
      plan,
      corpusRev: CORPUS_REV,
      call: okCall(),
      record: () => {
        throw new Error("ledger down");
      },
      guard: { mayDispatch: () => true, book: () => {} },
      concurrency: 1,
    });
    expect(r.ledgerFailed).toBe(true);
    expect(r.unstored).toBe(1);
    expect(r.labelled).toBe(0);
    expect(r.skippedForLedger).toBe(9);
  });

  test("the live cap bounds dispatch, and what was paid for is reported as stored", async () => {
    let spent = 0;
    const plan = planSampling([prompt("p1")], M, 10, new Set(), promptHash, KEY_OF);
    const r = await runSampling({
      plan,
      corpusRev: CORPUS_REV,
      call: okCall(0.01),
      record: () => {},
      guard: {
        mayDispatch: () => spent < 0.03,
        book: (usd) => {
          spent += usd;
        },
      },
      concurrency: 1,
    });
    expect(r.ceilingHit).toBe(true);
    expect(r.attempted).toBe(3);
    expect(r.labelled).toBe(3);
    expect(r.skippedForCeiling).toBe(7);
  });

  test("a failed draw writes no row, so a rerun buys exactly that draw again", async () => {
    const call = makeReplayCaller((_m, opts) => ({
      classify: async () => {
        opts.onCostUsd?.(0.001);
        opts.onOutcome?.({ kind: "provider-error" });
        return null;
      },
    }));
    const written: SelfConsistencySampleWrite[] = [];
    const plan = planSampling([prompt("p1")], M, 4, new Set(), promptHash, KEY_OF);
    const r = await runSampling({
      plan,
      corpusRev: CORPUS_REV,
      call,
      record: (s) => {
        written.push(s);
      },
      guard: { mayDispatch: () => true, book: () => {} },
    });
    expect(written).toHaveLength(0);
    expect(r.failedByCause["provider-error"]).toBe(4);
    expect(planSampling([prompt("p1")], M, 4, new Set(), promptHash, KEY_OF).todo).toHaveLength(4);
  });

  test("a deterministic non-answer IS stored, as a null label with a null self-report", async () => {
    const call = makeReplayCaller((_m, opts) => ({
      classify: async () => {
        opts.onCostUsd?.(0.001);
        opts.onOutcome?.({ kind: "unusable", stopReason: "stop" });
        return null;
      },
    }));
    const written: SelfConsistencySampleWrite[] = [];
    const plan = planSampling([prompt("p1")], M, 2, new Set(), promptHash, KEY_OF);
    const r = await runSampling({
      plan,
      corpusRev: CORPUS_REV,
      call,
      record: (s) => {
        written.push(s);
      },
      guard: { mayDispatch: () => true, book: () => {} },
    });
    expect(r.unusable).toBe(2);
    expect(written.every((w) => w.taskType === null && w.confidence === null)).toBe(true);
  });
});

describe("the cache re-admits through the shipped parser, so it cannot deadlock", () => {
  test("a row whose taxonomy has moved is dropped by the READER and re-opened to the PLANNER", () => {
    // ADR 0008's third point, inherited. If the two disagreed, --self-consistency would report the
    // entry unsampled and --spend would answer "nothing to pay for", with no way out but deleting
    // rows or bumping CORPUS_REV.
    const stale = draw("p1", 0, "a-task-type-that-no-longer-exists", "easy", 0.9);
    const good = draw("p1", 1, "code", "easy", 0.9);
    expect(isReadableSample(stale)).toBe(false);
    expect(isReadableSample(good)).toBe(true);
    // A null label is a paid-for deterministic non-answer and stays readable.
    expect(isReadableSample(draw("p1", 2, null, null, null))).toBe(true);

    const usable = [stale, good].filter(isReadableSample);
    const cached = new Set(usable.map((s) => KEY_OF(s.prompt_hash, s.model_id, s.sample_index)));
    const plan = planSampling([prompt("p1")], M, 2, cached, promptHash, KEY_OF);
    // Draw 0 was dropped by the reader, so the planner re-buys exactly draw 0.
    expect(plan.todo.map((w) => w.sampleIndex)).toEqual([0]);

    const r = buildSelfConsistencyReport(
      { corpus: [userRow("u0", "p1")], samples: [stale, good] },
      { ...CFG, samples: 2 },
    );
    expect(r.coverage.rowsUnreadable).toBe(1);
    expect(r.perPrompt[0]?.draws).toBe(1);
  });

  test("rows at another revision, from another model, or for a vanished prompt are each counted", () => {
    const r = buildSelfConsistencyReport(
      {
        corpus: [userRow("u0", "p1")],
        samples: [
          draw("p1", 0, "code", "easy", 0.9),
          draw("p1", 1, "code", "easy", 0.9, { corpus_rev: "r1-old" }),
          draw("p1", 2, "code", "easy", 0.9, { model_id: "some-other-model" }),
          draw("gone-from-the-corpus", 0, "code", "easy", 0.9),
        ],
      },
      { ...CFG, samples: 2 },
    );
    expect(r.coverage.rowsAtOtherRev).toBe(1);
    expect(r.coverage.rowsOutsideModel).toBe(1);
    expect(r.coverage.rowsWithoutCorpusEntry).toBe(1);
    expect(r.perPrompt[0]?.draws).toBe(1);
  });
});

describe("the prompt text never leaves the ledger (AC: hashes, counts and keys only)", () => {
  const SECRET = "a phrase that must never be printed or persisted anywhere";

  test("it appears in no rendered output and no write payload", async () => {
    // The corpus is the owner's own development traffic. Hashes, counts and payload keys only.
    const corpus = [userRow("u0", SECRET)];
    const samples = Array.from({ length: 10 }, (_, i) =>
      draw(SECRET, i, "code", i < 6 ? "easy" : "hard", 0.95),
    );
    const report = buildSelfConsistencyReport({ corpus, samples }, CFG);
    const rendered = renderSelfConsistencyReport(report);
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain(promptHash(SECRET));
    // Identified by a hash PREFIX, which is present.
    expect(rendered).toContain(promptHash(SECRET).slice(0, 12));

    const written: SelfConsistencySampleWrite[] = [];
    await runSampling({
      plan: planSampling([prompt(SECRET)], M, 3, new Set(), promptHash, KEY_OF),
      corpusRev: CORPUS_REV,
      call: makeReplayCaller((_m, opts) => ({
        classify: async () => {
          opts.onOutcome?.({
            kind: "labelled",
            classification: { taskType: "code", difficulty: "easy", confidence: 0.9 },
            stopReason: "stop",
          });
          return { taskType: "code" as const, difficulty: "easy" as const, confidence: 0.9 };
        },
      })),
      record: (s) => {
        written.push(s);
      },
      guard: { mayDispatch: () => true, book: () => {} },
    });
    expect(JSON.stringify(written)).not.toContain(SECRET);

    const w = summarizeSamplingOutstanding(
      planSampling([prompt(SECRET)], M, 10, new Set(), promptHash, KEY_OF),
      planSampling([prompt(SECRET)], M, 10, new Set(), promptHash, KEY_OF),
      [prompt(SECRET)],
      CORPUS_REV,
    );
    expect(renderSamplingOutstanding(w)).not.toContain(SECRET);
  });

  test("nor in the ledger row itself", () => {
    const db = new MinimaDb(":memory:");
    try {
      db.upsertSelfConsistencySample({
        promptHash: promptHash(SECRET),
        modelId: "model-a",
        sampleIndex: 0,
        corpusRev: CORPUS_REV,
        temperature: SAMPLING_TEMPERATURE,
        taskType: "code",
      });
      expect(JSON.stringify(db.listSelfConsistencySamples(CORPUS_REV))).not.toContain(SECRET);
    } finally {
      db.close();
    }
  });
});

describe("the acceptance criteria, read off the output", () => {
  const f = fixture({ prompts: 12, samples: 10, agree: 6, confidence: 0.95 });
  const report = buildSelfConsistencyReport(f, CFG);
  const out = renderSelfConsistencyReport(report);

  test("AC 1 — the sample count is configurable AND recorded", () => {
    expect(out).toContain("samples per prompt (n)       10");
    expect(out).toContain("(effective, after --samples' fallback and floor)");
    // "Recorded" is read back off the rows, not asserted about them.
    expect(report.coverage.temperaturesRecorded).toEqual([SAMPLING_TEMPERATURE]);
    expect(out).toContain("temperature recorded on rows provider default, unset");
  });

  test("AC 2 — per-prompt AND aggregate modal-label frequency", () => {
    expect(report.perPrompt).toHaveLength(12);
    expect(out).toContain("Per prompt (identified by hash prefix");
    expect(report.bias.whole.modalFrequency.rate).toMatchObject({ n: 72, d: 120 });
    expect(out).toContain("modal-label frequency (PAIR)");
  });

  test("AC 3 — the gap is quantified and carries its direction", () => {
    expect(report.bias.whole.meanGap).toBeCloseTo(0.35, 6);
    expect(report.bias.whole.over.rate).toMatchObject({ n: 12, d: 12 });
    expect(out).toContain("overconfident");
  });

  test("AC 4 — it runs with no reference labels: the input type has nowhere to put one", () => {
    // Structural rather than remembered. `SelfConsistencyInput` is {corpus, samples}; there is no
    // votes field, no replayLabels field and no decisions field for a reference to arrive through.
    expect(Object.keys(f).sort()).toEqual(["corpus", "samples"]);
  });

  test("AC 5 — the sampling cost is in the dry-run estimate", () => {
    // The leg the shell adds beside panelCallSpecs and replayCallSpecs.
    expect(selfConsistencyCallSpecs(10)).toHaveLength(1);
    expect(selfConsistencyCallSpecs(10)[0]?.callsPerPrompt).toBe(10);
  });

  test("AC 6 — the limitation is stated explicitly in the output", () => {
    expect(out).toContain("This measures SELF-CONSISTENCY, not CORRECTNESS");
    expect(out).toContain("A model that is consistently wrong looks");
    expect(out).toContain("perfectly calibrated by this metric alone");
    expect(SELF_CONSISTENCY_LIMITS.length).toBeGreaterThan(0);
    for (const line of SELF_CONSISTENCY_LIMITS) expect(out).toContain(line);
  });
});
