import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(packageRoot, "../..");
const sourceGlob = new Bun.Glob("{src,tests,scripts}/**/*.{ts,tsx,sh,py}");
const activeDocs = [
  "docs/BigPlan/README.md",
  "docs/BigPlan/characteristics-of-successful-plans.md",
  "docs/BigPlan/harness-research.md",
  "docs/BigPlan/inline-ux-guide.md",
  "docs/BigPlan/minima-harness-application-guide.md",
  "docs/BigPlan/playbook.md",
  "docs/BigPlan/sources.md",
  "docs/BigPlan/tui-manual-testing.md",
  "docs/BigPlan/workflow-diagrams.md",
  "docs/characteristics_of_a_good_plan.md",
] as const;

const allowed: Record<string, RegExp> = {
  "src/db/minima_db.ts": /^gt_(?:outcome|verified_by|confidence)$/,
  "src/db/rehydrate.ts": /^gt_outcome$/,
  "tests/db_migrate.test.ts": /^gt_(?:outcome|verified_by|confidence)$/,
};

const legacyPattern =
  /MINIMA_TUI_GROUND_TRUTH|\bGROUND_TRUTH\w*|\b(?:to|synthesize)?GroundTruth\w*|\bgroundTruth\w*|Ground[- _]Truth|ground[- _]truth|\bGT\b|\bGt[A-Z]\w*|\bgt_(?:outcome|verified_by|confidence)\b|\/gt(?:-seed)?\b/g;

// The feature is called just "plan" in prose/strings. Identifiers stay: camelCase bigPlan*,
// snake big_plan_*, MINIMA_TUI_BIG_PLAN, BigPlan.md, and lowercase file-name chains like
// big-plan-e2e — none contain the spaced phrase, and the lowercase hyphenated form is the
// file-name convention, so only the spaced variants and the capitalized hyphen form are banned.
const bigPlanPattern = /\b(?:[Bb]ig [Pp]lan|BIG PLAN|Big-Plan)\b/g;

const files: { relative: string; absolute: string; source: boolean }[] = [];
for await (const relative of sourceGlob.scan({ cwd: packageRoot })) {
  if (relative === "scripts/check-terminology.ts") continue;
  files.push({ relative, absolute: resolve(packageRoot, relative), source: true });
}
for (const relative of activeDocs)
  files.push({ relative, absolute: resolve(repoRoot, relative), source: false });

const violations: string[] = [];
for (const file of files) {
  const lines = readFileSync(file.absolute, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(legacyPattern)) {
      const value = match[0];
      if (!allowed[file.relative]?.test(value)) {
        violations.push(`${file.relative}:${index + 1}: ${value}`);
      }
    }
    if (file.source) {
      for (const match of line.matchAll(bigPlanPattern)) {
        violations.push(`${file.relative}:${index + 1}: ${match[0]}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error("Legacy plan-spine terminology found outside the compatibility allowlist:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log("plan terminology check passed");
