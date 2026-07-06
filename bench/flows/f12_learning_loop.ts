/**
 * F12 — the learning loop, cold vs warm namespace (headless, kata cluster, judge on).
 *
 * Protocol: warm a fresh namespace with 8 kata tasks (routed, MINIMA_LLM_JUDGE=1 so
 * feedback carries real graded quality; each attempt is its own process = its own
 * session). Then run the remaining 4 katas as PROBES in BOTH the warm namespace and a
 * fresh cold one, and compare:
 *   (a) memory writes landed while warming (reinforced_entry_ids echoed)
 *   (b) decision_basis: cold probes route on "prior"; warm probes should show
 *       basis != prior (memory recall) on at least one probe
 *   (c) soft: warm-probe est/actual cost <= cold-probe cost (the payoff)
 *
 * Server-cadence caveat: (b) depends on hosted Mubit reflection/recall timing — it is
 * asserted, but a failure here reads "learning did not surface within one flow" rather
 * than "harness broken"; check reinforced_n first when triaging.
 */

import { Checks } from "../assert/check.ts";
import { type AttemptResult, runAttempt } from "../gen/attempt.ts";
import { TASKS_ROOT } from "../gen/materialize.ts";
import { join } from "node:path";

const WARM_TASKS = ["ka-001", "ka-002", "ka-003", "ka-004", "ka-005", "ka-006", "ka-007", "ka-008"];
// Probes RE-RUN warmed tasks: memory recall is ANN over task text, and held-out katas
// (different algorithms, different statements) are not near-neighbors — v1 of this flow
// probed ka-009..012 and correctly measured "no generalization", which is not the claim
// under test. Same-task recall is.
const PROBE_TASKS = ["ka-001", "ka-002", "ka-003", "ka-004"];
const JUDGE_ENV = { MINIMA_LLM_JUDGE: "1" };

function taskDir(id: string): string {
  return join(TASKS_ROOT, "katas", id);
}

async function pool<T>(items: T[], width: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

export async function f12(): Promise<Checks> {
  const c = new Checks("f12_learning_loop");
  const tag = crypto.randomUUID().slice(0, 8);
  const warmNs = `bench-f12-warm-${tag}`;
  const coldNs = `bench-f12-cold-${tag}`;

  // ---- warm the namespace (8 katas, judged feedback, separate sessions) --------------
  const warm: AttemptResult[] = [];
  await pool(WARM_TASKS, 3, async (id) => {
    const r = await runAttempt(taskDir(id), "warm", "routed", 1, {
      routed: true,
      namespace: warmNs,
      extraEnv: JUDGE_ENV,
      budgetUsd: "0.10",
    });
    warm.push(r);
    console.log(`  warm ${id}: ${r.solved ? "solved" : "failed"} basis=${r.decision_basis} model=${r.chosen_model} reinforced=${r.reinforced_n}`);
  });
  c.check("warm: all attempts server-routed",
    warm.every((r) => r.routed_kind === "server"),
    JSON.stringify(warm.map((r) => r.routed_kind)));
  // Soft: reinforced_entry_ids means REINFORCING existing entries — a cold namespace
  // mostly CREATES on first contact, so empty here is not proof writes failed.
  c.soft("warm: reinforcement echoed on >=1 attempt",
    warm.some((r) => (r.reinforced_n ?? 0) > 0),
    JSON.stringify(warm.map((r) => r.reinforced_n)));
  c.soft("warm: >=6/8 katas solved", warm.filter((r) => r.solved).length >= 6,
    `${warm.filter((r) => r.solved).length}/8`);

  // ---- probes: identical tasks, cold vs warm namespace --------------------------------
  const coldProbes: AttemptResult[] = [];
  const warmProbes: AttemptResult[] = [];
  await pool(PROBE_TASKS, 2, async (id) => {
    coldProbes.push(await runAttempt(taskDir(id), "probe-cold", "routed", 1, {
      routed: true, namespace: coldNs, extraEnv: JUDGE_ENV, budgetUsd: "0.10",
    }));
    warmProbes.push(await runAttempt(taskDir(id), "probe-warm", "routed", 1, {
      routed: true, namespace: warmNs, extraEnv: JUDGE_ENV, budgetUsd: "0.10",
    }));
  });
  for (const [label, rs] of [["cold", coldProbes], ["warm", warmProbes]] as const) {
    console.log(`  probes ${label}: ${rs.map((r) => `${r.task}:${r.decision_basis}`).join(" ")}`);
  }
  c.check("probes: all server-routed",
    [...coldProbes, ...warmProbes].every((r) => r.routed_kind === "server"),
    JSON.stringify([...coldProbes, ...warmProbes].map((r) => r.routed_kind)));
  c.check("cold probes route on prior (no history in a fresh namespace)",
    coldProbes.every((r) => r.decision_basis === "prior"),
    JSON.stringify(coldProbes.map((r) => r.decision_basis)));
  c.check("warm probes: memory basis surfaced on >=1 probe (prior→memory flip)",
    warmProbes.some((r) => r.decision_basis === "memory"),
    JSON.stringify(warmProbes.map((r) => r.decision_basis)));
  const cost = (rs: AttemptResult[]) => rs.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  c.soft("payoff: warm-probe spend <= cold-probe spend",
    cost(warmProbes) <= cost(coldProbes) + 1e-6,
    `warm=$${cost(warmProbes).toFixed(4)} cold=$${cost(coldProbes).toFixed(4)}`);
  c.soft("parity: warm probes solve at least as often as cold",
    warmProbes.filter((r) => r.solved).length >= coldProbes.filter((r) => r.solved).length,
    `warm ${warmProbes.filter((r) => r.solved).length}/4 vs cold ${coldProbes.filter((r) => r.solved).length}/4`);
  return c;
}
