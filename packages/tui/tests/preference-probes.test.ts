/**
 * Preference probes (tuner): every trigger gate individually, bounded hill-climb step
 * math (clamped at both ends), direction memory (flip after a kept-current probe, keep
 * climbing after an accepted one), and the audit trail (probe event on EVERY probe
 * shown; slider change only on acceptance, source='tuner'). Hermetic: in-memory DB +
 * a mocked askUser dep — no network, no TUI, no spend.
 */

import { describe, expect, test } from "bun:test";
import { type DecisionWrite, MinimaDb, type ProfileEventRow } from "../src/db/minima_db.ts";
import { configFromEnv } from "../src/minima/config.ts";
import {
  TUNER_COOLDOWN_SECONDS,
  TUNER_MIN_RECONCILED_DECISIONS,
  boundedCandidate,
  createPreferenceProbe,
  probeDirection,
  projectTradeoffStats,
} from "../src/minima/preference_probe.ts";
import type { AskUserRef, QuestionParams } from "../src/tools/question.ts";

const PROJECT = "github.com/test/tuner-repo";
const NOW = 1_800_000_000;
const DAY = 24 * 60 * 60;

let recSeq = 0;

function fixture(): { db: MinimaDb; runId: string } {
  const db = new MinimaDb(":memory:");
  db.ensureProject(PROJECT);
  const runId = db.startRun({ projectKey: PROJECT });
  return { db, runId };
}

function writeDecision(db: MinimaDb, runId: string, over: Partial<DecisionWrite> = {}): string {
  const recId = over.recId ?? `rec-${++recSeq}`;
  db.writeDecision({
    recId,
    runId,
    taskLabel: "task",
    taskType: "code",
    chosenModel: "claude-x",
    decisionBasis: "memory",
    confidence: 0.8,
    thresholdUsed: 0.5,
    ranked: [],
    estCostUsd: 0.001,
    actualCostUsd: 0.001,
    quality: null,
    judged: false,
    outcome: "success",
    turns: 1,
    latencyMs: 10,
    ...over,
  });
  return recId;
}

function label(
  db: MinimaDb,
  recId: string,
  tier: "green" | "yellow" | "red",
  verifiedBy: "deterministic" | "judge" | "user" = "deterministic",
): void {
  db.insertGate({
    recId,
    outcome: tier === "red" ? "failed" : "verified",
    confidence: tier,
    verifiedBy,
  });
}

/** n reconciled decisions; each gate-labeled with `tier` unless tier is null. */
function seedDecisions(
  db: MinimaDb,
  runId: string,
  n: number,
  opts: { tier?: "green" | "yellow" | "red" | null; costs?: number[] } = {},
): string[] {
  const recIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const recId = writeDecision(db, runId, { actualCostUsd: opts.costs?.[i] ?? 0.001 });
    if (opts.tier !== null) label(db, recId, opts.tier ?? "green");
    recIds.push(recId);
  }
  return recIds;
}

function asker(answer: string | null | ((p: QuestionParams) => string | null)): {
  ref: AskUserRef;
  calls: QuestionParams[];
} {
  const calls: QuestionParams[] = [];
  const ref: AskUserRef = {
    current: async (p) => {
      calls.push(p);
      return typeof answer === "function" ? answer(p) : answer;
    },
  };
  return { ref, calls };
}

function probeFor(
  db: MinimaDb,
  askRef: AskUserRef,
  over: { tuner?: boolean; defaultSlider?: number; now?: () => number } = {},
): () => Promise<import("../src/minima/preference_probe.ts").ProbeResult> {
  return createPreferenceProbe({
    db,
    projectKey: PROJECT,
    tuner: over.tuner ?? true,
    defaultSlider: over.defaultSlider ?? 5,
    askUser: askRef,
    now: over.now ?? (() => NOW),
  });
}

const probeEvents = (db: MinimaDb): ProfileEventRow[] =>
  db.listProfileEvents(PROJECT).filter((e) => e.field === "probe");

const tunerSliderEvents = (db: MinimaDb): ProfileEventRow[] =>
  db.listProfileEvents(PROJECT).filter((e) => e.field === "slider" && e.source === "tuner");

const changes = (db: MinimaDb): number =>
  (db.db.query("SELECT total_changes() AS c").get() as { c: number }).c;

/** A probe-ready fixture: profile row + enough green reconciled decisions. */
function ready(slider: number | null = 5): { db: MinimaDb; runId: string } {
  const { db, runId } = fixture();
  db.upsertRoutingProfile(PROJECT, slider === null ? { minQuality: 0.5 } : { slider }, "user");
  seedDecisions(db, runId, TUNER_MIN_RECONCILED_DECISIONS, { tier: "green" });
  return { db, runId };
}

