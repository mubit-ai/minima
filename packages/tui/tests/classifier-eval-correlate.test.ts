import { describe, expect, test } from "bun:test";
import {
  type DecisionWrite,
  MinimaDb,
  type RoutingDecisionRow,
  type UserPromptRow,
} from "../src/db/minima_db.ts";
import { decideInvocation } from "../src/minima/classifier_eval.ts";
import {
  buildCorrelationReport,
  correlateDecisions,
  corroborate,
  groupByCorpusEntry,
  partitionServiceRouted,
  renderCorrelationReport,
} from "../src/minima/classifier_eval_correlate.ts";

// MUB-225 — prompt↔decision correlation. The link is INFERRED, so every test here constructs rows
// directly: no ledger, no network, no spend. The only ledger touch is the accessor's own describe
// block at the bottom, which uses an in-memory DB.

/** A user-prompt row. Lead agent, run `r1`, unless overridden. */
function ev(ts: number, text: string | null, over: Partial<UserPromptRow> = {}): UserPromptRow {
  return { id: `e${ts}`, run_id: "r1", ts, agent_id: null, text, ...over };
}

/** A decision row. Service-routed, run `r1`, unless overridden. */
function dec(ts: number, over: Partial<RoutingDecisionRow> = {}): RoutingDecisionRow {
  return {
    rec_id: `d${ts}`,
    run_id: "r1",
    ts,
    agent_id: null,
    task_label: null,
    routed: "server",
    ...over,
  };
}

describe("partitionServiceRouted", () => {
  test("keeps server-routed decisions, sets offline and pinned ones aside", () => {
    // Only a service-routed decision has a recommendation behind it. An offline or pinned turn
    // never asked the service, so it is not evidence about the classifier — set aside, not dropped.
    const rows = [
      dec(1),
      dec(2, { routed: "offline" }),
      dec(3, { routed: "pinned" }),
      dec(4, { routed: "server" }),
    ];
    const { serviceRouted, other } = partitionServiceRouted(rows);
    expect(serviceRouted.map((d) => d.rec_id)).toEqual(["d1", "d4"]);
    expect(other.map((d) => d.rec_id)).toEqual(["d2", "d3"]);
  });
});

describe("correlateDecisions — the run-and-timestamp rule", () => {
  test("pairs a decision with the most recent prompt in its run at or before its timestamp", () => {
    const prompts = [ev(10, "first"), ev(20, "second"), ev(40, "third")];
    const { pairings } = correlateDecisions([dec(30)], prompts);
    expect(pairings).toHaveLength(1);
    expect(pairings[0]?.promptEventId).toBe("e20");
  });

  test("pairs on an exactly equal timestamp — 'at or before', not strictly before", () => {
    const { pairings } = correlateDecisions([dec(20)], [ev(10, "first"), ev(20, "second")]);
    expect(pairings[0]?.promptEventId).toBe("e20");
  });

  test("never reaches across runs, even when the other run's prompt is nearer in time", () => {
    const prompts = [ev(10, "same run"), ev(19, "other run", { run_id: "r2" })];
    const { pairings } = correlateDecisions([dec(20)], prompts);
    expect(pairings[0]?.promptEventId).toBe("e10");
  });

  test("reports a decision with no prompt at or before it as uncorrelated, never dropped", () => {
    const { pairings, unpaired } = correlateDecisions([dec(5), dec(30)], [ev(10, "later")]);
    expect(pairings.map((p) => p.recId)).toEqual(["d30"]);
    expect(unpaired.map((u) => u.recId)).toEqual(["d5"]);
  });

  test("separates a decision the prompt read never reached from one with no earlier prompt", () => {
    // Both are uncorrelated, for opposite reasons. A capped prompt read leaves old decisions with
    // nothing to pair against, and calling that "no prompt caused this decision" would report the
    // read's own window as a finding about the ledger.
    const prompts = [ev(10, "in window"), ev(30, "in window too")];
    const decisions = [dec(5), dec(20, { rec_id: "d-other-run", run_id: "r9" })];
    const { unpaired } = correlateDecisions(decisions, prompts);
    expect(unpaired.map((u) => [u.recId, u.reason])).toEqual([
      ["d5", "before-read-window"],
      ["d-other-run", "no-earlier-prompt-in-run"],
    ]);
  });

  test("breaks a timestamp tie deterministically on the later-recorded prompt", () => {
    // Two prompts share a timestamp. The rule must still name one, the same one every run —
    // otherwise the reported corroboration rate moves without the ledger moving.
    const prompts = [ev(10, "earlier row", { id: "e-a" }), ev(10, "later row", { id: "e-b" })];
    const { pairings } = correlateDecisions([dec(10)], prompts);
    expect(pairings[0]?.promptEventId).toBe("e-b");
  });

  test("is independent of the order rows arrive in", () => {
    const forward = [ev(10, "first"), ev(20, "second"), ev(40, "third")];
    const shuffled = [forward[2], forward[0], forward[1]] as UserPromptRow[];
    const pick = (rows: UserPromptRow[]) =>
      correlateDecisions([dec(30)], rows).pairings[0]?.promptEventId;
    expect(pick(shuffled)).toBe(pick(forward));
  });
});

