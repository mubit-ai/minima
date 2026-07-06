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
 *
 * Before spending anything, a WRITE-HEALTH probe hits the server API directly
 * (recommend → feedback) and hard-checks `accepted=true` in the feedback BODY. The
 * server rejects writes with HTTP 200 + accepted=false (memory_write_failed), which
 * the binary swallows — asserting on the body is the only way to fail at the true
 * cause instead of the downstream basis=prior symptom (found 2026-07-06: every write
 * for this key was being rejected; all earlier F12 failures trace to that).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Checks } from "../assert/check.ts";
import { type AttemptResult, runAttempt } from "../gen/attempt.ts";
import { TASKS_ROOT } from "../gen/materialize.ts";

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

/** Same key the binary would use: real env wins, repo .env as fallback. Never printed. */
function serverAuth(): { url: string; key: string | null } {
  const url = process.env.MINIMA_URL ?? "https://api.minima.sh";
  let key = process.env.MINIMA_API_KEY ?? process.env.MUBIT_API_KEY ?? null;
  if (!key) {
    try {
      for (const line of readFileSync(join(import.meta.dir, "../../.env"), "utf8").split("\n")) {
        const m = line.match(/^\s*(MINIMA_API_KEY|MUBIT_API_KEY)\s*=\s*(\S+)/);
        if (m) key = m[2]!.replace(/^["']|["']$/g, "");
        if (line.startsWith("MINIMA_API_KEY")) break; // MINIMA_API_KEY takes precedence
      }
    } catch {
      // no .env — probe will report missing auth
    }
  }
  return { url, key };
}

export interface WriteHealth {
  accepted: boolean;
  recordId: string | null;
  fbWarnings: string[];
  recWarnings: string[];
}

/**
 * One recommend→feedback cycle straight against the server API, returning the feedback
 * BODY verdict. The server signals write failure as HTTP 200 + accepted=false, which
 * the harness binary historically swallowed — this is the ground truth for "can this
 * key persist memory at all". Costs two API calls, runs no model.
 */
async function memoryWriteHealth(namespace: string): Promise<WriteHealth | string> {
  const { url, key } = serverAuth();
  if (!key) return "no MINIMA_API_KEY/MUBIT_API_KEY in env or repo .env";
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  try {
    const rec = await fetch(`${url}/v1/recommend`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        task: {
          task: "bench F12 write-health probe: verify feedback persists to memory",
          task_type: "code",
          difficulty: "easy",
        },
        namespace,
        user_id: "bench",
      }),
    });
    if (!rec.ok) return `recommend HTTP ${rec.status}`;
    const recBody = (await rec.json()) as {
      recommendation_id?: string;
      recommended_model?: { model_id?: string };
      warnings?: string[];
    };
    if (!recBody.recommendation_id) return "recommend returned no recommendation_id";
    const fb = await fetch(`${url}/v1/feedback`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        recommendation_id: recBody.recommendation_id,
        chosen_model_id: recBody.recommended_model?.model_id ?? "gemini-2.5-flash",
        outcome: "success",
        quality_score: 0.9,
        judged: true,
        input_tokens: 100,
        output_tokens: 50,
        actual_cost_usd: 0.0001,
      }),
    });
    if (!fb.ok) return `feedback HTTP ${fb.status}`;
    const fbBody = (await fb.json()) as {
      accepted?: boolean;
      record_id?: string | null;
      warnings?: string[];
    };
    return {
      accepted: fbBody.accepted === true,
      recordId: fbBody.record_id ?? null,
      fbWarnings: fbBody.warnings ?? [],
      recWarnings: recBody.warnings ?? [],
    };
  } catch (exc) {
    return `probe error: ${String(exc)}`;
  }
}

export async function f12(): Promise<Checks> {
  const c = new Checks("f12_learning_loop");
  const tag = crypto.randomUUID().slice(0, 8);
  const warmNs = `bench-f12-warm-${tag}`;
  const coldNs = `bench-f12-cold-${tag}`;

  // ---- write-health: can this key persist memory AT ALL? Fail fast at the true cause
  // (accepted=false memory_write_failed) before spending $ on 16 LLM attempts whose
  // basis=prior failure would only be the downstream symptom.
  const health = await memoryWriteHealth(warmNs);
  if (typeof health === "string") {
    c.check("server accepts memory writes (feedback body accepted=true)", false, health);
  } else {
    console.log(
      `  write-health: accepted=${health.accepted} record_id=${health.recordId} ` +
        `fb_warnings=[${health.fbWarnings}] rec_warnings=[${health.recWarnings.filter((w) => w.startsWith("memory")).join(",")}]`,
    );
    c.check(
      "server accepts memory writes (feedback body accepted=true)",
      health.accepted,
      `accepted=${health.accepted} record_id=${health.recordId} warnings=[${health.fbWarnings.join(",")}]`,
    );
  }
  if (typeof health === "string" || !health.accepted) {
    console.log(
      "  write-health FAILED — skipping warm/probe phases (16 LLM attempts would only re-measure the downstream basis=prior symptom)",
    );
    return c;
  }

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