describe("config flag", () => {
  test("MINIMA_TUI_TUNER === '1' opts in; anything else (or unset) stays off", () => {
    const saved = process.env.MINIMA_TUI_TUNER;
    try {
      delete process.env.MINIMA_TUI_TUNER;
      expect(configFromEnv().tuner).toBe(false);
      process.env.MINIMA_TUI_TUNER = "1";
      expect(configFromEnv().tuner).toBe(true);
      process.env.MINIMA_TUI_TUNER = "0";
      expect(configFromEnv().tuner).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.MINIMA_TUI_TUNER;
      else process.env.MINIMA_TUI_TUNER = saved;
    }
  });
});

describe("trigger gates (each fails open and silent)", () => {
  test("flag off ⇒ provably nothing: no overlay, no writes, no probe event", async () => {
    const { db } = ready();
    const { ref, calls } = asker(null);
    const before = changes(db);
    const result = await probeFor(db, ref, { tuner: false })();
    expect(result).toEqual({ probed: false, reason: "flag_off" });
    expect(calls).toHaveLength(0);
    expect(changes(db)).toBe(before);
    expect(probeEvents(db)).toHaveLength(0);
  });

  test("no routing_profiles row ⇒ no probe", async () => {
    const { db, runId } = fixture();
    seedDecisions(db, runId, TUNER_MIN_RECONCILED_DECISIONS, { tier: "green" });
    const { ref, calls } = asker(null);
    const result = await probeFor(db, ref)();
    expect(result).toEqual({ probed: false, reason: "no_profile" });
    expect(calls).toHaveLength(0);
    expect(probeEvents(db)).toHaveLength(0);
  });

  test("fewer than the reconciled-decision floor ⇒ no probe; NULL outcomes never count", async () => {
    const { db, runId } = fixture();
    db.upsertRoutingProfile(PROJECT, { slider: 5 }, "user");
    const recIds = seedDecisions(db, runId, TUNER_MIN_RECONCILED_DECISIONS, { tier: "green" });
    db.db.run("UPDATE routing_decisions SET outcome = NULL WHERE rec_id = ?", [recIds[0]!]);
    const { ref, calls } = asker(null);
    expect(await probeFor(db, ref)()).toEqual({
      probed: false,
      reason: "insufficient_decisions",
    });
    expect(calls).toHaveLength(0);
    db.db.run("UPDATE routing_decisions SET outcome = 'success' WHERE rec_id = ?", [recIds[0]!]);
    const second = await probeFor(db, ref)();
    expect(second.probed).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("session latch: at most one probe per runner, even across multiple plan closes", async () => {
    const { db } = ready();
    const { ref, calls } = asker(null);
    const probe = probeFor(db, ref);
    const first = await probe();
    expect(first.probed).toBe(true);
    // Cooldown would also block a rerun — hold the clock still so ONLY the latch decides.
    const second = await probe();
    expect(second).toEqual({ probed: false, reason: "session_latch" });
    expect(calls).toHaveLength(1);
    expect(probeEvents(db)).toHaveLength(1);
  });

  test("7-day cooldown honored from a seeded probe event; an expired one clears it", async () => {
    const { db } = ready();
    db.insertProfileEvent(PROJECT, "tuner", "probe", "3.5", "5", NOW - 3 * DAY);
    const { ref, calls } = asker(null);
    expect(await probeFor(db, ref)()).toEqual({ probed: false, reason: "cooldown" });
    expect(calls).toHaveLength(0);
    expect(probeEvents(db)).toHaveLength(1);

    const aged = ready();
    aged.db.insertProfileEvent(PROJECT, "tuner", "probe", "3.5", "5", NOW - 8 * DAY);
    const again = asker(null);
    const result = await probeFor(aged.db, again.ref)();
    expect(result.probed).toBe(true);
    expect(again.calls).toHaveLength(1);
    expect(TUNER_COOLDOWN_SECONDS).toBe(7 * DAY);
  });

  test("no overlay (headless askUser null) ⇒ no probe, no probe event, latch NOT spent", async () => {
    const { db } = ready();
    const ref: AskUserRef = { current: null };
    const probe = probeFor(db, ref);
    expect(await probe()).toEqual({ probed: false, reason: "no_overlay" });
    expect(probeEvents(db)).toHaveLength(0);
    const { ref: live, calls } = asker(null);
    ref.current = live.current;
    const result = await probe();
    expect(result.probed).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("bounded step math", () => {
  test("one step of ±1.5 from mid-range", () => {
    expect(boundedCandidate(5, -1)).toBe(3.5);
    expect(boundedCandidate(5, 1)).toBe(6.5);
  });

  test("clamps at both ends", () => {
    expect(boundedCandidate(7.5, 1)).toBe(8);
    expect(boundedCandidate(3, -1)).toBe(2);
    expect(boundedCandidate(2.5, -1)).toBe(2);
  });

  test("a step the clamp collapses flips to the other direction", () => {
    expect(boundedCandidate(8, 1)).toBe(6.5);
    expect(boundedCandidate(2, -1)).toBe(3.5);
  });
});

describe("direction choice (hill-climb memory)", () => {
  const ev = (oldV: string | null, newV: string | null) => ({
    old_value: oldV,
    new_value: newV,
  });

  test("first probe: cheaper when green rate ≥ 0.8, else quality", () => {
    expect(probeDirection(null, null, 0.9)).toBe(-1);
    expect(probeDirection(null, null, 0.8)).toBe(-1);
    expect(probeDirection(null, null, 0.5)).toBe(1);
  });

  test("kept current last time ⇒ flip away from the rejected offer", () => {
    // Offered quality (6.5), user kept 5 ⇒ next probe leans cheap.
    expect(probeDirection(ev("6.5", "5"), null, 0)).toBe(-1);
    // Offered cheap (3.5), user kept 5 ⇒ next probe leans quality.
    expect(probeDirection(ev("3.5", "5"), null, 1)).toBe(1);
  });

  test("accepted last time ⇒ keep climbing the accepted direction", () => {
    expect(probeDirection(ev("6.5", "6.5"), ev("5", "6.5"), 1)).toBe(1);
    expect(probeDirection(ev("3.5", "3.5"), ev("5", "3.5"), 0)).toBe(-1);
    // No tuner slider event to read the direction from ⇒ first-probe default.
    expect(probeDirection(ev("6.5", "6.5"), null, 0.9)).toBe(-1);
  });

  test("unreadable probe history falls back to the first-probe default", () => {
    expect(probeDirection(ev(null, "5"), null, 0.9)).toBe(-1);
    expect(probeDirection(ev("junk", "5"), null, 0.4)).toBe(1);
  });
});

describe("answer paths (audit trail)", () => {
  test("candidate accepted ⇒ slider change with source='tuner' + probe event", async () => {
    const { db } = ready(5); // all-green fixture ⇒ cheaper direction ⇒ candidate 3.5
    const { ref, calls } = asker((p) => p.options[1]!.label);
    const result = await probeFor(db, ref)();
    expect(result).toEqual({ probed: true, accepted: true, current: 5, candidate: 3.5 });
    expect(db.getRoutingProfile(PROJECT)?.slider).toBe(3.5);
    expect(db.getRoutingProfile(PROJECT)?.source).toBe("tuner");
    const sliders = tunerSliderEvents(db);
    expect(sliders).toHaveLength(1);
    expect(sliders[0]?.old_value).toBe("5");
    expect(sliders[0]?.new_value).toBe("3.5");
    const probes = probeEvents(db);
    expect(probes).toHaveLength(1);
    expect(probes[0]?.old_value).toBe("3.5"); // the offered candidate
    expect(probes[0]?.new_value).toBe("3.5"); // the chosen option
    expect(probes[0]?.source).toBe("tuner");
    expect(calls[0]?.options.map((o) => o.label)).toEqual(["keep slider 5", "try slider 3.5"]);
  });

  test("keep current ⇒ probe event only, no slider change", async () => {
    const { db } = ready(5);
    const { ref } = asker((p) => p.options[0]!.label);
    const result = await probeFor(db, ref)();
    expect(result).toEqual({ probed: true, accepted: false, current: 5, candidate: 3.5 });
    expect(db.getRoutingProfile(PROJECT)?.slider).toBe(5);
    expect(db.getRoutingProfile(PROJECT)?.source).toBe("user");
    expect(tunerSliderEvents(db)).toHaveLength(0);
    const probes = probeEvents(db);
    expect(probes).toHaveLength(1);
    expect(probes[0]?.old_value).toBe("3.5");
    expect(probes[0]?.new_value).toBe("5");
  });

  test("dismiss (null) and free text both mean keep current — probe event still written", async () => {
    for (const answer of [null, "just make it good"] as const) {
      const { db } = ready(5);
      const { ref } = asker(answer);
      const result = await probeFor(db, ref)();
      expect(result).toEqual({ probed: true, accepted: false, current: 5, candidate: 3.5 });
      expect(db.getRoutingProfile(PROJECT)?.slider).toBe(5);
      expect(tunerSliderEvents(db)).toHaveLength(0);
      const probes = probeEvents(db);
      expect(probes).toHaveLength(1);
      expect(probes[0]?.new_value).toBe("5");
    }
  });

  test("a profile row without a slider probes from the config default", async () => {
    const { db } = ready(null);
    const { ref, calls } = asker(null);
    const result = await probeFor(db, ref, { defaultSlider: 5 })();
    expect(result).toEqual({ probed: true, accepted: false, current: 5, candidate: 3.5 });
    expect(calls[0]?.options[0]?.label).toBe("keep slider 5");
  });

  test("kept-current probe flips the NEXT session's direction; one bounded step, never chained", async () => {
    const { db } = ready(5);
    const keep = asker((p) => p.options[0]!.label);
    const session1 = probeFor(db, keep.ref);
    const first = await session1(); // all-green ⇒ offered 3.5, kept 5
    expect(first).toEqual({ probed: true, accepted: false, current: 5, candidate: 3.5 });

    // Same session, second plan close: the latch holds — probes never chain.
    expect(await session1()).toEqual({ probed: false, reason: "session_latch" });
    const again = asker((p) => p.options[1]!.label);
    const nextSession = probeFor(db, again.ref, { now: () => NOW + 8 * DAY });
    const second = await nextSession();
    expect(second).toEqual({ probed: true, accepted: true, current: 5, candidate: 6.5 });
    expect(db.getRoutingProfile(PROJECT)?.slider).toBe(6.5);

    // Third session: the accepted quality direction keeps climbing (6.5 + 1.5 → 8).
    const third = asker(null);
    const r3 = await probeFor(db, third.ref, { now: () => NOW + 16 * DAY })();
    expect(r3).toEqual({ probed: true, accepted: false, current: 6.5, candidate: 8 });
  });

  test("cooldown counts from a REAL prior probe regardless of its outcome", async () => {
    const { db } = ready(5);
    const { ref } = asker(null);
    await probeFor(db, ref)(); // writes the probe event at NOW
    const tomorrow = asker(null);
    const result = await probeFor(db, tomorrow.ref, { now: () => NOW + DAY })();
    expect(result).toEqual({ probed: false, reason: "cooldown" });
    expect(tomorrow.calls).toHaveLength(0);
  });
});

describe("projectTradeoffStats", () => {
  test("reconciled counts non-null outcomes; green rate and medians from labeled rows", () => {
    const { db, runId } = fixture();
    const greens = seedDecisions(db, runId, 3, { tier: "green", costs: [0.01, 0.02, 0.03] });
    seedDecisions(db, runId, 1, { tier: "red", costs: [0.4] });
    seedDecisions(db, runId, 2, { tier: null }); // reconciled but unlabeled
    db.db.run("UPDATE routing_decisions SET outcome = NULL WHERE rec_id = ?", [greens[0]!]);

    const stats = projectTradeoffStats(db, PROJECT);
    expect(stats.reconciled).toBe(5);
    expect(stats.labeled).toBe(4);
    expect(stats.greenRate).toBeCloseTo(3 / 4);
    expect(stats.medianCostUsd).toBeCloseTo(0.025);
    expect(stats.cheapHalfGreenRate).toBe(1); // [0.01, 0.02] both green
    expect(stats.priceyHalfGreenRate).toBeCloseTo(0.5); // [0.03 green, 0.4 red]
    expect(stats.cheapHalfMedianUsd).toBeCloseTo(0.015);
    expect(stats.priceyHalfMedianUsd).toBeCloseTo(0.215);
  });

  test("a judge-labeled green never counts as verified-green", () => {
    const { db, runId } = fixture();
    for (let i = 0; i < 3; i++) {
      const recId = writeDecision(db, runId);
      label(db, recId, "green", "judge");
    }
    expect(projectTradeoffStats(db, PROJECT).greenRate).toBe(0);
  });

  test("other projects never leak in", () => {
    const { db, runId } = fixture();
    seedDecisions(db, runId, 2, { tier: "green" });
    db.ensureProject("other");
    const otherRun = db.startRun({ projectKey: "other" });
    seedDecisions(db, otherRun, 6, { tier: "red" });
    const stats = projectTradeoffStats(db, PROJECT);
    expect(stats.reconciled).toBe(2);
    expect(stats.greenRate).toBe(1);
  });
});
