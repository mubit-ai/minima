import { describe, expect, test } from "bun:test";
import { confidence } from "../src/minima/confidence.ts";
import type { Factors } from "../src/minima/gt_contract.ts";

const GREEN: Factors = {
  pass: true,
  redToGreen: true,
  hasCheck: true,
  checkOrigin: "pre_existing",
  coverageHit: true,
  tamper: false,
};

describe("confidence", () => {
  test("tampering is red and takes precedence over every other factor", () => {
    expect(confidence({ ...GREEN, pass: false, hasCheck: false, tamper: true })).toEqual({
      tier: "red",
      reason: "tests weakened",
    });
  });

  test("a failed or unrunnable check is red", () => {
    expect(confidence({ ...GREEN, pass: false })).toEqual({
      tier: "red",
      reason: "check did not pass",
    });
  });

  test("a writing step without a check is yellow", () => {
    expect(confidence({ ...GREEN, pass: false, hasCheck: false })).toEqual({
      tier: "yellow",
      reason: "no acceptance check",
    });
  });

  test("a trusted pre-existing check with complete evidence is green", () => {
    expect(confidence(GREEN)).toEqual({ tier: "green", reason: "trusted check passed" });
  });

  test("a user-supplied check with complete evidence is green", () => {
    expect(confidence({ ...GREEN, checkOrigin: "user" })).toEqual({
      tier: "green",
      reason: "trusted check passed",
    });
  });

  test("an agent-authored check is yellow", () => {
    expect(confidence({ ...GREEN, checkOrigin: "agent_new" })).toEqual({
      tier: "yellow",
      reason: "self-written test",
    });
  });

  test("a check without red-to-green evidence is yellow", () => {
    expect(confidence({ ...GREEN, redToGreen: false })).toEqual({
      tier: "yellow",
      reason: "no red→green evidence",
    });
  });

  test("a check without a coverage hit is yellow", () => {
    expect(confidence({ ...GREEN, coverageHit: false })).toEqual({
      tier: "yellow",
      reason: "check may not touch changes",
    });
  });

  test("unknown coverage is conservatively yellow", () => {
    expect(confidence({ ...GREEN, coverageHit: "unknown" })).toEqual({
      tier: "yellow",
      reason: "check may not touch changes",
    });
  });

  // A5 fabrication floor — agent_new AND coverageHit===false forces 🔴.
  test("a self-written test that provably misses the change is red (fabrication floor)", () => {
    expect(confidence({ ...GREEN, checkOrigin: "agent_new", coverageHit: false })).toEqual({
      tier: "red",
      reason: "unverified self-test",
    });
  });

  test("a self-written test with unknown coverage stays yellow (not fabrication)", () => {
    expect(confidence({ ...GREEN, checkOrigin: "agent_new", coverageHit: "unknown" })).toEqual({
      tier: "yellow",
      reason: "check may not touch changes",
    });
  });

  test("a pre-existing test that misses the change stays yellow (floor needs agent_new)", () => {
    expect(confidence({ ...GREEN, checkOrigin: "pre_existing", coverageHit: false })).toEqual({
      tier: "yellow",
      reason: "check may not touch changes",
    });
  });

  test("blind evidence caps the fabrication floor at yellow (incomplete coverage read)", () => {
    expect(
      confidence({ ...GREEN, checkOrigin: "agent_new", coverageHit: false, blind: true }),
    ).toEqual({
      tier: "yellow",
      reason: "unattributed writes this run",
    });
  });

  test("tamper still outranks the fabrication floor", () => {
    expect(
      confidence({ ...GREEN, checkOrigin: "agent_new", coverageHit: false, tamper: true }),
    ).toEqual({
      tier: "red",
      reason: "tests weakened",
    });
  });

  test("a failed check still outranks the fabrication floor", () => {
    expect(
      confidence({ ...GREEN, checkOrigin: "agent_new", coverageHit: false, pass: false }),
    ).toEqual({
      tier: "red",
      reason: "check did not pass",
    });
  });
});
