/**
 * F1 — headless CLI battery.
 *
 * Exercises the non-interactive surface of the installed binary: exit-code contract,
 * routed/offline/pinned decision rows, --mode json event vocabulary (and its known
 * lossiness, locked in), tool exclusion, and enforce-mode budget deny-before-spend.
 * Each case gets its own DB so "the run" is never ambiguous.
 */

import { Checks } from "../assert/check.ts";
import { HarnessDb } from "../assert/db.ts";
import { parseJsonEvents, runHeadless } from "../driver/headless.ts";
import { MockMinimaServer } from "../driver/mock_server.ts";
import { makeScratch, saveArtifact } from "../driver/scratch.ts";

export async function f1(): Promise<Checks> {
  const c = new Checks("f1_headless");

  // ---- usage-error contract (no server, no spend) --------------------------------
  {
    const s = makeScratch("f1", "help");
    const r = await runHeadless({ args: ["--help"], cwd: s.repoDir, env: s.env });
    c.check("help: exit 0", r.exitCode === 0, `exit=${r.exitCode}`);
    c.check("help: usage text", /cost-aware model-routing/.test(r.stdout));
  }
  {
    const s = makeScratch("f1", "noprompt");
    const r = await runHeadless({ args: ["-p"], cwd: s.repoDir, env: s.env });
    c.check("print without prompt: exit 2", r.exitCode === 2, `exit=${r.exitCode}`);
    c.check("print without prompt: stderr says so", /requires a prompt/.test(r.stderr), r.stderr.slice(0, 200));
  }
  {
    const s = makeScratch("f1", "badflag");
    const r = await runHeadless({ args: ["--bogus-flag", "-p", "hi"], cwd: s.repoDir, env: s.env });
    c.check("unknown flag: exit 2", r.exitCode === 2, `exit=${r.exitCode}`);
  }

  // ---- routed one-shot (live server) ----------------------------------------------
  {
    const s = makeScratch("f1", "routed");
    const r = await runHeadless({
      args: ["-nt", "-p", "Reply with exactly: F1_ROUTED"],
      cwd: s.repoDir,
      env: s.env,
    });
    c.check("routed: exit 0", r.exitCode === 0, `exit=${r.exitCode} stderr=${r.stderr.slice(0, 300)}`);
    c.check("routed: stdout has reply", /F1_ROUTED/.test(r.stdout), r.stdout.slice(0, 200));
    const db = new HarnessDb(s.dbPath);
    const runs = db.runs();
    const dec = db.decisions();
    c.check("routed: exactly one run, status done", runs.length === 1 && runs[0]!.status === "done",
      JSON.stringify(runs));
    c.check("routed: decision routed=server", dec.length === 1 && dec[0]!.routed === "server",
      JSON.stringify(dec.map((d) => ({ routed: d.routed, model: d.chosen_model }))));
    c.check("routed: actual cost recorded > 0", (dec[0]?.actual_cost_usd ?? 0) > 0);
    c.check("routed: ranked candidates persisted", !!dec[0]?.ranked && dec[0]!.ranked!.length > 2);
    c.check("routed: no tool calls under -nt", db.toolCallCount() === 0);
    c.soft("routed: outcome=success", dec[0]?.outcome === "success", String(dec[0]?.outcome));
    db.close();
  }

  // ---- offline one-shot -------------------------------------------------------------
  {
    const s = makeScratch("f1", "offline");
    const r = await runHeadless({
      args: ["--offline", "-nt", "-p", "Reply with exactly: F1_OFF"],
      cwd: s.repoDir,
      env: s.env,
    });
    c.check("offline: exit 0", r.exitCode === 0, `exit=${r.exitCode} stderr=${r.stderr.slice(0, 300)}`);
    const db = new HarnessDb(s.dbPath);
    const dec = db.decisions();
    c.check("offline: decision routed=offline, basis=offline",
      dec.length === 1 && dec[0]!.routed === "offline" && dec[0]!.decision_basis === "offline",
      JSON.stringify(dec.map((d) => ({ routed: d.routed, basis: d.decision_basis }))));
    db.close();
  }

  // ---- pinned one-shot ---------------------------------------------------------------
  {
    const s = makeScratch("f1", "pinned");
    const r = await runHeadless({
      args: ["--model", "claude-haiku-4-5", "-nt", "-p", "Reply with exactly: F1_PIN"],
      cwd: s.repoDir,
      env: s.env,
    });
    c.check("pinned: exit 0", r.exitCode === 0, `exit=${r.exitCode} stderr=${r.stderr.slice(0, 300)}`);
    const db = new HarnessDb(s.dbPath);
    const dec = db.decisions();
    c.check("pinned: decision routed=pinned on the pinned model",
      dec.length === 1 && dec[0]!.routed === "pinned" && dec[0]!.chosen_model === "claude-haiku-4-5",
      JSON.stringify(dec.map((d) => ({ routed: d.routed, model: d.chosen_model }))));
    db.close();
  }

  // ---- --mode json event contract (+ lossiness lock-in) --------------------------------
  {
    const s = makeScratch("f1", "json");
    const r = await runHeadless({
      args: ["--mode", "json", "-nt", "Reply with exactly: F1_JSON"],
      cwd: s.repoDir,
      env: s.env,
    });
    c.check("json: exit 0", r.exitCode === 0, `exit=${r.exitCode} stderr=${r.stderr.slice(0, 300)}`);
    let events: Array<Record<string, unknown>> = [];
    let parsed = true;
    try {
      events = parseJsonEvents(r.stdout);
    } catch (e) {
      parsed = false;
      saveArtifact(s, "stdout.txt", r.stdout);
    }
    c.check("json: every stdout line is JSON", parsed);
    const types = events.map((e) => String(e.type));
    c.check("json: has start and done", types.includes("start") && types.includes("done"),
      types.join(","));
    c.check("json: streamed text deltas", types.filter((t) => t === "text_delta").length > 0);
    c.check("json: no error events", !types.includes("error"));
    // Lossiness lock-in: the stream deliberately drops routing/cost/tool detail today.
    // If richer events ever land, this XFAIL-style canary flips and the contract doc updates.
    const keys = new Set(events.flatMap((e) => Object.keys(e)));
    c.check("json: lock-in — no model/cost/args keys in the stream",
      !keys.has("model_id") && !keys.has("cost_usd") && !keys.has("args"),
      [...keys].join(","));
  }

  // ---- enforce-mode budget deny (deny-before-spend, no decision row) ---------------------
  // Deterministic via the mock server: reserve-deny fires only on server-ROUTED turns
  // (reserveAmount needs a positive server cost estimate; a transient offline fallback
  // silently skips the whole ledger path — locked in as its own case below).
  {
    const s = makeScratch("f1", "deny");
    const mock = new MockMinimaServer(23000 + Math.floor(Math.random() * 10000));
    mock.start();
    const r = await runHeadless({
      args: ["-nt", "-b", "0.0001", "--budget-enforce", "-p", "Reply with exactly: F1_DENY"],
      cwd: s.repoDir,
      env: { ...s.env, MINIMA_URL: mock.url },
    });
    mock.stop();
    c.check("deny: nonzero exit", r.exitCode !== 0 && r.exitCode !== null, `exit=${r.exitCode}`);
    c.check("deny: budget message surfaced", /budget/i.test(r.stderr + r.stdout), r.stderr.slice(0, 300));
    const db = new HarnessDb(s.dbPath);
    c.check("deny: budget_events has deny", db.budgetEventKinds().includes("deny"),
      db.budgetEventKinds().join(","));
    c.check("deny: refused before any decision was persisted", db.decisions().length === 0);
    const b = db.budget();
    c.check("deny: nothing spent", Number(b?.spent_usd ?? -1) === 0, JSON.stringify(b));
    db.close();
  }

  // ---- LOCK-IN: offline turns bypass the budget ledger entirely --------------------------
  // Found 2026-07-06: an offline-fallback turn runs the default model (real provider spend,
  // actual_cost_usd recorded on the decision row) but books NOTHING to the budget ledger —
  // no reserve/reconcile events, spent_usd stays 0, and enforce mode cannot refuse it.
  // If a fix lands (offline turns reconciled into the ledger), these checks flip on purpose.
  {
    const s = makeScratch("f1", "offbudget");
    const r = await runHeadless({
      args: ["--offline", "-nt", "-b", "0.0001", "--budget-enforce", "-p", "Reply with exactly: F1_OFFB"],
      cwd: s.repoDir,
      env: s.env,
    });
    c.check("offline-budget lock-in: turn runs despite exhausted enforce budget",
      r.exitCode === 0, `exit=${r.exitCode}`);
    const db = new HarnessDb(s.dbPath);
    const dec = db.decisions();
    c.check("offline-budget lock-in: real spend recorded on the decision row",
      dec.length === 1 && (dec[0]!.actual_cost_usd ?? 0) > 0,
      JSON.stringify(dec.map((d) => d.actual_cost_usd)));
    c.check("offline-budget lock-in: ledger never touched (no events, $0 spent)",
      db.budgetEventKinds().length === 0 && Number(db.budget()?.spent_usd ?? -1) === 0,
      `events=${db.budgetEventKinds().join(",")} spent=${db.budget()?.spent_usd}`);
    db.close();
  }

  return c;
}
