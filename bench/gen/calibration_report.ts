/**
 * Calibration report: fold bench/tasks/calibration.jsonl into per-task × per-arm solve
 * rates, compare against authored difficulty bins, and propose evidence-based verdicts.
 *
 * Thresholds (aider-polyglot style, on k>=5 rates):
 *   easy    cheap >= 0.8
 *   medium  cheap in [0.2, 0.6] and frontier >= 0.8
 *   hard    cheap <= 0.2 and frontier >= 0.5
 * Verdicts: OK (authored bin consistent with rates; trivial counts as easy),
 * RE-BIN:<bin> (rates clearly indicate a different bin), NO-SIGNAL (authored
 * medium/hard but both arms >= 0.8 — no routing differentiation; rework or accept as
 * easy), DROP? (both arms <= 0.2 — likely unsolvable as stated).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverTaskDirs } from "./attempt.ts";
import { loadTask, TASKS_ROOT } from "./materialize.ts";

interface Row {
  task: string;
  arm: string;
  solved: boolean;
  cheated: boolean;
  cost_usd?: number | null;
  duration_ms?: number;
}

const logPath = join(TASKS_ROOT, "calibration.jsonl");
if (!existsSync(logPath)) {
  console.error("no calibration.jsonl yet");
  process.exit(2);
}
const rows: Row[] = readFileSync(logPath, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Row);

const byTask = new Map<string, Record<string, Row[]>>();
for (const r of rows) {
  const rec = byTask.get(r.task) ?? {};
  (rec[r.arm] ??= []).push(r);
  byTask.set(r.task, rec);
}

function rate(rs: Row[] | undefined): { n: number; rate: number } {
  const n = rs?.length ?? 0;
  if (!n) return { n: 0, rate: Number.NaN };
  return { n, rate: rs!.filter((r) => r.solved && !r.cheated).length / n };
}

function suggest(cheap: number, frontier: number): string {
  if (Number.isNaN(cheap) || Number.isNaN(frontier)) return "?";
  if (cheap >= 0.8 && frontier >= 0.8) return "easy";
  if (cheap <= 0.2 && frontier < 0.5) return "drop?";
  if (cheap <= 0.2) return "hard";
  if (cheap <= 0.6 && frontier >= 0.8) return "medium";
  return "medium?"; // mid cheap rate, weak frontier — noisy band
}

const out: string[] = [];
let reBins = 0;
let noSignal = 0;
console.log("task     authored  cheap(n)      frontier(n)   suggested  verdict");
console.log("-".repeat(78));
for (const taskDir of discoverTaskDirs(TASKS_ROOT)) {
  const meta = loadTask(taskDir);
  const rec = byTask.get(meta.id);
  const c = rate(rec?.cheap);
  const f = rate(rec?.frontier);
  const sug = suggest(c.rate, f.rate);
  const authoredAsEasy = meta.difficulty === "trivial" || meta.difficulty === "easy";
  let verdict = "OK";
  if (sug === "easy" && !authoredAsEasy) {
    verdict = "NO-SIGNAL (both arms solve it)";
    noSignal++;
  } else if (sug === "medium" && meta.difficulty !== "medium") {
    verdict = "RE-BIN:medium";
    reBins++;
  } else if (sug === "hard" && meta.difficulty !== "hard") {
    verdict = "RE-BIN:hard";
    reBins++;
  } else if (sug === "drop?") {
    verdict = "DROP? (both arms fail)";
  }
  const fmt = (x: { n: number; rate: number }) =>
    x.n ? `${x.rate.toFixed(2)} (${x.n})`.padEnd(12) : "—".padEnd(12);
  console.log(
    `${meta.id.padEnd(8)} ${meta.difficulty.padEnd(9)} ${fmt(c)} ${fmt(f)} ${sug.padEnd(10)} ${verdict}`,
  );
  out.push(JSON.stringify({ task: meta.id, authored: meta.difficulty, cheap: c, frontier: f, suggested: sug, verdict }));
}
const cheatCount = rows.filter((r) => r.cheated).length;
const spend = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
console.log("-".repeat(78));
console.log(
  `${rows.length} attempts · $${spend.toFixed(2)} · ${cheatCount} cheated · ${reBins} re-bin candidates · ${noSignal} no-signal`,
);
