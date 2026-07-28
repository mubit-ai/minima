/**
 * Localhost dashboard: the read-only guarantee, the honesty rules carried over from /cost and
 * the scoreboard, the JSON contract, and the auth/write-seam posture. Hermetic — a temp-file
 * ledger seeded through MinimaDb, handler invoked directly (no listening socket, no network).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataTable, seqStep, statusBar, tableFilter } from "../src/dashboard/charts.ts";
import {
  EDITOR_NAMES,
  MAX_LINES,
  detectEditor,
  editorArgv,
  isInside,
  openInEditor,
  readRecorded,
  resolveRecorded,
} from "../src/dashboard/files.ts";
import { DashboardStore, LedgerUnavailableError } from "../src/dashboard/queries.ts";
import { agoCell, fileView, planDetailView, runsView } from "../src/dashboard/render.ts";
import {
  ActivityHub,
  IDLE_TIMEOUT_S,
  MAX_STREAMS,
  createDashboard,
  createHandler,
} from "../src/dashboard/server.ts";
import {
  claimRule,
  classifyChanges,
  gapFillDays,
  gateTiers,
  kpis,
  modelStats,
  overview,
  planPosition,
  planView,
  resolveChangePath,
  scoreboardCells,
  sessionList,
  stepCheckPassRate,
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

/**
 * A complete handler context. `tsconfig.json` typechecks `src/**` only, so a ctx literal spelled
 * out inline here goes stale silently — three of them had drifted past `hub` and `editor` before
 * this existed. Everything is closed by the caller.
 */
