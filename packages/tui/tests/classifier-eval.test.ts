import { describe, expect, test } from "bun:test";
import { MinimaDb, type UserPromptRow } from "../src/db/minima_db.ts";
import {
  type CallSpec,
  type DistinctPrompt,
  type DryRunConfig,
  buildDryRunReport,
  checkSpendCeiling,
  decideInvocation,
  distinctPrompts,
  estimateRunCost,
  estimateTokens,
  formatRate,
  partitionLeadPrompts,
  partitionSteerText,
  rate,
  renderDryRunReport,
  stratifyByLength,
  suggestCeilingUsd,
} from "../src/minima/classifier_eval.ts";

// MUB-215 — the classifier evaluation's pure core. Every function here is total and takes plain
// arrays, so these tests construct rows directly: no ledger, no network, no spend.

/** A minimal user-prompt row (only the fields the eval core reads). Lead agent unless overridden. */
function ev(text: string | null, over: Partial<UserPromptRow> = {}): UserPromptRow {
  return { id: "e1", run_id: "r1", ts: 1, agent_id: null, text, ...over };
}

/** A distinct prompt of an exact character length. */
function p(chars: number, occurrences = 1): DistinctPrompt {
  return { text: "x".repeat(chars), occurrences };
}

describe("partitionSteerText", () => {
  test("routes harness-authored steer messages to excluded, real prompts to corpus", () => {
    // One row per prefix the shipped predicate keys on: stop-gate continuation, step-cap wrap,
    // doom-loop nudge, stream tripwire.
    const rows = [
      ev("fix the parser"),
      ev("⛔ You are ending the turn, but the plan is not done — 2 step(s) still need"),
      ev("⚠ You have used 40 of 50 steps"),
      ev("⚠ You have called read 12 times"),
      ev("Stream tripwire fired: you claimed done without a verify"),
      ev("add a test for the ledger"),
    ];
    const { corpus, excluded } = partitionSteerText(rows);
    expect(corpus.map((r) => r.text)).toEqual(["fix the parser", "add a test for the ledger"]);
    expect(excluded).toHaveLength(4);
  });
});

describe("partitionLeadPrompts", () => {
  test("keeps lead-agent prompts, sets sub-agent prompts aside", () => {
    // The harness classifier runs only when agent_id is null (runtime.ts gates on it), so a
    // sub-agent's brief is traffic it never labels — scoring it there would be measuring the
    // wrong thing. Set aside, never silently dropped.
    const rows = [
      ev("fix the parser"),
      ev("research terminal sprite rendering", { id: "e2", agent_id: "child-1" }),
      ev("add a test", { id: "e3" }),
    ];
    const { lead, subagent } = partitionLeadPrompts(rows);
    expect(lead.map((r) => r.text)).toEqual(["fix the parser", "add a test"]);
    expect(subagent.map((r) => r.text)).toEqual(["research terminal sprite rendering"]);
  });
});

describe("distinctPrompts", () => {
  test("dedupes on exact recorded text, first-appearance order, counting occurrences", () => {
    const rows = [
      ev("fix the parser", { id: "a", ts: 1 }),
      ev("add a test", { id: "b", ts: 2 }),
      ev("fix the parser", { id: "c", ts: 3, run_id: "r2" }),
    ];
    expect(distinctPrompts(rows)).toEqual([
      { text: "fix the parser", occurrences: 2 },
      { text: "add a test", occurrences: 1 },
    ]);
  });

  test("drops rows carrying no usable prompt text", () => {
    expect(distinctPrompts([ev(null), ev(""), ev("   ")])).toEqual([]);
  });
});

describe("rate", () => {
  test("carries the numerator, the denominator and the percentage together", () => {
    // 138/305 = 45.2459…% — worked independently of the implementation.
    expect(rate(138, 305)).toEqual({ n: 138, d: 305, pct: 45.2 });
  });

  test("an empty denominator yields no percentage rather than a divide-by-zero", () => {
    expect(rate(0, 0)).toEqual({ n: 0, d: 0, pct: null });
  });
});