describe("correlateDecisions — which bucket the matched prompt falls in", () => {
  test("labels the matched prompt corpus, steer, sub-agent or unusable", () => {
    // The rule names the nearest recorded user row, whatever it is. A decision that lands on a
    // steer message or a sub-agent brief is NOT evidence about the corpus, and saying so is the
    // difference between a measured heuristic and a join pretending to be exact.
    const prompts = [
      ev(10, "fix the parser"),
      ev(20, "⛔ You are ending the turn, but the plan is not done — 1 step(s)"),
      ev(30, "research sprite rendering", { agent_id: "child-1" }),
      ev(40, null),
    ];
    const { pairings } = correlateDecisions([dec(11), dec(21), dec(31), dec(41)], prompts);
    expect(pairings.map((p) => p.promptBucket)).toEqual([
      "corpus",
      "steer",
      "subagent",
      "unusable",
    ]);
  });
});

describe("corroborate — the display label as an independent signal", () => {
  test("corroborates when the label is a leading substring of the correlated prompt", () => {
    expect(corroborate("fix the parser", "fix the parser and add a test")).toBe("corroborated");
  });

  test("corroborates a 40-char truncation with its ellipsis stripped", () => {
    // The shipped label is `clean.slice(0, 40) + "…"`. Comparing the ellipsis as content would
    // fail every long prompt and report ~0% corroboration.
    const prompt = "a".repeat(50);
    const label = `${"a".repeat(40)}…`;
    expect(corroborate(label, prompt)).toBe("corroborated");
  });

  test("corroborates across the whitespace collapse the label maker applies", () => {
    // shortLabel does `text.replace(/\s+/g, " ").trim()` before truncating, so a prompt with a
    // newline in its first 40 chars is not a mis-pairing — it is the label maker's own transform.
    expect(corroborate("fix the parser then run", "fix the parser\n\nthen run the suite")).toBe(
      "corroborated",
    );
  });

  test("fails corroboration when the prompt was rewritten before dispatch", () => {
    expect(corroborate("fix the parser", "[replan] fix the parser")).toBe("uncorroborated");
  });

  test("reports a missing or empty label as unassessable, never as a failure", () => {
    expect(corroborate(null, "fix the parser")).toBe("unassessable");
    expect(corroborate("   ", "fix the parser")).toBe("unassessable");
  });

  test("reports a prompt row with no text as unassessable, not as a failure", () => {
    // Nothing to compare is not a failed comparison. Counting it as one would inflate the
    // uncorroborated tally with non-observations.
    expect(corroborate("fix the parser", null)).toBe("unassessable");
  });
});

