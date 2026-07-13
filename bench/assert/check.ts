/** Assertion collector: gathers named checks, prints a per-flow report, computes PASS/FAIL. */

export interface CheckResult {
  name: string;
  ok: boolean;
  soft: boolean;
  detail?: string;
}

export class Checks {
  results: CheckResult[] = [];
  constructor(readonly flowId: string) {}

  check(name: string, ok: boolean, detail?: string): boolean {
    this.results.push({ name, ok, soft: false, detail });
    console.log(`  ${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
    return ok;
  }

  /** Recorded but never gates the flow (nondeterministic/live-dependent signals). */
  soft(name: string, ok: boolean, detail?: string): boolean {
    this.results.push({ name, ok, soft: true, detail });
    console.log(`  ${ok ? "✓" : "~"} [soft] ${name}${!ok && detail ? ` — ${detail}` : ""}`);
    return ok;
  }

  get passed(): boolean {
    return this.results.filter((r) => !r.soft).every((r) => r.ok);
  }

  summary(): string {
    const hard = this.results.filter((r) => !r.soft);
    const soft = this.results.filter((r) => r.soft);
    const failedHard = hard.filter((r) => !r.ok);
    return (
      `${this.flowId}: ${this.passed ? "PASS" : "FAIL"} — ${hard.length - failedHard.length}/${hard.length} checks` +
      (soft.length ? ` (+${soft.filter((r) => r.ok).length}/${soft.length} soft)` : "") +
      (failedHard.length ? `\n  failed: ${failedHard.map((r) => r.name).join(", ")}` : "")
    );
  }
}