function ctxFor(opts: { editor?: string | null; hub?: ActivityHub } = {}) {
  const store = new DashboardStore(dbPath);
  return {
    store,
    token: TOKEN,
    editor: opts.editor ?? null,
    hub: opts.hub ?? new ActivityHub(() => store.newestEvent()),
  };
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

  test("the savings tile names its anchor and reports evidence, not a bare number", () => {
    const store = new DashboardStore(dbPath);
    const payload = overview(store, PROJECT);
    const tile = payload.kpis.find((k) => k.key === "savings_anchor")!;
    // premium-1 was a candidate on every row, so this is pure direct tier: 5 rows repriced by
    // est_premium/est_chosen, no price table consulted at all.
    expect(payload.anchorId).toBe("premium-1");
    expect(tile.label).toBe("Saved vs premium-1");
    // cheap rows: 0.02 x (0.2/0.01) = 0.4 each; the premium row reprices to itself (0.2).
    expect(tile.raw).toBeCloseTo(4 * 0.4 + 0.2 - (4 * 0.02 + 0.2), 6);
    expect(tile.note).toContain("5 direct / 0 solved");
    expect(tile.note).toContain("realized tokens are not recorded");
    store.close();
  });

  test("the strip carries exactly one savings tile, and no baseline or OCR tile", () => {
    // Five cost tiles became three. "Saved vs baseline" was NULL on every row a real ledger has
    // ever written (baselineModelId is hardcoded null), and the optimal-cost ratio reads 1.0 by
    // construction once its unit bug is repaired — a metric with one possible value.
    const store = new DashboardStore(dbPath);
    const keys = overview(store, PROJECT).kpis.map((k) => k.key);
    expect(keys.filter((k) => k.startsWith("savings")).length).toBe(1);
    expect(keys).not.toContain("savings_baseline");
    expect(keys).not.toContain("savings_premium");
    expect(keys).not.toContain("ocr");
    store.close();
  });

  test("a negative saving leads with the τ-miss count, not with the minus sign", () => {
    // Picking a cheap anchor is a real path, and "-$0.30" alone reads as "routing wasted $0.30".
    const store = new DashboardStore(dbPath);
    const payload = overview(store, PROJECT, "cheap-1");
    const tile = payload.kpis.find((k) => k.key === "savings_anchor")!;
    expect(payload.anchorId).toBe("cheap-1");
    expect(tile.raw).toBeLessThan(0);
    expect(tile.note).toStartWith("overspent this anchor by");
    // cheap-1's predicted success (0.7) clears τ=0.6, so there is no τ-miss to report here and
    // the note must fall back to the evidence rather than inventing a counterweight.
    expect(tile.note).toContain("direct / 0 solved");
    store.close();
  });

  test("an unknown ?anchor= falls back instead of rendering a tile for a non-candidate", () => {
    const store = new DashboardStore(dbPath);
    const payload = overview(store, PROJECT, "gpt-4o");
    expect(payload.anchorId).toBe("premium-1");
    store.close();
  });

  test("quality-per-dollar discloses its coverage in dollars, not only in rows", () => {
    // 10% of rows sounds survivable; the share of the MONEY those rows spent is the real caveat.
    const store = new DashboardStore(dbPath);
    const qpd = overview(store, PROJECT).kpis.find((k) => k.key === "qpd")!;
    expect(qpd.note).toContain("of the money");
    expect(qpd.note).toMatch(/\$[\d.]+ of \$[\d.]+/);
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

describe("no write path", () => {
  const post = (handler: (r: Request) => Promise<Response>, path: string) =>
    handler(
      new Request(`http://127.0.0.1:4180${path}`, {
        method: "POST",
        headers: { cookie: `minima_dash=${TOKEN}` },
        body: new FormData(),
      }),
    );

  test("the memory-status endpoint is gone, and the row it used to change is untouched", async () => {
    // It used to answer 403 without --allow-writes. There is no endpoint now, so a 404 is the
    // honest answer — nothing to authorize.
    const { handler, ctx } = createDashboard({ dbPath, token: TOKEN });
    const res = await post(handler, `/api/v1/memories/${seeded.memoryId}/status`);
    expect(res.status).toBe(404);
    const store = new DashboardStore(dbPath);
    expect(store.memories(PROJECT)[0]!.status).toBe("pending");
    store.close();
    ctx.hub.stop();
    ctx.store.close();
  });

  test("the ONLY route that accepts a non-GET is /api/v1/open", async () => {
    const { handler, ctx } = createDashboard({ dbPath, token: TOKEN });
    for (const path of [
      "/",
      "/memory",
      "/plans",
      "/api/v1/runs",
      "/api/v1/plans",
      `/api/v1/memories/${seeded.memoryId}/status`,
    ]) {
      const res = await post(handler, path);
      expect(res.status).toBe(404);
    }
    // /api/v1/open still answers — 400 for a malformed body, which means it was reached.
    const open = await post(handler, "/api/v1/open");
    expect(open.status).not.toBe(404);
    ctx.hub.stop();
    ctx.store.close();
  });

  test("/memory renders no control that could submit anything", async () => {
    const { handler, ctx } = createDashboard({ dbPath, token: TOKEN });
    const body = await (
      await handler(
        new Request("http://127.0.0.1:4180/memory", {
          headers: { cookie: `minima_dash=${TOKEN}` },
        }),
      )
    ).text();
    expect(body).not.toContain("<form");
    expect(body).not.toContain("/api/v1/memories/");
    // The status column stays — it is information, not a control.
    expect(body).toContain("pending");
    ctx.hub.stop();
    ctx.store.close();
  });

  test("/healthz still states the posture without needing the token", async () => {
    const { handler, ctx } = createDashboard({ dbPath, token: TOKEN });
    const res = await handler(new Request("http://127.0.0.1:4180/healthz"));
    expect(await res.json()).toMatchObject({ ok: true, readOnly: true });
    ctx.hub.stop();
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

  test("createHandler renders from a bare readonly context", async () => {
    const ctx = ctxFor();
    const handler = createHandler(ctx);
    const res = await handler(
      new Request("http://127.0.0.1:4180/", { headers: { cookie: `minima_dash=${TOKEN}` } }),
    );
    expect(res.status).toBe(200);
    ctx.hub.stop();
    ctx.store.close();
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
    const ctx = ctxFor();
    const handler = createHandler(ctx);
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
    ctx.hub.stop();
    ctx.store.close();
  });

  test("the project filter is withheld on detail pages but the scope survives", async () => {
    // Picking a project on a detail page could only ever reload the same row, so the control is
    // gone there. What must NOT happen is losing the scope — it stays on every nav link and in
    // the URL, so the way back to a scoped list still works.
    const planId = seedPlan();
    const ctx = ctxFor();
    const handler = createHandler(ctx);
    const page = async (path: string) =>
      (
        await handler(
          new Request(`http://127.0.0.1${path}`, { headers: { "x-minima-token": TOKEN } }),
        )
      ).text();

    const scoped = `?project=${encodeURIComponent(PROJECT)}`;
    const detail = await page(`/plans/${planId}${scoped}`);
    expect(detail).not.toContain('id="scope"');
    expect(detail).toContain(`/plans?project=${encodeURIComponent(PROJECT)}`);
    // cmd-K still carries the projects, so scope switching is reachable without the control.
    expect(detail).toContain("project");

    // A session detail page is the same story: one run, one project.
    const session = await page(`/runs/${seeded.runId}${scoped}`);
    expect(session).not.toContain('id="scope"');
    expect(session).toContain(`/runs?project=${encodeURIComponent(PROJECT)}`);

    // Unknown ids are still detail pages, so they withhold the control too.
    for (const path of ["/plans/nope", "/runs/nope"]) {
      expect(await page(path)).not.toContain('id="scope"');
    }

    // The lists and summaries keep it — that is where switching project changes what you see.
    for (const path of ["/", "/routing", "/runs", "/plans", "/memory", "/cost"]) {
      expect(await page(path)).toContain('id="scope"');
    }
    ctx.hub.stop();
    ctx.store.close();
  });
});

describe("file viewer", () => {
  function seedFile(rel: string, body: string): { planId: string; project: string } {
    const project = join(dir, "proj");
    mkdirSync(join(project, "sub"), { recursive: true });
    writeFileSync(join(project, rel), body);
    const db = new MinimaDb(dbPath);
    db.ensureProject(project);
    const runId = db.startRun({ projectKey: project });
    const planId = db.insertPlan({ sessionId: runId, title: "file plan" });
    db.insertFileChange({ planId, path: rel, kind: "created", origin: "on_plan" });
    db.close();
    return { planId, project };
  }

  test("a relative recorded path resolves against the run's project root", async () => {
    const { planId, project } = seedFile("sub/a.ts", "one\ntwo\nthree");
    const store = new DashboardStore(dbPath);
    const row = store.recordedFile(planId, "sub/a.ts")!;
    expect(row.project_key).toBe(project);
    const file = await readRecorded(row.project_key, row.path);
    expect(file.status).toBe("ok");
    expect(file.lines).toBe(3);
    expect(file.shown.map((l) => l.text)).toEqual(["one", "two", "three"]);
    expect(file.shown[0]!.n).toBe(1);
    store.close();
  });

  test("an absolute recorded path is used verbatim", () => {
    // 7 of 241 rows on a real ledger are already absolute; they must not be re-joined.
    expect(resolveRecorded("/repo", "/elsewhere/x.ts")).toBe("/elsewhere/x.ts");
    expect(resolveRecorded("/repo", "sub/x.ts")).toBe("/repo/sub/x.ts");
    expect(resolveRecorded(null, "sub/x.ts")).toBeNull();
  });

  test("a deleted file is an explained state, not a 500 or a dead link", async () => {
    const { planId } = seedFile("sub/gone.ts", "x");
    rmSync(join(dir, "proj", "sub", "gone.ts"));
    const store = new DashboardStore(dbPath);
    const row = store.recordedFile(planId, "sub/gone.ts")!;
    const file = await readRecorded(row.project_key, row.path);
    expect(file.status).toBe("missing");
    expect(file.note).toContain("not in this checkout");
    // The copy button must still work when the file is gone — an unusable gap is worse.
    const html = fileView(file, planId, "file plan", "code");
    expect(html).toContain('id="copypath"');
    store.close();
  });

  test("a symlink escaping the project root is refused", async () => {
    const { planId } = seedFile("sub/ok.ts", "x");
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(dir, "proj", "sub", "escape.ts"));
    const db = new MinimaDb(dbPath);
    db.insertFileChange({ planId, path: "sub/escape.ts", kind: "created", origin: "on_plan" });
    db.close();

    const store = new DashboardStore(dbPath);
    const row = store.recordedFile(planId, "sub/escape.ts")!;
    const file = await readRecorded(row.project_key, row.path);
    expect(file.status).toBe("escaped");
    expect(file.shown).toEqual([]);
    store.close();
  });

  test("isInside is not fooled by a sibling directory sharing a prefix", () => {
    expect(isInside("/a/proj", "/a/proj/x.ts")).toBe(true);
    expect(isInside("/a/proj", "/a/proj")).toBe(true);
    // The classic prefix bug: /a/project is NOT inside /a/proj.
    expect(isInside("/a/proj", "/a/project/x.ts")).toBe(false);
  });

  test("an over-long file is excerpted with an explicit banner, never silently cut", async () => {
    const lines = Array.from({ length: MAX_LINES + 500 }, (_, i) => `line ${i + 1}`);
    const { planId } = seedFile("sub/big.ts", lines.join("\n"));
    const store = new DashboardStore(dbPath);
    const row = store.recordedFile(planId, "sub/big.ts")!;
    const file = await readRecorded(row.project_key, row.path);
    expect(file.status).toBe("truncated");
    expect(file.lines).toBe(MAX_LINES + 500);
    expect(file.shown.length).toBeLessThan(MAX_LINES);
    expect(file.elided).toBeGreaterThan(0);
    expect(file.note).toContain("render cap");
    // Line numbers stay TRUE to the file — the tail is not renumbered from the head.
    expect(file.shown[file.shown.length - 1]!.n).toBe(MAX_LINES + 500);
    const html = fileView(file, planId, "file plan", null);
    expect(html).toContain("lines not shown");
    store.close();
  });

  test("a binary file is reported, not rendered as mojibake", async () => {
    const { planId } = seedFile("sub/blob.bin", "ok binary");
    const store = new DashboardStore(dbPath);
    const row = store.recordedFile(planId, "sub/blob.bin")!;
    const file = await readRecorded(row.project_key, row.path);
    expect(file.status).toBe("binary");
    expect(file.shown).toEqual([]);
    store.close();
  });

  test("a path never recorded in the ledger has no row at all", () => {
    const { planId } = seedFile("sub/a.ts", "x");
    const store = new DashboardStore(dbPath);
    // Traversal is not filtered — it is structurally impossible, because the lookup is by
    // ledger row and these strings were never recorded.
    expect(store.recordedFile(planId, "../../../../etc/passwd")).toBeNull();
    expect(store.recordedFile(planId, "/etc/passwd")).toBeNull();
    expect(store.recordedFile("no-such-plan", "sub/a.ts")).toBeNull();
    store.close();
  });

  test("editor argv is an array with the line, never a shell string", () => {
    const shellish = "/repo/a b;rm -rf $(pwd)/c.ts";
    for (const editor of EDITOR_NAMES) {
      const argv = editorArgv(editor, shellish, 42)!;
      expect(Array.isArray(argv)).toBe(true);
      expect(argv[0]).toBe(editor);
      // The path arrives in its own argv slot — nothing is concatenated into a command line.
      expect(argv.some((a) => a.includes(shellish))).toBe(true);
      expect(argv.join(" ")).toContain("42");
    }
    expect(editorArgv("not-an-editor", "/a.ts", 1)).toBeNull();
  });

  test("--editor none disables detection and unknown names are refused", () => {
    expect(detectEditor("none")).toBeNull();
    expect(detectEditor("definitely-not-an-editor")).toBeNull();
    expect(detectEditor("code")).toBe("code");
  });

  test("openInEditor refuses when no editor is configured", async () => {
    const res = await openInEditor(null, "/repo/a.ts", 1);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_editor");
  });
});

describe("file routes", () => {
  function handlerWith(editor: string | null): (req: Request) => Promise<Response> {
    return createHandler(ctxFor({ editor }));
  }
  function seedOne(): string {
    const project = join(dir, "proj2");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "a.ts"), "alpha\nbeta");
    const db = new MinimaDb(dbPath);
    db.ensureProject(project);
    const runId = db.startRun({ projectKey: project });
    const planId = db.insertPlan({ sessionId: runId, title: "routed plan" });
    db.insertFileChange({ planId, path: "a.ts", kind: "created", origin: "on_plan" });
    db.close();
    return planId;
  }

  test("GET /files renders the source with line numbers", async () => {
    const planId = seedOne();
    const res = await handlerWith("code")(
      new Request(`http://127.0.0.1/files?plan=${planId}&path=a.ts`, {
        headers: { "x-minima-token": TOKEN },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("alpha");
    expect(body).toContain('<td class="ln">2</td>');
    expect(body).toContain("Open in code");
    // One file, one project: the project filter would only ever reload this same file.
    expect(body).not.toContain('id="scope"');
  });

  test("GET /api/v1/file 404s a path the ledger never recorded", async () => {
    const planId = seedOne();
    const handler = handlerWith(null);
    for (const attempt of ["../../../etc/passwd", "/etc/passwd", "nope.ts"]) {
      const res = await handler(
        new Request(
          `http://127.0.0.1/api/v1/file?plan=${planId}&path=${encodeURIComponent(attempt)}`,
          { headers: { "x-minima-token": TOKEN } },
        ),
      );
      expect(res.status).toBe(404);
    }
  });

  test("the open endpoint is reachable and refuses cross-origin with 403, not 404", async () => {
    // Regression: the write-seam block was guarded on `req.method === "POST"` alone, which made
    // this route dead code — a cross-origin POST returned the write seam's 404 instead.
    const planId = seedOne();
    const res = await handlerWith("code")(
      new Request("http://127.0.0.1/api/v1/open", {
        method: "POST",
        headers: {
          "x-minima-token": TOKEN,
          "content-type": "application/json",
          origin: "http://evil.example",
        },
        body: JSON.stringify({ plan: planId, path: "a.ts" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("cross_origin");
  });

  test("the open endpoint 403s with no editor and 404s an unrecorded path", async () => {
    const planId = seedOne();
    const noEditor = await handlerWith(null)(
      new Request("http://127.0.0.1/api/v1/open", {
        method: "POST",
        headers: { "x-minima-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ plan: planId, path: "a.ts" }),
      }),
    );
    expect(noEditor.status).toBe(403);
    expect(((await noEditor.json()) as { error: string }).error).toBe("no_editor");

    const unrecorded = await handlerWith("code")(
      new Request("http://127.0.0.1/api/v1/open", {
        method: "POST",
        headers: { "x-minima-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ plan: planId, path: "/etc/passwd" }),
      }),
    );
    expect(unrecorded.status).toBe(404);
  });

  test("the open endpoint requires the token like every other route", async () => {
    const planId = seedOne();
    const res = await handlerWith("code")(
      new Request("http://127.0.0.1/api/v1/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: planId, path: "a.ts" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("live activity hub", () => {
  test("polling starts on the first subscriber and STOPS on the last", () => {
    // The RAM requirement in one test: an idle dashboard must run no timer at all, and there is
    // ONE poller for the whole process rather than one per browser tab.
    let polls = 0;
    const hub = new ActivityHub(() => {
      polls += 1;
      return 1;
    });
    expect(polls).toBe(0);
    const a = hub.subscribe(() => {})!;
    const afterSubscribe = polls;
    expect(afterSubscribe).toBeGreaterThan(0);
    expect(hub.size).toBe(1);
    const b = hub.subscribe(() => {})!;
    // A second subscriber must NOT start a second poller.
    expect(hub.size).toBe(2);
    a();
    expect(hub.size).toBe(1);
    b();
    expect(hub.size).toBe(0);
    hub.stop();
  });

  test("concurrent streams are capped so tabs cannot become unbounded state", () => {
    const hub = new ActivityHub(() => 1);
    const releases: (() => void)[] = [];
    for (let i = 0; i < MAX_STREAMS; i += 1) {
      const release = hub.subscribe(() => {});
      expect(release).not.toBeNull();
      releases.push(release!);
    }
    // One past the cap is refused rather than queued or silently accepted.
    expect(hub.subscribe(() => {})).toBeNull();
    releases[0]!();
    // A freed slot is reusable.
    expect(hub.subscribe(() => {})).not.toBeNull();
    hub.stop();
    expect(hub.size).toBe(0);
  });

  test("GET /api/v1/stream opens an event stream and sends the current timestamp", async () => {
    const db = new MinimaDb(dbPath);
    db.appendEvent({ runId: seeded.runId, type: "assistant", payload: {}, ts: 1_234_567 });
    db.close();
    const { handler, ctx } = createDashboard({ dbPath, token: TOKEN });
    const res = await handler(
      new Request("http://127.0.0.1/api/v1/stream", { headers: { "x-minima-token": TOKEN } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value!);
    expect(chunk).toContain("event: activity");
    expect(chunk).toContain("1234567");
    await reader.cancel();
    ctx.hub.stop();
    ctx.store.close();
  });

  test("the stream requires the token like every other route", async () => {
    const { handler, ctx } = createDashboard({ dbPath, token: TOKEN });
    const res = await handler(new Request("http://127.0.0.1/api/v1/stream"));
    expect(res.status).toBe(401);
    ctx.hub.stop();
    ctx.store.close();
  });

  test("a quiet ledger still produces keepalive frames, and they are NOT activity", async () => {
    // The whole bug: tick() used to return early whenever nothing changed, so a quiet ledger
    // meant a silent socket and Bun closed it at its 10s idleTimeout, forever. Milliseconds
    // here instead of the real 20s keepalive.
    let newest: number | null = 5;
    const seen: { newest: number | null; kind: string }[] = [];
    const hub = new ActivityHub(() => newest, { pollMs: 1, keepaliveMs: 4 });
    const release = hub.subscribe((n, kind) => seen.push({ newest: n, kind }))!;
    await Bun.sleep(30);
    expect(seen.length).toBeGreaterThan(0);
    // Nothing changed, so every frame so far is a ping carrying the unchanged value.
    expect(seen.every((f) => f.kind === "ping")).toBe(true);
    expect(seen.every((f) => f.newest === 5)).toBe(true);
    // A real change is still reported as activity.
    seen.length = 0;
    newest = 6;
    await Bun.sleep(10);
    expect(seen[0]).toEqual({ newest: 6, kind: "activity" });
    release();
    hub.stop();
  });

  test("the stream writes a ping frame for a keepalive", async () => {
    const ctx = ctxFor({ hub: new ActivityHub(() => 1, { pollMs: 1, keepaliveMs: 2 }) });
    const handler = createHandler(ctx);
    const res = await handler(
      new Request("http://127.0.0.1/api/v1/stream", { headers: { "x-minima-token": TOKEN } }),
    );
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    // First frame is the state on connect; the next one is the keepalive.
    expect(dec.decode((await reader.read()).value!)).toContain("event: activity");
    const ping = dec.decode((await reader.read()).value!);
    expect(ping).toContain("event: ping");
    expect(ping).not.toContain("event: activity");
    await reader.cancel();
    ctx.hub.stop();
    ctx.store.close();
  });

  test("Bun.serve is given an explicit idleTimeout above the keepalive interval", async () => {
    // A source guard, and labeled as one: it proves the option is passed, not that Bun honors
    // it. The real proof is a tab left open past 10s, which no hermetic test can stage.
    const src = await Bun.file(new URL("../src/dashboard/server.ts", import.meta.url)).text();
    expect(src).toContain("idleTimeout: IDLE_TIMEOUT_S");
    expect(IDLE_TIMEOUT_S).toBeGreaterThan(20);
  });
});

describe("charts that have a series", () => {
  test("quiet days are zero-filled rather than omitted", () => {
    // Omitting them makes an area chart draw a straight line across the gap, which reads as
    // steady spend when the truth is none.
    const filled = gapFillDays([
      { day: "2026-07-01", n: 2, cost_usd: 1 },
      { day: "2026-07-04", n: 3, cost_usd: 2 },
    ]);
    expect(filled.map((d) => d.day)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
    ]);
    expect(filled[1]).toEqual({ day: "2026-07-02", n: 0, cost_usd: 0 });
    // Recorded values pass through untouched.
    expect(filled[3]).toEqual({ day: "2026-07-04", n: 3, cost_usd: 2 });
  });

  test("gap-filling is a no-op below two rows and spans a month boundary", () => {
    expect(gapFillDays([])).toEqual([]);
    expect(gapFillDays([{ day: "2026-07-01", n: 1, cost_usd: 1 }])).toHaveLength(1);
    const across = gapFillDays([
      { day: "2026-07-30", n: 1, cost_usd: 1 },
      { day: "2026-08-02", n: 1, cost_usd: 1 },
    ]);
    expect(across.map((d) => d.day)).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
  });

  test("step-check pass rate reads factors_json, not the NULL confidence column", () => {
    const planId = (() => {
      const db = new MinimaDb(dbPath);
      const id = db.insertPlan({ sessionId: seeded.runId, title: "rates" });
      const step = db.insertStep({ planId: id, idx: 0, content: "s" });
      // parseFactors is strict: all six fields, or the whole object is rejected.
      const base = {
        redToGreen: true,
        hasCheck: true,
        coverageHit: true,
        tamper: false,
        checkOrigin: "pre_existing" as const,
      };
      // confidence is NULL on all three, exactly as the harness writes step checks.
      db.insertGate({
        planId: id,
        stepId: step,
        kind: "step_check",
        factors: { pass: true, ...base },
      });
      db.insertGate({
        planId: id,
        stepId: step,
        kind: "step_check",
        factors: { pass: true, ...base },
      });
      db.insertGate({
        planId: id,
        stepId: step,
        kind: "step_check",
        factors: { pass: false, ...base },
      });
      // Unparseable factors must be excluded from the rate, never counted as a failure.
      db.insertGate({ planId: id, stepId: step, kind: "step_check", factors: { nonsense: 1 } });
      // A milestone gate is not a step check and must not enter the series at all.
      db.insertGate({ planId: id, stepId: step, kind: "milestone", confidence: "red" });
      db.close();
      return id;
    })();
    const store = new DashboardStore(dbPath);
    const rate = stepCheckPassRate(store.planDetail(planId)!.gates);
    expect(rate.pass).toBe(2);
    expect(rate.fail).toBe(1);
    expect(rate.unknown).toBe(1);
    // 2/3 over GRADED rows — the unknown is excluded from the denominator.
    expect(rate.rate).toBeCloseTo(2 / 3, 6);
    store.close();
  });

  test("no coverage yields a null rate, never a fabricated zero", () => {
    expect(stepCheckPassRate([]).rate).toBeNull();
  });
});

describe("client affordances", () => {
  test("relative-age cells carry their raw timestamp so ticking needs no network", () => {
    expect(agoCell(1_000_000, 1_000_030)).toContain('data-ts="1000000"');
    expect(agoCell(null, 1)).toBe("—");
  });

  test("a table given an id is sortable and reports its row count", () => {
    const rows = [{ a: "x" }, { a: "y" }];
    const cols = [{ header: "A", cell: (r: { a: string }) => r.a }];
    expect(dataTable(rows, cols, "empty", "t-x")).toContain('id="t-x" class="sortable"');
    // Without an id it stays a plain table — sorting is opt-in per view.
    expect(dataTable(rows, cols, "empty")).not.toContain("sortable");
    const filter = tableFilter("t-x", "Things", 2);
    expect(filter).toContain('data-for="t-x"');
    expect(filter).toContain('id="t-x-count"');
    expect(filter).toContain("2 rows");
  });

  test("listeners are delegated, so a live <main> swap does not kill them", async () => {
    const { handler, ctx } = createDashboard({ dbPath, token: TOKEN });
    const body = await (
      await handler(new Request("http://127.0.0.1/", { headers: { "x-minima-token": TOKEN } }))
    ).text();
    // Bound-by-id listeners would go dead the first time the SSE refresh replaces <main>.
    expect(body).toContain('document.addEventListener("click"');
    expect(body).not.toContain('getElementById("copypath").addEventListener');
    // And the superseded 10s full-page meta-reload must be gone entirely.
    expect(body).not.toContain("Auto-refresh");
    expect(body).toContain('new EventSource("/api/v1/stream")');
    // The label must heal on ANY frame; keying it off the first one left a reconnected stream
    // reading "reconnecting" forever.
    expect(body).toContain('es.addEventListener("ping"');
    ctx.hub.stop();
    ctx.store.close();
  });
});