describe("groupByCorpusEntry", () => {
  test("groups every decision one prompt drove under a single corpus entry", () => {
    // The recovery ladder re-decides per rung, so one prompt yields several decisions. Counting
    // them as separate observations would inflate the classifier's support by the retry rate.
    const prompts = [ev(10, "fix the parser")];
    const { pairings } = correlateDecisions([dec(11), dec(12), dec(13)], prompts);
    const entries = groupByCorpusEntry(pairings);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.recIds).toEqual(["d11", "d12", "d13"]);
  });

  test("folds the same prompt text recorded in different runs into one entry", () => {
    const prompts = [ev(10, "run the suite"), ev(10, "run the suite", { run_id: "r2", id: "e-b" })];
    const decisions = [dec(11), dec(11, { rec_id: "d-b", run_id: "r2" })];
    const entries = groupByCorpusEntry(correlateDecisions(decisions, prompts).pairings);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.recIds).toEqual(["d11", "d-b"]);
  });

  test("excludes pairings that did not land on a corpus prompt", () => {
    const prompts = [ev(10, "brief", { agent_id: "child-1" }), ev(20, "fix the parser")];
    const entries = groupByCorpusEntry(correlateDecisions([dec(11), dec(21)], prompts).pairings);
    expect(entries.map((e) => e.recIds)).toEqual([["d21"]]);
  });
});

describe("buildCorrelationReport", () => {
  const cfg = { scope: "test" };

  test("reports correlated and uncorrelated counts against the service-routed denominator", () => {
    const prompts = [ev(10, "fix the parser")];
    const decisions = [dec(5), dec(11), dec(12), dec(13, { routed: "offline" })];
    const r = buildCorrelationReport(decisions, prompts, cfg);
    expect(r.decisionsRead).toBe(4);
    expect(r.serviceRouted).toBe(3);
    expect(r.notServiceRouted).toEqual({ n: 1, d: 4, pct: 25 });
    expect(r.correlated).toEqual({ n: 2, d: 3, pct: 66.7 });
    expect(r.uncorrelatedRecIds).toEqual(["d5"]);
    expect(r.uncorrelatedBeforeReadWindow).toBe(1);
    expect(r.uncorrelatedNoEarlierPrompt).toBe(0);
  });

  test("computes the corroboration rate over pairings that carry a label", () => {
    // A decision with no stored label cannot corroborate or fail to — it belongs in neither the
    // numerator nor the denominator.
    const prompts = [ev(10, "fix the parser")];
    const decisions = [
      dec(11, { task_label: "fix the parser" }),
      dec(12, { task_label: "something else entirely" }),
      dec(13, { task_label: null }),
    ];
    const r = buildCorrelationReport(decisions, prompts, cfg);
    expect(r.corroborated).toEqual({ n: 1, d: 2, pct: 50 });
    expect(r.uncorroborated).toBe(1);
    expect(r.corroborationUnassessable).toBe(1);
  });

  test("counts prompts driving more than one decision, and the entries they group into", () => {
    const prompts = [ev(10, "fix the parser"), ev(20, "run the suite")];
    const decisions = [dec(11), dec(12), dec(21)];
    const r = buildCorrelationReport(decisions, prompts, cfg);
    expect(r.promptEventsWithMultipleDecisions).toEqual({ n: 1, d: 2, pct: 50 });
    expect(r.maxDecisionsPerPromptEvent).toBe(2);
    expect(r.corpusEntries).toBe(2);
    expect(r.corpusEntryDecisions).toBe(3);
  });

  test("separates an entry's ladder depth from the same text being asked again", () => {
    // One text asked in two runs, two decisions each. Four decisions under one entry is NOT a
    // four-rung ladder, and a reader must be able to tell those apart from the readout alone.
    const prompts = [ev(10, "run the suite"), ev(10, "run the suite", { run_id: "r2", id: "e-b" })];
    const decisions = [
      dec(11),
      dec(12),
      dec(11, { rec_id: "d-b1", run_id: "r2" }),
      dec(12, { rec_id: "d-b2", run_id: "r2" }),
    ];
    const r = buildCorrelationReport(decisions, prompts, cfg);
    expect(r.corpusEntries).toBe(1);
    expect(r.maxDecisionsPerCorpusEntry).toBe(4);
    expect(r.maxAskingsPerCorpusEntry).toBe(2);
    expect(r.maxDecisionsPerPromptEvent).toBe(2);
  });

  test("counts a sub-agent's decision attributed to a corpus prompt as the defect it is", () => {
    // The rule has no agent term, so it CAN pair a sub-agent's decision to a lead prompt. The
    // classifier only ever labels lead turns, so that pairing is false evidence about it.
    const r = buildCorrelationReport(
      [dec(11, { agent_id: "child-1" }), dec(12)],
      [ev(10, "fix the parser")],
      cfg,
    );
    expect(r.subagentDecisionsOnCorpusPrompt).toBe(1);
  });

  test("reports the bucket every pairing landed in, each with the pairing denominator", () => {
    const prompts = [ev(10, "fix the parser"), ev(20, "brief", { agent_id: "child-1" })];
    const r = buildCorrelationReport([dec(11), dec(21)], prompts, cfg);
    const shares = new Map(r.buckets.map((b) => [b.bucket, b.share]));
    expect(shares.get("corpus")).toEqual({ n: 1, d: 2, pct: 50 });
    expect(shares.get("subagent")).toEqual({ n: 1, d: 2, pct: 50 });
    expect(shares.get("steer")).toEqual({ n: 0, d: 2, pct: 0 });
  });

  test("is total over an empty ledger: no NaN, no division by zero", () => {
    const r = buildCorrelationReport([], [], cfg);
    expect(r.correlated).toEqual({ n: 0, d: 0, pct: null });
    expect(r.corroborated.pct).toBeNull();
    expect(r.corpusEntries).toBe(0);
  });

  test("flags a truncated read rather than reporting a slice as the whole ledger", () => {
    const r = buildCorrelationReport([dec(1), dec(2)], [], { scope: "test", rowCap: 2 });
    expect(r.capHit).toBe(true);
  });
});

