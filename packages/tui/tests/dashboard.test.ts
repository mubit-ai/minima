/**
 * Localhost dashboard: the read-only guarantee, the honesty rules carried over from /cost and
 * the scoreboard, the JSON contract, and the auth/write-seam posture. Hermetic — a temp-file
 * ledger seeded through MinimaDb, handler invoked directly (no listening socket, no network).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seqStep, statusBar } from "../src/dashboard/charts.ts";
import { DashboardStore, LedgerUnavailableError } from "../src/dashboard/queries.ts";
import { planDetailView, runsView } from "../src/dashboard/render.ts";
import { createDashboard, createHandler } from "../src/dashboard/server.ts";
import {
  claimRule,
  classifyChanges,
  gateTiers,
  kpis,
  modelStats,
  overview,
  planPosition,
  planView,
  resolveChangePath,
  scoreboardCells,
  sessionList,
} from "../src/dashboard/stats.ts";
import { type DecisionWrite, MinimaDb } from "../src/db/minima_db.ts";

const PROJECT = "acme/widget";
const TOKEN = "test-token-0123456789";

let dir: string;
let dbPath: string;
let seeded: { runId: string; memoryId: string };

function decision(over: Partial<DecisionWrite> & { recId: string }): DecisionWrite {
  return {
    runId: seeded.runId,
    taskLabel: "task",
    taskType: "code_edit",
    chosenModel: "cheap-1",
    decisionBasis: "observed",
    confidence: 0.7,
    thresholdUsed: 0.6,
    ranked: [
      { modelId: "cheap-1", estCostUsd: 0.01, predictedSuccess: 0.7 },
      { modelId: "premium-1", estCostUsd: 0.2, predictedSuccess: 0.9 },
    ],
    estCostUsd: 0.01,
    allPremiumCostUsd: 0.2,
    configuredBaselineCostUsd: 0.1,
    actualCostUsd: 0.02,
    quality: 0.9,
    judged: true,
    outcome: "success",
    turns: 1,
    latencyMs: 1200,
    ...over,
  };
}

function seed(): void {
  const db = new MinimaDb(dbPath);
  db.ensureProject(PROJECT);
  const runId = db.startRun({ projectKey: PROJECT });
  seeded = { runId, memoryId: "" };

  // Four decisions on cheap-1 so the scoreboard cell clears the n >= 3 floor, plus one on
  // premium-1 that must stay suppressed.
  const planId = db.insertPlan({ sessionId: runId, title: "ship it" });
  const stepId = db.insertStep({ planId, idx: 0, content: "step", status: "completed" });
  for (let i = 0; i < 4; i += 1) {
    const recId = `rec-cheap-${i}`;
    db.writeDecision(decision({ recId, judged: i < 3, quality: i < 3 ? 0.9 : null }));
    db.insertGate({
      planId,
      stepId,
      recId,
      outcome: "verified",
      // Only the deterministic greens may count as green.
      confidence: i === 3 ? "red" : "green",
      verifiedBy: i === 2 ? "judge" : "deterministic",
    });
  }
  db.writeDecision(
    decision({ recId: "rec-premium-0", chosenModel: "premium-1", actualCostUsd: 0.2 }),
  );
  db.writeToolCall({ runId, toolName: "bash", args: {}, result: "ok", isError: false });
  db.writeToolCall({ runId, toolName: "bash", args: {}, result: "boom", isError: true });
  db.writeToolCall({ runId, toolName: "read", args: {}, result: "ok", isError: false });
  seeded.memoryId = db.insertMemory({
    projectKey: PROJECT,
    kind: "lesson",
    content: "prefer cheap-1 for small edits",
    evidenceSource: "gate",
    origin: "scribe",
    status: "pending",
  });
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "minima-dash-"));
  dbPath = join(dir, "minima.db");
  seed();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("read-only guarantee", () => {
  test("the store's handle physically cannot write", () => {
    const store = new DashboardStore(dbPath);
    expect(() =>
      store.db.run("INSERT INTO projects (project_key, created) VALUES ('x', 1)"),
    ).toThrow();
    store.close();
  });

  test("a missing ledger surfaces LedgerUnavailableError, not a raw SQLite error", () => {
    expect(() => new DashboardStore(join(dir, "nope.db"))).toThrow(LedgerUnavailableError);
  });

  test("opening the dashboard never creates a ledger file", () => {
    const absent = join(dir, "absent.db");
    expect(() => createDashboard({ dbPath: absent, token: TOKEN })).toThrow(LedgerUnavailableError);
    expect(Bun.file(absent).size).toBe(0);
  });
});

describe("queries", () => {
  test("rolls up per-run decisions, spend and tool errors", () => {
    const store = new DashboardStore(dbPath);
    const runs = store.runs(PROJECT);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.decisions).toBe(5);
    expect(runs[0]!.cost_usd).toBeCloseTo(0.28, 6);
    expect(runs[0]!.tool_calls).toBe(3);
    expect(runs[0]!.tool_errors).toBe(1);
    store.close();
  });

  test("scopes to a project and returns nothing for an unknown one", () => {
    const store = new DashboardStore(dbPath);
    expect(store.runs("other/repo")).toHaveLength(0);
    expect(store.decisions("other/repo")).toHaveLength(0);
    expect(store.runs(null)).toHaveLength(1);
    store.close();
  });

  test("run detail carries decisions, tool usage and plans", () => {
    const store = new DashboardStore(dbPath);
    const detail = store.runDetail(seeded.runId);
    expect(detail).not.toBeNull();
    expect(detail!.decisions).toHaveLength(5);
    expect(detail!.tools.find((t) => t.tool === "bash")?.errors).toBe(1);
    expect(detail!.plans).toHaveLength(1);
    expect(store.runDetail("no-such-run")).toBeNull();
    store.close();
  });
});

describe("stats honesty", () => {
  test("green counts deterministic gates only — a judge's green is not green", () => {
    const store = new DashboardStore(dbPath);
    const cells = scoreboardCells(store.scoreboardRows(PROJECT));
    // cheap-1 clears the floor (n=4); premium-1 (n=1) is suppressed.
    expect(cells).toHaveLength(1);
    expect(cells[0]!.model).toBe("cheap-1");
    expect(cells[0]!.n).toBe(4);
    expect(cells[0]!.greens).toBe(2);
    expect(cells[0]!.reds).toBe(1);
    store.close();
  });

  test("cells under the n floor are suppressed, not shown as weak signal", () => {
    const store = new DashboardStore(dbPath);
    expect(scoreboardCells(store.scoreboardRows(PROJECT), 99)).toHaveLength(0);
    store.close();
  });

  test("a step check with no stored tier is graded from factors, not counted ungraded", () => {
    // Regression: step_check gates are written with confidence=NULL by design (the stored
    // tier is a milestone rollup). Reading the raw column reported them all as "ungraded" —
    // on a real ledger that was 81% of gates.
    const store = new DashboardStore(dbPath);
    const rows = store.gateRows(PROJECT);
    expect(rows.length).toBeGreaterThan(0);
    const tiers = gateTiers(rows);
    expect(tiers.total).toBe(rows.length);
    expect(tiers.ungraded).toBe(0);
    expect(tiers.green + tiers.yellow + tiers.red).toBe(rows.length);
    store.close();
  });

  test("gate reasons explain every tier and sum to the gate count", () => {
    const store = new DashboardStore(dbPath);
    const tiers = gateTiers(store.gateRows(PROJECT));
    expect(tiers.reasons.length).toBeGreaterThan(0);
    expect(tiers.reasons.reduce((s, r) => s + r.n, 0)).toBe(tiers.total);
    // Worst-first: a red reason never sorts below a yellow one.
    const order = tiers.reasons.map((r) => r.tier);
    expect(order.indexOf("red")).toBeLessThanOrEqual(
      order.includes("yellow") ? order.indexOf("yellow") : order.length,
    );
    store.close();
  });

  test("a gate with neither a stored tier nor parseable factors stays ungraded", () => {
    const tiers = gateTiers([
      {
        id: "g1",
        plan_id: null,
        step_id: null,
        kind: "stop",
        outcome: "unchecked",
        confidence: null,
        verified_by: null,
        factors_json: null,
        created_at: null,
      },
    ] as unknown as Parameters<typeof gateTiers>[0]);
    expect(tiers.ungraded).toBe(1);
    expect(tiers.greenRate).toBeNull();
  });

  test("model shares sum to 1 and quality averages over judged rows only", () => {
    const store = new DashboardStore(dbPath);
    const stats = modelStats(store.modelMix(PROJECT));
    expect(stats.reduce((s, m) => s + m.share, 0)).toBeCloseTo(1, 6);
    const cheap = stats.find((m) => m.model === "cheap-1")!;
    expect(cheap.n).toBe(4);
    expect(cheap.judged_n).toBe(3);
    expect(cheap.avgQuality).toBeCloseTo(0.9, 6);
    store.close();
  });

  test("a metric with no coverage reports no-data instead of a fabricated zero", () => {
    const tiles = kpis([], 0, gateTiers([]));
    const qpd = tiles.find((k) => k.key === "qpd")!;
    expect(qpd.raw).toBeNull();
    expect(qpd.value).toBe("no data");
    const green = tiles.find((k) => k.key === "gate_green")!;
    expect(green.value).toBe("no data");
  });

  test("negative savings say 'overspent', not a minus sign under a tile labeled Saved", () => {
    // Real ledgers do this: the realized cost can exceed the anchor.
    const overspent = kpis(
      [
        {
          quality: null,
          judged: 0,
          outcome: "success",
          actual_cost_usd: 0.5,
          est_cost_usd: 0.01,
          all_premium_cost_usd: 0.2,
          configured_baseline_cost_usd: null,
          decision_basis: "observed",
          threshold_used: 0.6,
          routed: "server",
          ranked: null,
        },
      ],
      1,
      gateTiers([]),
    );
    const premium = overspent.find((k) => k.key === "savings_premium")!;
    expect(premium.raw).toBeCloseTo(-0.3, 6);
    expect(premium.value).toBe("-$0.3000");
    expect(premium.note).toContain("overspent");
  });

  test("savings never conflates the premium anchor with the configured baseline", () => {
    const store = new DashboardStore(dbPath);
    const payload = overview(store, PROJECT);
    const premium = payload.kpis.find((k) => k.key === "savings_premium")!;
    const baseline = payload.kpis.find((k) => k.key === "savings_baseline")!;
    expect(premium.raw).not.toBeNull();
    expect(baseline.raw).not.toBeNull();
    expect(premium.raw).not.toBeCloseTo(baseline.raw!, 6);
    expect(premium.note).toContain("generous");
    expect(baseline.note).toContain("honest");
    store.close();
  });
});

describe("http surface", () => {
  const get = (handler: (r: Request) => Promise<Response>, path: string, init?: RequestInit) =>
    handler(
      new Request(`http://127.0.0.1:4180${path}`, {
        headers: { cookie: `minima_dash=${TOKEN}` },
        ...init,
      }),
    );

  test("every route except /healthz needs the token", async () => {
    const { handler } = createDashboard({ dbPath, token: TOKEN });
    const anon = await handler(new Request("http://127.0.0.1:4180/"));
    expect(anon.status).toBe(401);
    const health = await handler(new Request("http://127.0.0.1:4180/healthz"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, readOnly: true });
  });

  test("a wrong token is rejected", async () => {
    const { handler } = createDashboard({ dbPath, token: TOKEN });
    const res = await handler(
      new Request("http://127.0.0.1:4180/", { headers: { "x-minima-token": "nope" } }),
    );
    expect(res.status).toBe(401);
  });

  test("the token in the query string is parked in a Strict HttpOnly cookie", async () => {
    const { handler } = createDashboard({ dbPath, token: TOKEN });
    const res = await handler(new Request(`http://127.0.0.1:4180/?t=${TOKEN}&project=${PROJECT}`));
    expect(res.status).toBe(302);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // The token is dropped from the redirect target; the scope survives.
    expect(res.headers.get("location")).not.toContain(TOKEN);
    expect(res.headers.get("location")).toContain("project=");
  });

  test("html views render for every nav route", async () => {
    const { handler } = createDashboard({ dbPath, token: TOKEN });
    for (const path of ["/", "/routing", "/runs", "/plans", "/memory", "/cost"]) {
      const res = await get(handler, path);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toStartWith("<!doctype html>");
      expect(body).toContain("</html>");
    }
  });

  test("the overview payload is the same shape the HTML is built from", async () => {
    const { handler } = createDashboard({ dbPath, token: TOKEN });
    const res = await get(handler, `/api/v1/overview?project=${encodeURIComponent(PROJECT)}`);
    const body = (await res.json()) as ReturnType<typeof overview>;
    expect(body.scope).toBe(PROJECT);
    expect(body.kpis.length).toBeGreaterThan(0);
    expect(body.models.map((m) => m.model).sort()).toEqual(["cheap-1", "premium-1"]);
    expect(body.scoreboard).toHaveLength(1);
    expect(body.ledger.schemaVersion).toBeGreaterThan(0);
  });

  test("a session drill-down renders and an unknown id 404s in both surfaces", async () => {
    const { handler } = createDashboard({ dbPath, token: TOKEN });
    const page = await get(handler, `/runs/${seeded.runId}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Routing decisions");
    const api = await get(handler, "/api/v1/runs/no-such-run");
    expect(api.status).toBe(404);
    const unknown = await get(handler, "/api/v1/nope");
    expect(unknown.status).toBe(404);
  });

  test("scope flows from the query string into the rendered page", async () => {
    const { handler } = createDashboard({ dbPath, token: TOKEN });
    const scoped = await get(handler, "/api/v1/runs?project=other%2Frepo");
    expect(((await scoped.json()) as { runs: unknown[] }).runs).toHaveLength(0);
  });
});

describe("write seam", () => {
  const post = (
    handler: (r: Request) => Promise<Response>,
    path: string,
    status: string,
    extra: Record<string, string> = {},
  ) => {
    const form = new FormData();
    form.set("status", status);
    return handler(
      new Request(`http://127.0.0.1:4180${path}`, {
        method: "POST",
        headers: { cookie: `minima_dash=${TOKEN}`, ...extra },
        body: form,
      }),
    );
  };

  test("read-only mode refuses the write and leaves the row untouched", async () => {
    const { handler } = createDashboard({ dbPath, token: TOKEN });
    const res = await post(handler, `/api/v1/memories/${seeded.memoryId}/status`, "pinned");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "read_only" });
    const store = new DashboardStore(dbPath);
    expect(store.memories(PROJECT)[0]!.status).toBe("pending");
    store.close();
  });

  test("--allow-writes routes the change through the audited /memory path", async () => {
    const { handler, ctx } = createDashboard({ dbPath, token: TOKEN, allowWrites: true });
    const res = await post(handler, `/api/v1/memories/${seeded.memoryId}/status`, "pinned");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "pinned" });
    // The audit row is the point: a bare UPDATE would leave no memory_events trail.
    const events = ctx.writeDb!.listMemoryEvents(seeded.memoryId).map((e) => e.op);
    expect(events).toContain("pin");
    const store = new DashboardStore(dbPath);
    expect(store.memories(PROJECT)[0]!.status).toBe("pinned");
    store.close();
    ctx.writeDb!.close();
    ctx.store.close();
  });

  test("an unknown status is rejected before it reaches the ledger", async () => {
    const { handler, ctx } = createDashboard({ dbPath, token: TOKEN, allowWrites: true });
    const res = await post(handler, `/api/v1/memories/${seeded.memoryId}/status`, "invalidated");
    expect(res.status).toBe(400);
    const store = new DashboardStore(dbPath);
    expect(store.memories(PROJECT)[0]!.status).toBe("pending");
    store.close();
    ctx.writeDb!.close();
    ctx.store.close();
  });

  test("a cross-site form POST is denied even with a valid cookie", async () => {
    const { handler, ctx } = createDashboard({ dbPath, token: TOKEN, allowWrites: true });
    const res = await post(handler, `/api/v1/memories/${seeded.memoryId}/status`, "pinned", {
      origin: "http://evil.example",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "cross_origin_denied" });
    ctx.writeDb!.close();
    ctx.store.close();
  });

  test("POST to anything but the memory-status route is a 404", async () => {
    const { handler, ctx } = createDashboard({ dbPath, token: TOKEN, allowWrites: true });
    const res = await post(handler, "/api/v1/runs", "pinned");
    expect(res.status).toBe(404);
    ctx.writeDb!.close();
    ctx.store.close();
  });
});

describe("rendering safety", () => {
  test("ledger text is escaped, never interpolated raw into HTML", async () => {
    const db = new MinimaDb(dbPath);
    db.insertMemory({
      projectKey: PROJECT,
      kind: "note",
      content: "<script>alert('xss')</script>",
      evidenceSource: "none",
      origin: "user",
      status: "active",
    });
    db.close();
    const { handler } = createDashboard({ dbPath, token: TOKEN });
    const body = await (
      await handler(
        new Request("http://127.0.0.1:4180/memory", {
          headers: { cookie: `minima_dash=${TOKEN}` },
        }),
      )
    ).text();
    expect(body).not.toContain("<script>alert");
    expect(body).toContain("&lt;script&gt;alert");
  });

  test("createHandler works without a write handle at all", async () => {
    const store = new DashboardStore(dbPath);
    const handler = createHandler({ store, writeDb: null, token: TOKEN, allowWrites: false });
    const res = await handler(
      new Request("http://127.0.0.1:4180/", { headers: { cookie: `minima_dash=${TOKEN}` } }),
    );
    expect(res.status).toBe(200);
    store.close();
  });
});

describe("theming", () => {
  // The dashboard promises that dropping in Mubit's real console tokens is a value-only edit
  // inside render.ts's TOKENS block. That promise is only real if nothing else declares a
  // color, so this test is the enforcement — not documentation of an intention.
  const SRC = join(import.meta.dir, "..", "src", "dashboard");
  const FILES = ["render.ts", "charts.ts", "server.ts", "queries.ts", "stats.ts", "index.ts"];
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(\s*\d/;

  test("no color literal outside the TOKENS block", async () => {
    const offenders: string[] = [];
    for (const name of FILES) {
      const text = await Bun.file(join(SRC, name)).text();
      // Everything after `const TOKENS = ` up to its closing backtick is the sanctioned block.
      const start = text.indexOf("const TOKENS = `");
      const end = start < 0 ? -1 : text.indexOf("`;", start);
      const lines = text.split("\n");
      let offset = 0;
      for (const [i, line] of lines.entries()) {
        const at = offset;
        offset += line.length + 1;
        if (start >= 0 && at > start && at < end) continue;
        if (LITERAL.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("dark is the default and an explicit theme wins in both directions", async () => {
    const css = await Bun.file(join(SRC, "render.ts")).text();
    const tokens = css.slice(
      css.indexOf("const TOKENS = `"),
      css.indexOf("`;", css.indexOf("const TOKENS = `")),
    );
    // `:root` alone carries dark, so no OS preference is needed to get the default look.
    expect(tokens).toContain("--mode: dark");
    // Light applies on OS preference ONLY while untoggled, and via an explicit attribute.
    expect(tokens).toContain("@media (prefers-color-scheme: light)");
    expect(tokens).toContain(":root:where(:not([data-theme]))");
    expect(tokens).toContain(':root[data-theme="light"]');
  });

  test("every status fill ships an icon and a label, never hue alone", () => {
    const bar = statusBar([
      { key: "green", label: "Green (deterministic)", icon: "✔", n: 3 },
      { key: "red", label: "Red (stop)", icon: "✖", n: 1 },
    ]);
    expect(bar).toContain("Green (deterministic)");
    expect(bar).toContain("✔");
    expect(bar).toContain("Red (stop)");
    expect(bar).toContain("✖");
  });

  test("the sequential ramp spans exactly the declared steps", () => {
    const seen = new Set<string>();
    for (let i = 0; i <= 20; i++) seen.add(seqStep(i / 20));
    for (const step of seen) expect(step).toMatch(/^hsl\(var\(--seq-[1-8]\)\)$/);
    expect(seqStep(0)).toBe("hsl(var(--seq-1))");
    expect(seqStep(1)).toBe("hsl(var(--seq-8))");
  });
});

describe("sessions: freshness, not liveness", () => {
  // The core correction: runs.updated is written at create and close and NEVER per turn, and
  // runs.status never closes on a crash. On a real ledger 134 of 135 'active' runs had
  // updated-created < 1s while their events landed up to 5.5h later, so deriving recency from
  // the stored column would mark a genuinely running session dead about a second after launch.
  test("recency comes from MAX(events.ts), not runs.updated", () => {
    const db = new MinimaDb(dbPath);
    const runId = db.startRun({ projectKey: PROJECT });
    const created = db.db
      .query("SELECT created, updated FROM runs WHERE run_id = ?")
      .get(runId) as {
      created: number;
      updated: number;
    };
    // Exactly the real-ledger shape: updated == created, but activity 5.5h later.
    const late = created.created + 19_854;
    db.appendEvent({ runId, type: "assistant", payload: {}, ts: late });
    db.close();

    const store = new DashboardStore(dbPath);
    const list = sessionList(store.runs(PROJECT, 100), late + 30);
    const row = list.rows.find((r) => r.run_id === runId);
    expect(row).toBeDefined();
    expect(row?.updated).toBe(created.updated);
    // 30s since the event — NOT the ~19,884s that runs.updated would have implied.
    expect(row?.ageSeconds).toBe(30);
    expect(list.newest).toBe(late);
    store.close();
  });

  test("runs with zero events are hidden as empty shells and counted", () => {
    const db = new MinimaDb(dbPath);
    const shell1 = db.startRun({ projectKey: PROJECT });
    const shell2 = db.startRun({ projectKey: PROJECT });
    const real = db.startRun({ projectKey: PROJECT });
    db.appendEvent({ runId: real, type: "assistant", payload: {}, ts: 1_000_000 });
    db.close();

    const store = new DashboardStore(dbPath);
    const list = sessionList(store.runs(PROJECT, 100), 1_000_010);
    const ids = list.rows.map((r) => r.run_id);
    expect(ids).toContain(real);
    expect(ids).not.toContain(shell1);
    expect(ids).not.toContain(shell2);
    // The seeded run has no events either — the count must report every shell, not just mine.
    expect(list.hidden).toBeGreaterThanOrEqual(2);
    expect(list.rows.every((r) => r.events > 0)).toBe(true);
    store.close();
  });

  test("a stored 'active' status never becomes a liveness claim", () => {
    const db = new MinimaDb(dbPath);
    const runId = db.startRun({ projectKey: PROJECT });
    db.appendEvent({ runId, type: "assistant", payload: {}, ts: 1_999_990 });
    expect(db.db.query("SELECT status FROM runs WHERE run_id = ?").get(runId)).toEqual({
      status: "active",
    });
    db.close();
    const store = new DashboardStore(dbPath);
    const list = sessionList(store.runs(PROJECT, 100), 2_000_000);
    // Every row exposes an age; nothing in the payload asserts live/not-live.
    for (const row of list.rows) expect(typeof row.ageSeconds === "number").toBe(true);
    const html = runsView(list, 2_000_000);
    expect(html).toContain("Last activity");
    expect(html).not.toContain("LIVE");
    store.close();
  });
});

describe("write attribution, recomputed", () => {
  test("the claim rule takes a path match, then a filename, then nothing", () => {
    expect(claimRule("Create weather-ui/src/App.jsx", "weather-ui/src/App.jsx")).toBe("path");
    // A two-segment suffix counts — the step named a real portion of the path.
    expect(claimRule("Wire up src/App.jsx", "weather-ui/src/App.jsx")).toBe("path");
    expect(claimRule("Create the App.jsx component", "weather-ui/src/App.jsx")).toBe("filename");
    // The harness's write-time rule accepts a bare basename anywhere; this one still does, but
    // reports it as the WEAKER claim so the split stays visible.
    expect(claimRule("Add the readonly option to the DB layer", "src/db/minima_db.ts")).toBeNull();
    expect(claimRule("Update the index", "src/dashboard/index.ts")).toBeNull();
    expect(claimRule(null, "a/b.ts")).toBeNull();
  });

  test("a write with no in-progress step is finally evaluated instead of auto-off-plan", () => {
    // big_plan.ts:294 is `step && isPathClaimed(...)`, so a null step short-circuits straight
    // to off_plan with no comparison at all — 73 of 208 off-plan rows on a real ledger. The
    // recompute is the only thing that ever assesses them.
    const steps = [
      {
        id: "s0",
        plan_id: "p",
        idx: 0,
        content: "scaffold the project",
        status: "completed",
        verify: null,
        baseline: null,
        check_origin: null,
        verify_cwd: null,
      },
      {
        id: "s1",
        plan_id: "p",
        idx: 1,
        content: "add weather-ui/src/api.js",
        status: "pending",
        verify: null,
        baseline: null,
        check_origin: null,
        verify_cwd: null,
      },
    ];
    const changes = [
      {
        id: "c0",
        plan_id: "p",
        step_id: null,
        path: "weather-ui/src/api.js",
        kind: "created",
        origin: "off_plan",
        created_at: null,
      },
    ];
    const [got] = classifyChanges(steps, changes, "/repo");
    expect(got?.verdict).toBe("on_plan");
    expect(got?.stepId).toBe("s1");
    expect(got?.rule).toBe("path");
    expect(got?.absPath).toBe("/repo/weather-ui/src/api.js");
  });

  test("a path claim anywhere in the plan beats a filename claim", () => {
    const steps = [
      {
        id: "s0",
        plan_id: "p",
        idx: 0,
        content: "touch api.js",
        status: "completed",
        verify: null,
        baseline: null,
        check_origin: null,
        verify_cwd: null,
      },
      {
        id: "s1",
        plan_id: "p",
        idx: 1,
        content: "rewrite src/api.js properly",
        status: "pending",
        verify: null,
        baseline: null,
        check_origin: null,
        verify_cwd: null,
      },
    ];
    const changes = [
      {
        id: "c0",
        plan_id: "p",
        step_id: "s0",
        path: "app/src/api.js",
        kind: "modified",
        origin: "on_plan",
        created_at: null,
      },
    ];
    const [got] = classifyChanges(steps, changes, null);
    expect(got?.rule).toBe("path");
    expect(got?.stepId).toBe("s1");
    // No project root recorded → no absolute path invented.
    expect(got?.absPath).toBeNull();
  });

  test("an opaque write is unattributable, which is not the same as drift", () => {
    const changes = [
      {
        id: "c0",
        plan_id: "p",
        step_id: null,
        path: "",
        kind: "opaque",
        origin: "unknown",
        created_at: null,
      },
    ];
    const [got] = classifyChanges([], changes, "/repo");
    expect(got?.verdict).toBe("unattributable");
    expect(got?.rule).toBeNull();
  });

  test("worked-ahead is reported rather than lost to whole-plan matching", () => {
    const steps = [
      {
        id: "s0",
        plan_id: "p",
        idx: 0,
        content: "first, edit one/a.ts",
        status: "in_progress",
        verify: null,
        baseline: null,
        check_origin: null,
        verify_cwd: null,
      },
      {
        id: "s1",
        plan_id: "p",
        idx: 1,
        content: "later, edit two/b.ts",
        status: "pending",
        verify: null,
        baseline: null,
        check_origin: null,
        verify_cwd: null,
      },
    ];
    // Written while s0 was active, but the path belongs to the LATER step s1.
    const changes = [
      {
        id: "c0",
        plan_id: "p",
        step_id: "s0",
        path: "two/b.ts",
        kind: "modified",
        origin: "off_plan",
        created_at: null,
      },
    ];
    const [got] = classifyChanges(steps, changes, null);
    expect(got?.verdict).toBe("on_plan");
    expect(got?.stepIdx).toBe(1);
    expect(got?.workedAhead).toBe(true);
  });

  test("absolute paths are used verbatim and relative ones resolve against the project root", () => {
    expect(resolveChangePath("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
    expect(resolveChangePath("/repo/", "./src/a.ts")).toBe("/repo/src/a.ts");
    // 7 of 241 rows on a real ledger are already absolute.
    expect(resolveChangePath("/repo", "/elsewhere/b.ts")).toBe("/elsewhere/b.ts");
    expect(resolveChangePath(null, "src/a.ts")).toBeNull();
  });
});

describe("plan detail", () => {
  function seedPlan(): string {
    const db = new MinimaDb(dbPath);
    const planId = db.insertPlan({ sessionId: seeded.runId, title: "add the widget" });
    const s0 = db.insertStep({
      planId,
      idx: 0,
      content: "write lib/widget.ts",
      status: "completed",
      verify: "bun test tests/widget.test.ts",
      baseline: "red",
      checkOrigin: "pre_existing",
    });
    const s1 = db.insertStep({
      planId,
      idx: 1,
      content: "document it",
      status: "in_progress",
      verify: "bun run docs",
    });
    db.insertStep({ planId, idx: 2, content: "unverifiable scaffolding", status: "pending" });
    // A step_check with confidence NULL — the by-design shape whose tier must be DERIVED.
    db.insertGate({
      planId,
      stepId: s0,
      kind: "step_check",
      outcome: "verified",
      confidence: null,
      factors: {
        pass: true,
        redToGreen: true,
        hasCheck: true,
        coverageHit: true,
        tamper: false,
        checkOrigin: "pre_existing",
      },
    });
    db.insertGate({
      planId,
      stepId: s1,
      kind: "step_check",
      outcome: "verified",
      confidence: null,
      factors: {
        pass: true,
        redToGreen: false,
        hasCheck: true,
        coverageHit: true,
        tamper: false,
        checkOrigin: "agent_new",
      },
    });
    db.insertFileChange({
      planId,
      stepId: null,
      path: "lib/widget.ts",
      kind: "created",
      origin: "off_plan",
    });
    db.insertFileChange({
      planId,
      stepId: s0,
      path: "unrelated/thing.rs",
      kind: "modified",
      origin: "off_plan",
    });
    db.close();
    return planId;
  }

  test("a step's tier is derived from factors, never read off the NULL column", () => {
    const planId = seedPlan();
    const store = new DashboardStore(dbPath);
    const view = planView(store.planDetail(planId)!);
    const first = view.tasks.find((t) => t.idx === 0)!;
    expect(first.tier).not.toBeNull();
    expect(first.gateCount).toBe(1);
    // Nothing in this plan's gates carries a stored tier, yet nothing is ungraded.
    expect(view.gates.ungraded).toBe(0);
    store.close();
  });

  test("step position mirrors big_plan.ts: in-progress, else first open, else N", () => {
    const step = (idx: number, status: string) => ({
      id: `s${idx}`,
      plan_id: "p",
      idx,
      content: "",
      status,
      verify: null,
      baseline: null,
      check_origin: null,
      verify_cwd: null,
    });
    expect(planPosition([step(0, "completed"), step(1, "in_progress"), step(2, "pending")])).toBe(
      2,
    );
    expect(planPosition([step(0, "completed"), step(1, "pending")])).toBe(2);
    // All done reads N/N — never the contradictory 0/N.
    expect(planPosition([step(0, "completed"), step(1, "completed")])).toBe(2);
    expect(planPosition([])).toBe(0);
  });

  test("the recompute is shown against the stored column, not asserted", () => {
    const planId = seedPlan();
    const store = new DashboardStore(dbPath);
    const view = planView(store.planDetail(planId)!);
    // Both writes were stored off_plan; one is genuinely claimed by step 0's text.
    expect(view.storedOffPlan).toBe(2);
    expect(view.offPlan.length).toBe(1);
    const html = planDetailView(view, 2_000_000);
    expect(html).toContain("ledger column said 2");
    store.close();
  });

  test("missing baseline and a non-flipping check are never the same sentence", () => {
    const planId = seedPlan();
    const store = new DashboardStore(dbPath);
    const view = planView(store.planDetail(planId)!);
    const html = planDetailView(view, 2_000_000);
    const tasks = html.match(/<li class="task"[\s\S]*?<\/li>/g) ?? [];
    expect(tasks.length).toBe(3);
    for (const task of tasks) {
      const missing = task.includes("no baseline captured");
      const stuck = task.includes("never went red→green");
      // Claiming "no baseline captured" for a step that HAS one is a false statement.
      expect(missing && stuck).toBe(false);
    }
    // Step 0 captured a baseline and flipped; step 1 has a check but no baseline.
    expect(html).toContain("no baseline captured");
    store.close();
  });

  test("a step with no stamped decision renders an em dash, never $0.00", () => {
    const planId = seedPlan();
    const store = new DashboardStore(dbPath);
    const view = planView(store.planDetail(planId)!);
    expect(view.tasks.every((t) => t.costUsd === null)).toBe(true);
    const html = planDetailView(view, 2_000_000);
    expect(html).not.toContain(">$0.00<");
    store.close();
  });

  test("a step with no check says so instead of implying an untested pass", () => {
    const planId = seedPlan();
    const store = new DashboardStore(dbPath);
    const view = planView(store.planDetail(planId)!);
    const html = planDetailView(view, 2_000_000);
    expect(html).toContain("no check attached");
    store.close();
  });

  test("GET /plans/:id renders, and an unknown id is a clean not-found", async () => {
    const planId = seedPlan();
    const handler = createHandler({
      store: new DashboardStore(dbPath),
      writeDb: null,
      token: TOKEN,
      allowWrites: false,
    });
    const ok = await handler(
      new Request(`http://127.0.0.1/plans/${planId}`, { headers: { "x-minima-token": TOKEN } }),
    );
    expect(ok.status).toBe(200);
    const body = await ok.text();
    expect(body).toContain("add the widget");
    expect(body).not.toContain("NaN");

    const missing = await handler(
      new Request("http://127.0.0.1/plans/nope", { headers: { "x-minima-token": TOKEN } }),
    );
    expect(missing.status).toBe(200);
    expect(await missing.text()).toContain("Not found");
  });
});
