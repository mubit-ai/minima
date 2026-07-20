import type { ConfidenceVerdict, Factors } from "./gt_contract.ts";

export function confidence(factors: Factors): ConfidenceVerdict {
  if (factors.tamper) return { tier: "red", reason: "tests weakened" };
  if (!factors.hasCheck) return { tier: "yellow", reason: "no acceptance check" };
  if (!factors.pass) return { tier: "red", reason: "check did not pass" };
  if (factors.blind) return { tier: "yellow", reason: "unattributed writes this run" };
  // A5 fabrication floor: a test the agent wrote THIS run (agent_new) that provably does NOT
  // exercise the changed source (coverageHit === false, not "unknown") is a passing check that
  // tests nothing about the change — de-facto fabricated evidence, so it joins tamper as a hard
  // 🔴 rather than gliding as a 🟡 self-written test. Placed AFTER `blind`: when writes are
  // unattributable the coverage read is knowably incomplete, so `false` may be a false negative —
  // incomplete evidence degrades to 🟡 (signal lost, never fabricated), never escalates to 🔴.
  // `coverageHit === "unknown"` (nothing to correlate) is NOT fabrication and stays 🟡 below.
  if (factors.checkOrigin === "agent_new" && factors.coverageHit === false) {
    return { tier: "red", reason: "unverified self-test" };
  }
  if (!factors.redToGreen) return { tier: "yellow", reason: "no red→green evidence" };
  if (factors.coverageHit !== true) {
    return { tier: "yellow", reason: "check may not touch changes" };
  }
  if (factors.checkOrigin === "agent_new") {
    return { tier: "yellow", reason: "self-written test" };
  }
  return { tier: "green", reason: "trusted check passed" };
}
