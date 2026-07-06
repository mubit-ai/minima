/**
 * Savings A/B report — the field-standard triple, never "% saved" alone:
 *   1. $ per completed task, routed vs premium, with % saved
 *   2. quality parity: pass rates + paired outcome table + McNemar exact p on
 *      discordant pairs
 *   3. routing distribution: which models the routed arm actually picked
 * Plus the server-counterfactual cross-check (sum of all_premium estimates vs the
 * measured premium arm — the IPS-style corroboration panel, always secondary).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TASKS_ROOT } from "./materialize.ts";

interface Row {
  task: string;
  arm: string;
  solved: boolean;
  cheated: boolean;
  cost_usd: number | null;
  chosen_model?: string | null;
  routed_kind?: string | null;
  est_premium_usd?: number | null;
  duration_ms: number;
}

const logPath = join(TASKS_ROOT, "savings_ab.jsonl");
if (!existsSync(logPath)) {
  console.error("no savings_ab.jsonl yet");
  process.exit(2);
}
const rows = readFileSync(logPath, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Row);

const byTask = new Map<string, Partial<Record<"premium" | "routed", Row>>>();
for (const r of rows) {
  const rec = byTask.get(r.task) ?? {};
  rec[r.arm as "premium" | "routed"] = r;
  byTask.set(r.task, rec);
}
const pairs = [...byTask.entries()].filter(([, r]) => r.premium && r.routed);
const ok = (r: Row | undefined) => !!r && r.solved && !r.cheated;

let both = 0;
let premiumOnly = 0;
let routedOnly = 0;
let neither = 0;
for (const [, r] of pairs) {
  const p = ok(r.premium);
  const q = ok(r.routed);
  if (p && q) both++;
  else if (p) premiumOnly++;
  else if (q) routedOnly++;
  else neither++;
}

function armStats(arm: "premium" | "routed") {
  const rs = pairs.map(([, r]) => r[arm]!);
  const solved = rs.filter(ok).length;
  const cost = rs.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  return { n: rs.length, solved, rate: solved / rs.length, cost, perCompleted: cost / Math.max(1, solved) };
}
const P = armStats("premium");
const R = armStats("routed");

// McNemar exact: two-sided binomial on discordant pairs.
function binom(n: number, k: number): number {
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return c;
}
const d = premiumOnly + routedOnly;
let mcnemarP = 1;
if (d > 0) {
  const k = Math.min(premiumOnly, routedOnly);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binom(d, i) * 0.5 ** d;
  mcnemarP = Math.min(1, 2 * tail);
}

console.log(`PAIRED SAVINGS A/B — ${pairs.length} tasks, both arms fresh-executed, hidden-test graded`);
console.log("=".repeat(76));
console.log(`1. COST   premium: $${P.cost.toFixed(2)} total, $${P.perCompleted.toFixed(4)}/completed`);
console.log(`          routed:  $${R.cost.toFixed(2)} total, $${R.perCompleted.toFixed(4)}/completed`);
console.log(`          SAVED:   ${(100 * (1 - R.cost / Math.max(1e-9, P.cost))).toFixed(1)}% of total spend` +
  ` · ${(100 * (1 - R.perCompleted / Math.max(1e-9, P.perCompleted))).toFixed(1)}% per completed task`);
console.log(`2. PARITY premium ${P.solved}/${P.n} (${(100 * P.rate).toFixed(1)}%) vs routed ${R.solved}/${R.n} (${(100 * R.rate).toFixed(1)}%)`);
console.log(`          pairs: both=${both} premium-only=${premiumOnly} routed-only=${routedOnly} neither=${neither}`);
console.log(`          McNemar exact p=${mcnemarP.toFixed(3)} on ${d} discordant pair(s)` +
  ` ${mcnemarP > 0.05 ? "— no significant quality difference" : "— SIGNIFICANT difference"}`);
const dist = new Map<string, number>();
for (const [, r] of pairs) {
  const m = r.routed?.chosen_model ?? "?";
  dist.set(m, (dist.get(m) ?? 0) + 1);
}
console.log(`3. ROUTED DISTRIBUTION: ${[...dist.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m}×${n}`).join(" · ")}`);
const offline = pairs.filter(([, r]) => r.routed?.routed_kind !== "server").length;
if (offline) console.log(`   ⚠ ${offline} routed-arm attempt(s) fell back offline/pinned — inspect before quoting numbers`);
const estPrem = pairs.reduce((s, [, r]) => s + (r.routed?.est_premium_usd ?? 0), 0);
console.log(`X. CROSS-CHECK (secondary): server's all-premium counterfactual for the routed arm = $${estPrem.toFixed(2)}` +
  ` vs measured premium arm = $${P.cost.toFixed(2)}`);
console.log("=".repeat(76));
console.log(`n=${pairs.length} demo-scale caveat: cost deltas are credible; parity is bounded to roughly ±10-15pp — say so when presenting.`);