describe("formatRate", () => {
  test("renders the denominator inseparably from the percentage", () => {
    expect(formatRate(rate(138, 305))).toBe("138/305 (45.2%)");
  });

  test("renders an empty denominator as n/a, never as a bare 0%", () => {
    expect(formatRate(rate(0, 0))).toBe("0/0 (n/a)");
  });
});

describe("stratifyByLength", () => {
  test("buckets by character length, each share carrying the corpus denominator", () => {
    // Boundaries are lower-inclusive: 60 lands in the middle bucket, 199 too, 200 in the last.
    const prompts = [p(10), p(60), p(199), p(200)];
    expect(stratifyByLength(prompts, [60, 200])).toEqual([
      { label: "<60", minChars: 0, maxChars: 59, count: 1, share: rate(1, 4) },
      { label: "60-199", minChars: 60, maxChars: 199, count: 2, share: rate(2, 4) },
      { label: ">=200", minChars: 200, maxChars: null, count: 1, share: rate(1, 4) },
    ]);
  });

  test("counts distinct prompts, not occurrences", () => {
    // One prompt asked 40 times is one corpus entry — a repeat is not new evidence.
    const strata = stratifyByLength([p(10, 40)], [60]);
    expect(strata.map((s) => s.count)).toEqual([1, 0]);
  });

  test("an empty corpus yields every stratum at zero with no percentage", () => {
    const strata = stratifyByLength([], [60]);
    expect(strata.map((s) => s.count)).toEqual([0, 0]);
    expect(strata.every((s) => s.share.pct === null)).toBe(true);
  });

  test("total: unsorted, duplicate and non-positive boundaries still yield sane strata", () => {
    expect(stratifyByLength([p(10), p(80)], [200, 60, 60, 0, -5]).map((s) => s.label)).toEqual([
      "<60",
      "60-199",
      ">=200",
    ]);
  });
});

