import { describe, expect, test } from "bun:test";

import {
  BIG_PLAN_SYSTEM_GUIDANCE,
  GROUND_TRUTH_SYSTEM_GUIDANCE,
  bigPlanAfterToolCall,
  bigPlanAttributionSink,
  bigPlanHooks,
  groundTruthAfterToolCall,
  groundTruthAttributionSink,
  groundTruthHooks,
  groundedOutcomeFor,
  stampGroundedOutcome,
  stampVerifiedOutcome,
  verifiedOutcomeFor,
} from "../src/minima/big_plan.ts";
import { synthesizeBigPlan, synthesizeGroundTruth } from "../src/minima/plan_council.ts";
import { PlanSessionStore, type GroundTruthSynthesis } from "../src/minima/plan_session.ts";

describe("Big Plan one-release API compatibility", () => {
  test("deprecated exported values delegate to canonical implementations", () => {
    expect(GROUND_TRUTH_SYSTEM_GUIDANCE).toBe(BIG_PLAN_SYSTEM_GUIDANCE);
    expect(groundTruthAttributionSink).toBe(bigPlanAttributionSink);
    expect(groundTruthAfterToolCall).toBe(bigPlanAfterToolCall);
    expect(groundTruthHooks).toBe(bigPlanHooks);
    expect(groundedOutcomeFor).toBe(verifiedOutcomeFor);
    expect(stampGroundedOutcome).toBe(stampVerifiedOutcome);
    expect(synthesizeGroundTruth).toBe(synthesizeBigPlan);
  });

  test("deprecated synthesis type and renderer remain usable", () => {
    const synthesis: GroundTruthSynthesis | null = null;
    const store = new PlanSessionStore("compatibility");
    expect(store.toGroundTruth(synthesis)).toBe(store.toBigPlan(synthesis));
  });
});
