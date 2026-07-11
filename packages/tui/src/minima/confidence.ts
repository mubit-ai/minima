import type { ConfidenceVerdict, Factors } from "./gt_contract.ts";

export function confidence(factors: Factors): ConfidenceVerdict {
  if (factors.tamper) return { tier: "red", reason: "tests weakened" };
  if (!factors.hasCheck) return { tier: "yellow", reason: "no acceptance check" };
  if (!factors.pass) return { tier: "red", reason: "check did not pass" };
  if (factors.blind) return { tier: "yellow", reason: "unattributed writes this run" };
  if (!factors.redToGreen) return { tier: "yellow", reason: "no red→green evidence" };
  if (factors.coverageHit !== true) {
    return { tier: "yellow", reason: "check may not touch changes" };
  }
  if (factors.checkOrigin === "agent_new") {
    return { tier: "yellow", reason: "self-written test" };
  }
  return { tier: "green", reason: "trusted check passed" };
}