describe("estimateTokens", () => {
  test("estimates four characters per token, rounding up", () => {
    expect(estimateTokens("x".repeat(400))).toBe(100);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("estimateRunCost", () => {
  function spec(over: Partial<CallSpec> = {}): CallSpec {
    return {
      label: "panel",
      callsPerPrompt: 1,
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      fixedInputTokensPerCall: 0,
      outputTokensPerCall: 50,
      ...over,
    };
  }

  test("prices the per-call instruction overhead, not only the prompt", () => {
    // The classifier's system prompt is ~99 tokens against a ~17-token average prompt, so
    // omitting it understates input by nearly 7x. 1 prompt x 400 chars = 100 tokens, + 99 = 199.
    const est = estimateRunCost([p(400)], [spec({ fixedInputTokensPerCall: 99 })]);
    expect(est.totalInputTokens).toBe(199);
  });

  test("prices input from the prompts and output from the declared per-call budget", () => {
    // 2 prompts x 400 chars = 200 input tokens; 2 calls x 50 = 100 output tokens.
    // 200/1e6 * $3 = $0.0006, 100/1e6 * $15 = $0.0015, total $0.0021 — worked by hand.
    const est = estimateRunCost([p(400), p(400)], [spec()]);
    expect(est.totalCalls).toBe(2);
    expect(est.totalInputTokens).toBe(200);
    expect(est.totalOutputTokens).toBe(100);
    expect(est.totalUsd).toBe(0.0021);
  });

  test("sums across a provider-diverse panel and reports each leg separately", () => {
    const est = estimateRunCost(
      [p(400)],
      [spec({ label: "a" }), spec({ label: "b", callsPerPrompt: 3 })],
    );
    expect(est.totalCalls).toBe(4);
    expect(est.lines.map((l) => l.label)).toEqual(["a", "b"]);
    expect(est.lines[1]?.calls).toBe(3);
  });

  test("prices every distinct prompt once, however often it was asked", () => {
    const once = estimateRunCost([p(400, 1)], [spec()]);
    const forty = estimateRunCost([p(400, 40)], [spec()]);
    expect(forty.totalUsd).toBe(once.totalUsd);
  });

  test("total: an empty corpus costs nothing and issues no calls", () => {
    const est = estimateRunCost([], [spec()]);
    expect(est.totalCalls).toBe(0);
    expect(est.totalUsd).toBe(0);
  });
});

describe("buildDryRunReport", () => {
  const cfg: DryRunConfig = {
    scope: "whole ledger",
    lengthBoundaries: [60],
    specs: [
      {
        label: "reference panel",
        callsPerPrompt: 1,
        inputUsdPerMTok: 3,
        outputUsdPerMTok: 15,
        // Required, and it was omitted here until MUB-216's spend guard landed: tsconfig's
        // `include` is src-only, so tsc never saw the gap, and every cost figure below was NaN.
        // `toBe` is Object.is, so NaN === NaN — the "never costs the steer text" test passed
        // whatever the core did. State it, even as 0.
        fixedInputTokensPerCall: 0,
        outputTokensPerCall: 50,
      },
    ],
  };

  test("reports the corpus, the steer exclusion and the unusable rows, each with its denominator", () => {
    const rows = [
      ev("fix the parser"),
      ev("fix the parser", { id: "e2", ts: 2 }), // a repeat: one corpus entry, two occurrences
      ev("⚠ You have used 40 of 50 steps", { id: "e3", ts: 3 }),
      ev(null, { id: "e4", ts: 4 }),
    ];
    const r = buildDryRunReport(rows, cfg);
    expect(r.rawUserRows).toBe(4);
    expect(r.corpusDistinct).toBe(1);
    expect(r.corpusOccurrences).toBe(2);
    expect(r.steerRows).toEqual(rate(1, 4));
    expect(r.steerDistinct).toEqual(rate(1, 2)); // 1 steer text among 2 distinct texts
    expect(r.unusableRows).toEqual(rate(1, 4));
  });

  test("excludes sub-agent prompts from the corpus and reports them with a denominator", () => {
    const rows = [
      ev("fix the parser"),
      ev("research sprite rendering", { id: "e2", agent_id: "child-1" }),
    ];
    const r = buildDryRunReport(rows, cfg);
    expect(r.corpusDistinct).toBe(1);
    expect(r.subagentRows).toEqual(rate(1, 2));
    expect(r.cost.prompts).toBe(1); // never priced
  });

  test("flags a truncated read, so a capped corpus is never read as the whole corpus", () => {
    const rows = [ev("a"), ev("b", { id: "e2" })];
    expect(buildDryRunReport(rows, { ...cfg, rowCap: 2 }).capHit).toBe(true);
    expect(buildDryRunReport(rows, { ...cfg, rowCap: 99 }).capHit).toBe(false);
  });

  test("the corpus and the steer set partition the distinct texts exactly", () => {
    const rows = [
      ev("a"),
      ev("b", { id: "e2" }),
      ev("⚠ You have called read 12 times", { id: "e3" }),
    ];
    const r = buildDryRunReport(rows, cfg);
    expect(r.corpusDistinct + r.steerDistinct.n).toBe(r.steerDistinct.d);
  });

  test("costs the corpus, never the excluded steer text", () => {
    const prompt = "x".repeat(400);
    const withSteer = buildDryRunReport(
      [ev(prompt), ev(`⚠ You have used ${"y".repeat(400)}`, { id: "e2" })],
      cfg,
    );
    const withoutSteer = buildDryRunReport([ev(prompt)], cfg);
    expect(withSteer.cost.totalUsd).toBe(withoutSteer.cost.totalUsd);
  });

  test("total: no rows at all yields a zero report with no percentages", () => {
    const r = buildDryRunReport([], cfg);
    expect(r.rawUserRows).toBe(0);
    expect(r.corpusDistinct).toBe(0);
    expect(r.steerRows.pct).toBeNull();
    expect(r.cost.totalCalls).toBe(0);
  });
});

describe("renderDryRunReport", () => {
  const cfg: DryRunConfig = { scope: "whole ledger", lengthBoundaries: [60], specs: [] };

  test("prints every rate with its denominator and states that nothing was spent", () => {
    const out = renderDryRunReport(buildDryRunReport([ev("fix the parser"), ev(null)], cfg));
    expect(out).toContain("1/2"); // the unusable-row rate, denominator attached
    expect(out).toContain("$0.00");
    expect(out).toMatch(/no billable call/i);
  });

  test("never prints a bare percentage when there is no denominator", () => {
    const out = renderDryRunReport(buildDryRunReport([], cfg));
    expect(out).toContain("n/a");
    expect(out).not.toMatch(/\bNaN\b/);
  });

  test("states the corpus's limits, so aggregate figures are not read as general ones", () => {
    const out = renderDryRunReport(buildDryRunReport([ev("fix the parser")], cfg));
    expect(out).toMatch(/one developer's traffic/i);
  });

  test("warns in the report itself when the read was truncated", () => {
    const capped = renderDryRunReport(buildDryRunReport([ev("a")], { ...cfg, rowCap: 1 }));
    const whole = renderDryRunReport(buildDryRunReport([ev("a")], { ...cfg, rowCap: 99 }));
    expect(capped).toMatch(/truncated/i);
    expect(whole).not.toMatch(/truncated/i);
  });

  test("prints the price basis, so the estimate can be re-derived from the output", () => {
    const out = renderDryRunReport(
      buildDryRunReport([ev("x".repeat(400))], {
        scope: "whole ledger",
        lengthBoundaries: [60],
        specs: [
          {
            label: "panel",
            callsPerPrompt: 1,
            inputUsdPerMTok: 3,
            outputUsdPerMTok: 15,
            fixedInputTokensPerCall: 0,
            outputTokensPerCall: 50,
          },
        ],
      }),
    );
    expect(out).toContain("$3/$15 per Mtok");
  });
});

describe("decideInvocation", () => {
  test("no flags means a dry run over the whole ledger", () => {
    expect(decideInvocation([])).toEqual({
      kind: "dry-run",
      project: null,
      dbPath: null,
      rowCap: 20000,
    });
  });

  test("a bare --spend is an intention, not permission", () => {
    // The affirmative is the ceiling, so --spend alone cannot be read as permission however it is
    // combined. Before a paid path existed this was pinned as "refusal wins over every other flag";
    // the guarantee now rests on the ceiling rather than on flag order (see the matrix below).
    expect(decideInvocation(["--spend"])).toMatchObject({
      kind: "refuse-spend",
      reason: "missing-ceiling",
    });
    expect(decideInvocation(["--project=x", "--spend"])).toMatchObject({
      kind: "refuse-spend",
      reason: "missing-ceiling",
    });
  });

  test("a refusal carries the scope, so the shell can price the corpus it was asked about", () => {
    // Choosing a ceiling requires a number, and the number depends on which rows were in scope.
    expect(decideInvocation(["--spend", "--project=minima", "--limit=50"])).toEqual({
      kind: "refuse-spend",
      reason: "missing-ceiling",
      project: "minima",
      dbPath: null,
      rowCap: 50,
    });
  });

  test("a ceiling that is not a positive number of dollars is refused, never defaulted", () => {
    // The one place a fallback would cost money, so --limit's forgiving parse is NOT mirrored here.
    for (const bad of ["abc", "0", "-1", "", "NaN", "Infinity", "1e999"]) {
      expect(decideInvocation(["--spend", `--max-usd=${bad}`])).toMatchObject({
        kind: "refuse-spend",
        reason: "bad-ceiling",
      });
    }
  });

  test("--spend with a ceiling is the one argv that permits spending", () => {
    expect(decideInvocation(["--spend", "--max-usd=0.05", "--project=minima"])).toEqual({
      kind: "spend",
      maxUsd: 0.05,
      project: "minima",
      dbPath: null,
      rowCap: 20000,
    });
  });

  test("a ceiling without --spend is a dry run, not a spend", () => {
    expect(decideInvocation(["--max-usd=999"]).kind).toBe("dry-run");
  });

  test("--help asks for help, and outranks a fully-formed spend request", () => {
    // Asking for documentation must never bill. This is why --help is decided before the spend
    // branch: with `spend` reachable, the old refusal-first order would let this argv spend.
    expect(decideInvocation(["--help"]).kind).toBe("help");
    expect(decideInvocation(["--spend", "--max-usd=1", "--help"]).kind).toBe("help");
    expect(decideInvocation(["--spend", "--help"]).kind).toBe("help");
  });

  test("the guard's invariant, over every combination of the flags that bear on it", () => {
    // The property the cost guard exists to hold, re-derived independently of the implementation
    // rather than restated from it: `spend` is reachable ONLY from an argv carrying --spend and a
    // valid --max-usd, with no --help. Every combination is enumerated, so a future flag cannot
    // open a path by interacting with one that was only spot-checked.
    const axes = {
      spend: [[], ["--spend"]],
      ceiling: [[], ["--max-usd=0.05"], ["--max-usd=abc"], ["--max-usd=0"], ["--max-usd=-1"]],
      help: [[], ["--help"]],
      // MUB-225's read-only mode is on this axis rather than spot-checked beside it: a mode that
      // spends nothing is exactly the kind of flag that opens a path by interacting with one.
      correlate: [[], ["--correlate"]],
      project: [[], ["--project=p"]],
    };
    let spendable = 0;
    for (const spend of axes.spend) {
      for (const ceiling of axes.ceiling) {
        for (const help of axes.help) {
          for (const correlate of axes.correlate) {
            for (const project of axes.project) {
              const argv = [...spend, ...ceiling, ...help, ...correlate, ...project];
              const wants = spend.length > 0;
              const stated = ceiling.length > 0;
              const valid = ceiling[0] === "--max-usd=0.05";
              const reads = correlate.length > 0;
              const expected = help.length
                ? "help"
                : !wants
                  ? reads
                    ? "correlate"
                    : "dry-run"
                  : !stated || !valid
                    ? "refuse-spend"
                    : "spend";
              const decided = decideInvocation(argv);
              expect(decided.kind, `argv: ${argv.join(" ") || "(none)"}`).toBe(expected);
              if (decided.kind === "spend") {
                spendable++;
                expect(argv).toContain("--spend");
                expect(argv).toContain("--max-usd=0.05");
                expect(argv).not.toContain("--help");
              }
              // Flag order carries no permission: the same flags in reverse decide the same way.
              expect(decideInvocation([...argv].reverse()).kind).toBe(expected);
            }
          }
        }
      }
    }
    // Only the --spend + valid-ceiling + no-help argvs, × project × correlate — the read-only mode
    // neither adds a spendable argv nor removes one.
    expect(spendable).toBe(4);
  });

  test("reads the project, ledger path and row cap", () => {
    expect(decideInvocation(["--project=minima", "--db=/tmp/x.db", "--limit=50"])).toEqual({
      kind: "dry-run",
      project: "minima",
      dbPath: "/tmp/x.db",
      rowCap: 50,
    });
  });

  test("total: a nonsense row cap falls back to the default rather than reading nothing", () => {
    expect(decideInvocation(["--limit=abc"])).toMatchObject({ rowCap: 20000 });
    expect(decideInvocation(["--limit=-5"])).toMatchObject({ rowCap: 20000 });
    expect(decideInvocation(["--limit=0"])).toMatchObject({ rowCap: 20000 });
    expect(decideInvocation(["--limit=7.9"])).toMatchObject({ rowCap: 7 });
  });
});

describe("checkSpendCeiling", () => {
  test("a projection within the stated ceiling passes", () => {
    expect(checkSpendCeiling(0.0312, 0.05)).toEqual({ ok: true });
  });

  test("a projection over the ceiling is refused, and reports both figures", () => {
    // Both numbers come from the verdict so the shell states neither on its own authority.
    expect(checkSpendCeiling(0.0312, 0.01)).toEqual({
      ok: false,
      estimateUsd: 0.0312,
      maxUsd: 0.01,
    });
  });

  test("boundary: an estimate exactly at the ceiling passes", () => {
    // The ceiling is a limit the caller accepted paying, not one they accepted staying under.
    expect(checkSpendCeiling(0.05, 0.05)).toEqual({ ok: true });
  });

  test("a zero-cost projection passes any ceiling", () => {
    // An empty corpus costs nothing, and refusing it would be a confusing way to say so.
    expect(checkSpendCeiling(0, 0.01)).toEqual({ ok: true });
  });
});

describe("suggestCeilingUsd", () => {
  test("rounds up to the next cent, with no headroom for actuals", () => {
    expect(suggestCeilingUsd(0.0312)).toBe(0.04);
    expect(suggestCeilingUsd(0.2401)).toBe(0.25);
  });

  test("an exact-cent estimate suggests itself, not a cent more", () => {
    // The direct `x * 100` form fails here: nine values under $2 have a binary expansion just
    // above their exact cent, so it would print $0.08 for a $0.07 projection.
    for (const exact of [0.03, 0.05, 0.07, 0.14, 0.28, 0.55, 0.56, 1.15]) {
      expect(suggestCeilingUsd(exact), `$${exact}`).toBe(exact);
    }
  });

  test("never suggests a ceiling of zero", () => {
    // A ceiling of $0 refuses everything, including the run the caller is trying to authorize.
    expect(suggestCeilingUsd(0)).toBe(0.01);
    expect(suggestCeilingUsd(0.000004)).toBe(0.01);
  });

  test("a suggested ceiling always clears the projection it was derived from", () => {
    // The two functions have to agree: a printed suggestion that the guard then refuses would
    // make the guard look broken to the one caller who followed its advice exactly.
    for (let i = 0; i <= 5000; i++) {
      const projection = Math.round(i * 4.37 * 1e2) / 1e6;
      expect(
        checkSpendCeiling(projection, suggestCeilingUsd(projection)).ok,
        `$${projection}`,
      ).toBe(true);
    }
  });
});

// The one impure hunk: the ledger read that produces the corpus. Hermetic — an in-memory ledger,
// no network, no spend. Every sibling accessor in minima_db.ts is exercised this way.

describe("MinimaDb.listUserPrompts", () => {
  function ledger(): MinimaDb {
    const db = new MinimaDb(":memory:");
    db.ensureProject("proj-a");
    db.ensureProject("proj-b");
    db.startRun({ runId: "run-a", projectKey: "proj-a" });
    db.startRun({ runId: "run-b", projectKey: "proj-b" });
    return db;
  }

  test("lifts the prompt text out of the payload and carries the agent id", () => {
    const db = ledger();
    db.appendEvent({ runId: "run-a", type: "user", payload: { role: "user", text: "hi" }, ts: 1 });
    db.appendEvent({
      runId: "run-a",
      agentId: "child-1",
      type: "user",
      payload: { role: "user", text: "sub" },
      ts: 2,
    });
    const rows = db.listUserPrompts();
    expect(rows.map((r) => [r.text, r.agent_id])).toEqual([
      ["hi", null],
      ["sub", "child-1"],
    ]);
    db.close();
  });

  test("reads only user-role events, never assistant or routing ones", () => {
    const db = ledger();
    db.appendEvent({ runId: "run-a", type: "user", payload: { text: "prompt" }, ts: 1 });
    db.appendEvent({ runId: "run-a", type: "assistant", payload: { text: "reply" }, ts: 2 });
    db.appendEvent({ runId: "run-a", type: "routing", payload: { rec_id: "r" }, ts: 3 });
    expect(db.listUserPrompts().map((r) => r.text)).toEqual(["prompt"]);
    db.close();
  });

  test("scopes to one project's runs when asked, and spans the ledger when not", () => {
    const db = ledger();
    db.appendEvent({ runId: "run-a", type: "user", payload: { text: "in-a" }, ts: 1 });
    db.appendEvent({ runId: "run-b", type: "user", payload: { text: "in-b" }, ts: 2 });
    expect(db.listUserPrompts("proj-a").map((r) => r.text)).toEqual(["in-a"]);
    expect(db.listUserPrompts(null).map((r) => r.text)).toEqual(["in-a", "in-b"]);
    db.close();
  });

  test("a row cap keeps the NEWEST rows and still returns them oldest-first", () => {
    // Truncating from the old end would answer with pre-regime-change traffic — the reading most
    // likely to mislead. The order out stays chronological so downstream correlation is unaffected.
    const db = ledger();
    for (const [i, text] of ["oldest", "middle", "newest"].entries()) {
      db.appendEvent({ runId: "run-a", type: "user", payload: { text }, ts: i + 1 });
    }
    expect(db.listUserPrompts(null, 2).map((r) => r.text)).toEqual(["middle", "newest"]);
    db.close();
  });

  test("a payload with no text field yields null rather than throwing", () => {
    const db = ledger();
    db.appendEvent({ runId: "run-a", type: "user", payload: { role: "user" }, ts: 1 });
    expect(db.listUserPrompts().map((r) => r.text)).toEqual([null]);
    db.close();
  });
});