describe("renderCorrelationReport", () => {
  const prompts = [ev(10, "SENTINEL-PROMPT-TEXT-do-not-print")];
  const report = buildCorrelationReport(
    [dec(11, { task_label: "SENTINEL-PROMPT-TEXT-do-not-print" })],
    prompts,
    { scope: "test" },
  );

  test("never prints prompt text or a display label", () => {
    // The corpus is one developer's own traffic. The readout is counts and denominators only, so
    // it can be pasted into a ticket without leaking what was asked.
    expect(renderCorrelationReport(report)).not.toContain("SENTINEL-PROMPT-TEXT");
  });

  test("states that the correlation is a heuristic and not a key", () => {
    expect(renderCorrelationReport(report).toLowerCase()).toContain("heuristic");
  });

  test("states that a rewritten prompt fails corroboration without being mis-paired", () => {
    expect(renderCorrelationReport(report).toLowerCase()).toContain("rewritten");
  });

  test("quotes every rate with its denominator", () => {
    const text = renderCorrelationReport(report);
    for (const line of text.split("\n")) {
      if (line.includes("%)")) expect(line).toMatch(/\d+\/\d+ \(/);
    }
  });
});

describe("decideInvocation — the correlate mode", () => {
  test("recognises --correlate and carries the read's scope", () => {
    const inv = decideInvocation(["--correlate", "--project=minima", "--limit=50"]);
    expect(inv).toEqual({
      kind: "correlate",
      project: "minima",
      dbPath: null,
      rowCap: 50,
    });
  });

  test("still refuses --spend ahead of it, so the pair cannot be read as permission", () => {
    expect(decideInvocation(["--correlate", "--spend"])).toMatchObject({
      kind: "refuse-spend",
      reason: "missing-ceiling",
    });
  });

  test("a read-only mode is not a way around the ceiling, in either direction", () => {
    // Both flags in one argv is answered by the spend branch, whichever way it goes: a stated
    // ceiling still decides `spend` (--correlate cannot suppress the guard's answer), and no
    // ceiling still refuses (--correlate cannot supply the affirmative it never stated).
    expect(decideInvocation(["--correlate", "--spend", "--max-usd=0.05"]).kind).toBe("spend");
    expect(decideInvocation(["--correlate", "--max-usd=0.05"]).kind).toBe("correlate");
  });
});

describe("MinimaDb.listRoutingDecisions", () => {
  function ledger(): MinimaDb {
    const db = new MinimaDb(":memory:");
    db.ensureProject("proj-a");
    db.ensureProject("proj-b");
    db.startRun({ runId: "run-a", projectKey: "proj-a" });
    db.startRun({ runId: "run-b", projectKey: "proj-b" });
    return db;
  }

  function write(db: MinimaDb, over: Partial<DecisionWrite> & { recId: string; runId: string }) {
    db.writeDecision({
      taskLabel: "a label",
      chosenModel: "faux/one",
      decisionBasis: "test",
      confidence: 0.5,
      thresholdUsed: 0.5,
      ranked: [],
      estCostUsd: 0,
      actualCostUsd: 0,
      quality: null,
      judged: false,
      outcome: "success",
      turns: 1,
      latencyMs: 1,
      ...over,
    });
  }

  test("carries the columns the correlation reads, including offline and pinned rows", () => {
    const db = ledger();
    write(db, { recId: "d1", runId: "run-a", agentId: "child-1" });
    write(db, { recId: "d2", runId: "run-a", routed: "pinned", taskLabel: "pinned label" });
    const rows = db.listRoutingDecisions();
    expect(rows.map((r) => [r.rec_id, r.agent_id, r.routed, r.task_label])).toEqual([
      ["d1", "child-1", "server", "a label"],
      ["d2", null, "pinned", "pinned label"],
    ]);
    expect(typeof rows[0]?.ts).toBe("number");
    db.close();
  });

  test("carries all four task-type columns, so a reader cannot mistake one for another", () => {
    // `task_type` is the service's FINAL label and is what an override would have replaced;
    // `client_task_type` is the harness classifier's own; `heuristic_task_type` is the server's
    // legacy regex opinion, reported even when something else won. Selecting one and calling it
    // "the task type" is how a readout measures a different thing than its heading claims, so the
    // read carries all of them and the caller picks deliberately.
    const db = ledger();
    write(db, {
      recId: "d1",
      runId: "run-a",
      taskType: "code",
      clientTaskType: "qa",
      clientConfidence: 0.81,
      heuristicTaskType: "other",
      classifyDisagreement: 1,
    });
    write(db, { recId: "d2", runId: "run-a" });
    const [full, bare] = db.listRoutingDecisions();
    expect(full).toMatchObject({
      task_type: "code",
      client_task_type: "qa",
      client_confidence: 0.81,
      heuristic_task_type: "other",
      classify_disagreement: 1,
    });
    // A row the telemetry never reached carries nulls, not absent keys: "the classifier did not
    // run" has to be countable, and this ledger's own history is entirely that case.
    expect(bare).toMatchObject({
      task_type: null,
      client_task_type: null,
      client_confidence: null,
      heuristic_task_type: null,
      classify_disagreement: null,
    });
    db.close();
  });

  test("scopes to one project's runs when asked, and spans the ledger when not", () => {
    const db = ledger();
    write(db, { recId: "in-a", runId: "run-a" });
    write(db, { recId: "in-b", runId: "run-b" });
    expect(db.listRoutingDecisions("proj-a").map((r) => r.rec_id)).toEqual(["in-a"]);
    expect(db.listRoutingDecisions(null).map((r) => r.rec_id)).toEqual(["in-a", "in-b"]);
    db.close();
  });

  test("a row cap keeps the NEWEST rows and still returns them oldest-first", () => {
    const db = ledger();
    write(db, { recId: "oldest", runId: "run-a" });
    write(db, { recId: "middle", runId: "run-a" });
    write(db, { recId: "newest", runId: "run-a" });
    expect(db.listRoutingDecisions(null, 2).map((r) => r.rec_id)).toEqual(["middle", "newest"]);
    db.close();
  });
});
