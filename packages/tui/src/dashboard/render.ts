/**
 * HTML views. Server-rendered from TS template strings — no client framework, no bundler,
 * so the whole dashboard survives `bun build --compile` with zero asset plumbing.
 *
 * Light and dark are both SELECTED (each mode gets steps chosen for its own surface, not an
 * automatic inversion): the sequential ramp is declared by distance-from-surface, so
 * `--seq-550` is the farthest-from-surface step in either mode and magnitude always reads as
 * "more ink". The theme toggle stamps `data-theme` on <html> and must win over the OS
 * setting in both directions.
 *
 * The only client JS is a theme toggle, an auto-refresh timer, and the scope <select> —
 * every number on the page is computed server-side.
 */

import {
  type AreaPoint,
  type BarRow,
  areaChart,
  barChart,
  dataTable,
  emptyState,
  escapeHtml,
  seqStep,
  statusBar,
} from "./charts.ts";
import type {
  BudgetSummary,
  DecisionRecord,
  MemorySummary,
  PlanSummary,
  ProjectSummary,
  RunDetail,
  RunSummary,
  Scope,
} from "./queries.ts";
import type { Kpi, OverviewPayload } from "./stats.ts";

export interface NavItem {
  href: string;
  label: string;
  active: boolean;
}

export interface ShellOptions {
  title: string;
  nav: NavItem[];
  projects: ProjectSummary[];
  scope: Scope;
  ledgerPath: string;
  readOnly: boolean;
  body: string;
}

export const fmtUsd = (n: number | null): string => {
  if (n === null) return "—";
  const mag = Math.abs(n);
  return `${n < 0 ? "-" : ""}${mag >= 1 ? `$${mag.toFixed(2)}` : `$${mag.toFixed(4)}`}`;
};

export const fmtPct = (rate: number | null): string =>
  rate === null ? "—" : `${Math.round(rate * 100)}%`;

export function fmtAgo(epochSeconds: number | null, now: number): string {
  if (epochSeconds === null || !Number.isFinite(epochSeconds)) return "—";
  const secs = Math.max(0, now - epochSeconds);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}

const STYLE = `
:root {
  color-scheme: light;
  --plane: #f9f9f7;
  --surface-1: #fcfcfb;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #898781;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11,11,11,0.10);
  --series-1: #2a78d6;
  --series-1-soft: rgba(42,120,214,0.14);
  --good: #0ca30c;
  --warning: #fab219;
  --critical: #d03b3b;
  --seq-100: #cde2fb; --seq-150: #b7d3f6; --seq-200: #9ec5f4; --seq-250: #86b6ef;
  --seq-300: #6da7ec; --seq-350: #5598e7; --seq-400: #3987e5; --seq-450: #2a78d6;
  --seq-500: #256abf; --seq-550: #1c5cab;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --plane: #0d0d0d;
    --surface-1: #1a1a19;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --border: rgba(255,255,255,0.10);
    --series-1: #3987e5;
    --series-1-soft: rgba(57,135,229,0.18);
    --seq-100: #0d366b; --seq-150: #104281; --seq-200: #184f95; --seq-250: #1c5cab;
    --seq-300: #256abf; --seq-350: #2a78d6; --seq-400: #3987e5; --seq-450: #5598e7;
    --seq-500: #6da7ec; --seq-550: #86b6ef;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --plane: #0d0d0d;
  --surface-1: #1a1a19;
  --text-primary: #ffffff;
  --text-secondary: #c3c2b7;
  --text-muted: #898781;
  --grid: #2c2c2a;
  --axis: #383835;
  --border: rgba(255,255,255,0.10);
  --series-1: #3987e5;
  --series-1-soft: rgba(57,135,229,0.18);
  --seq-100: #0d366b; --seq-150: #104281; --seq-200: #184f95; --seq-250: #1c5cab;
  --seq-300: #256abf; --seq-350: #2a78d6; --seq-400: #3987e5; --seq-450: #5598e7;
  --seq-500: #6da7ec; --seq-550: #86b6ef;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--plane);
  color: var(--text-primary);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
a { color: var(--series-1); text-decoration: none; }
a:hover { text-decoration: underline; }
header.top {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  padding: 14px 24px; border-bottom: 1px solid var(--border); background: var(--surface-1);
}
.brand { font-weight: 650; letter-spacing: -0.01em; }
.brand .ro { font-weight: 400; color: var(--text-muted); font-size: 12px; margin-left: 8px; }
nav.tabs { display: flex; gap: 4px; flex-wrap: wrap; }
nav.tabs a {
  padding: 5px 11px; border-radius: 7px; color: var(--text-secondary); font-weight: 500;
}
nav.tabs a:hover { background: var(--plane); text-decoration: none; }
nav.tabs a[aria-current="page"] { background: var(--series-1-soft); color: var(--series-1); }
.spacer { flex: 1 1 auto; }
.controls { display: flex; align-items: center; gap: 8px; }
select, button.ghost {
  font: inherit; color: var(--text-primary); background: var(--surface-1);
  border: 1px solid var(--border); border-radius: 7px; padding: 5px 9px; cursor: pointer;
}
main { padding: 24px; max-width: 1180px; margin: 0 auto; }
h2 { font-size: 15px; margin: 0 0 12px; letter-spacing: -0.01em; }
section.card {
  background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px;
  padding: 18px; margin-bottom: 18px;
}
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 18px; }
.kpi { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
.kpi .label { font-size: 12px; color: var(--text-secondary); }
.kpi .value { font-size: 26px; font-weight: 620; letter-spacing: -0.02em; margin: 4px 0 2px; }
.kpi .note { font-size: 11px; color: var(--text-muted); }
.kpi.nodata .value { color: var(--text-muted); font-size: 19px; }
svg.chart { display: block; overflow: visible; }
svg.chart .bar { fill: var(--seq-450); }
svg.chart .cat { fill: var(--text-secondary); font-size: 12px; }
svg.chart .val { fill: var(--text-primary); font-size: 12px; font-variant-numeric: tabular-nums; }
svg.chart .tick { fill: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
svg.chart .grid { stroke: var(--grid); stroke-width: 1; }
svg.chart .axis { stroke: var(--axis); stroke-width: 1; }
svg.chart .area { fill: var(--series-1-soft); }
svg.chart .line { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; }
svg.chart .dot { fill: var(--series-1); stroke: var(--surface-1); stroke-width: 2; }
svg.chart .hit { fill: transparent; }
svg.chart .seg-green { fill: var(--good); }
svg.chart .seg-yellow { fill: var(--warning); }
svg.chart .seg-red { fill: var(--critical); }
svg.chart .seg-ungraded { fill: var(--axis); }
ul.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 18px; padding: 12px 0 0; margin: 0; }
ul.legend li { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); }
ul.legend .lg-val { font-weight: 620; color: var(--text-primary); font-variant-numeric: tabular-nums; }
ul.legend .lg-pct { color: var(--text-muted); font-variant-numeric: tabular-nums; }
[class^="dot-"] { width: 9px; height: 9px; border-radius: 3px; display: inline-block; }
.dot-green { background: var(--good); } .dot-yellow { background: var(--warning); }
.dot-red { background: var(--critical); } .dot-ungraded { background: var(--axis); }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr:hover { background: var(--plane); }
td.wrap { white-space: normal; min-width: 260px; }
.meter { display: inline-flex; align-items: center; gap: 7px; }
.meter .track { width: 58px; height: 7px; border-radius: 4px; background: var(--grid); overflow: hidden; }
.meter .fill { height: 100%; border-radius: 4px; }
.pill {
  display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px;
  border: 1px solid var(--border); color: var(--text-secondary);
}
.pill.good { color: var(--good); } .pill.warn { color: var(--warning); } .pill.bad { color: var(--critical); }
p.empty { color: var(--text-muted); font-size: 13px; margin: 4px 0; }
p.note { color: var(--text-muted); font-size: 12px; margin: 10px 0 0; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 18px; }
.banner {
  border: 1px solid var(--border); border-left: 3px solid var(--warning); border-radius: 8px;
  padding: 10px 14px; margin-bottom: 18px; font-size: 13px; color: var(--text-secondary);
  background: var(--surface-1);
}
`;

const SCRIPT = `
(function () {
  var root = document.documentElement;
  var toggle = document.getElementById("theme");
  if (toggle) toggle.addEventListener("click", function () {
    var dark = getComputedStyle(root).getPropertyValue("--plane").trim() === "#0d0d0d";
    root.setAttribute("data-theme", dark ? "light" : "dark");
    try { localStorage.setItem("minima-dash-theme", dark ? "light" : "dark"); } catch (e) {}
  });
  try {
    var saved = localStorage.getItem("minima-dash-theme");
    if (saved) root.setAttribute("data-theme", saved);
  } catch (e) {}
  var scope = document.getElementById("scope");
  if (scope) scope.addEventListener("change", function () {
    var url = new URL(window.location.href);
    if (scope.value) url.searchParams.set("project", scope.value);
    else url.searchParams.delete("project");
    window.location.href = url.toString();
  });
  var refresh = document.getElementById("refresh");
  var timer = null;
  function label() { refresh.textContent = timer ? "Auto-refresh: on" : "Auto-refresh: off"; }
  if (refresh) {
    refresh.addEventListener("click", function () {
      if (timer) { clearInterval(timer); timer = null; }
      else { timer = setInterval(function () { window.location.reload(); }, 10000); }
      try { localStorage.setItem("minima-dash-refresh", timer ? "1" : "0"); } catch (e) {}
      label();
    });
    try {
      if (localStorage.getItem("minima-dash-refresh") === "1") {
        timer = setInterval(function () { window.location.reload(); }, 10000);
      }
    } catch (e) {}
    label();
  }
})();
`;

export function shell(opts: ShellOptions): string {
  const tabs = opts.nav
    .map(
      (n) =>
        `<a href="${escapeHtml(n.href)}"${n.active ? ' aria-current="page"' : ""}>${escapeHtml(n.label)}</a>`,
    )
    .join("");
  const options = [
    `<option value=""${opts.scope === null ? " selected" : ""}>All projects</option>`,
    ...opts.projects.map(
      (p) =>
        `<option value="${escapeHtml(p.project_key)}"${p.project_key === opts.scope ? " selected" : ""}>${escapeHtml(p.project_key)} (${p.runs})</option>`,
    ),
  ].join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(opts.title)} — Minima</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">
  <span class="brand">Minima${opts.readOnly ? '<span class="ro">read-only</span>' : '<span class="ro">writes enabled</span>'}</span>
  <nav class="tabs">${tabs}</nav>
  <span class="spacer"></span>
  <div class="controls">
    <select id="scope" aria-label="Project scope">${options}</select>
    <button class="ghost" id="refresh" type="button">Auto-refresh: off</button>
    <button class="ghost" id="theme" type="button" aria-label="Toggle theme">◐</button>
  </div>
</header>
<main>${opts.body}</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}

function kpiTiles(kpis: Kpi[]): string {
  return `<div class="kpis">${kpis
    .map(
      (k) =>
        `<div class="kpi${k.raw === null ? " nodata" : ""}">
          <div class="label">${escapeHtml(k.label)}</div>
          <div class="value">${escapeHtml(k.value)}</div>
          <div class="note">${escapeHtml(k.note)}</div>
        </div>`,
    )
    .join("")}</div>`;
}

function meter(rate: number): string {
  return `<span class="meter"><span class="track"><span class="fill" style="width:${Math.round(rate * 100)}%;background:${seqStep(rate)}"></span></span><span>${fmtPct(rate)}</span></span>`;
}

export function overviewView(payload: OverviewPayload, runs: RunSummary[], now: number): string {
  const spend: AreaPoint[] = payload.spendByDay.map((d) => ({
    label: d.day.slice(5),
    value: d.cost_usd,
    hover: `${d.day}: ${fmtUsd(d.cost_usd)} over ${d.n} decisions`,
  }));
  const models: BarRow[] = payload.models.slice(0, 10).map((m) => ({
    label: m.model,
    value: m.n,
    display: String(m.n),
    hover: `${m.n} decisions · ${fmtUsd(m.cost_usd)} · ${fmtPct(m.share)} of traffic`,
  }));
  const tiers = statusBar([
    { key: "green", label: "Green (deterministic)", icon: "✔", n: payload.gates.green },
    { key: "yellow", label: "Yellow (flag)", icon: "▲", n: payload.gates.yellow },
    { key: "red", label: "Red (stop)", icon: "✖", n: payload.gates.red },
    { key: "ungraded", label: "Ungraded", icon: "•", n: payload.gates.ungraded },
  ]);

  const scoreboard =
    payload.scoreboard.length === 0
      ? emptyState(
          `No task-type × model cell has reached n ≥ ${payload.minN} yet — small-n cells are suppressed on purpose.`,
        )
      : dataTable(payload.scoreboard.slice(0, 20), [
          { header: "Task type", cell: (c) => escapeHtml(c.taskType) },
          { header: "Model", cell: (c) => `<span class="mono">${escapeHtml(c.model)}</span>` },
          { header: "n", numeric: true, cell: (c) => String(c.n) },
          { header: "Green rate", cell: (c) => meter(c.greenRate) },
          { header: "Reds", numeric: true, cell: (c) => String(c.reds) },
          { header: "Median cost", numeric: true, cell: (c) => fmtUsd(c.medianCostUsd) },
        ]);

  return `${kpiTiles(payload.kpis)}
<section class="card">
  <h2>Realized spend per day</h2>
  ${areaChart(spend, { valueFmt: (n) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`) })}
</section>
<div class="grid-2">
  <section class="card">
    <h2>Decisions by model</h2>
    ${barChart(models)}
  </section>
  <section class="card">
    <h2>Verification gate tiers</h2>
    ${tiers}
    ${gateReasons(payload.gates)}
  </section>
</div>
<section class="card">
  <h2>Task type × model — learned outcomes</h2>
  ${scoreboard}
  <p class="note">Cells with n &lt; ${payload.minN} are suppressed; this table is advisory and never re-ranks routing.</p>
</section>
<section class="card">
  <h2>Recent sessions</h2>
  ${runsTable(runs.slice(0, 10), now)}
</section>`;
}

/** Why gates landed where they did — a tier chart without this is not actionable. */
function gateReasons(gates: OverviewPayload["gates"]): string {
  if (gates.reasons.length === 0) return "";
  const cls: Record<string, string> = { red: "bad", yellow: "warn", green: "good" };
  const rows = gates.reasons
    .map(
      (r) =>
        `<tr><td><span class="pill ${cls[r.tier] ?? ""}">${escapeHtml(r.tier)}</span></td>
         <td class="wrap">${escapeHtml(r.reason)}</td>
         <td class="num">${r.n}</td>
         <td class="num">${gates.total > 0 ? Math.round((r.n / gates.total) * 100) : 0}%</td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table>
    <thead><tr><th>Tier</th><th>Reason</th><th class="num">Gates</th><th class="num">Share</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
  <p class="note">Tier is derived the same way <span class="mono">/why</span> derives it — the stored
  <span class="mono">confidence</span> column when set, else recomputed from
  <span class="mono">factors_json</span>. Step checks are written with no stored tier by design, so
  reading the column alone would report them all as ungraded.</p>`;
}

function runsTable(runs: RunSummary[], now: number): string {
  return dataTable(
    runs,
    [
      {
        header: "Session",
        cell: (r) =>
          `<a href="/runs/${encodeURIComponent(r.run_id)}">${escapeHtml(r.display_name ?? r.run_id.slice(0, 8))}</a>`,
      },
      { header: "Project", cell: (r) => `<span class="mono">${escapeHtml(r.project_key)}</span>` },
      { header: "Status", cell: (r) => statusPill(r.status) },
      { header: "Decisions", numeric: true, cell: (r) => String(r.decisions) },
      { header: "Spend", numeric: true, cell: (r) => fmtUsd(r.cost_usd) },
      {
        header: "Tools",
        numeric: true,
        cell: (r) =>
          r.tool_errors > 0 ? `${r.tool_calls} (${r.tool_errors} err)` : String(r.tool_calls),
      },
      { header: "Updated", numeric: true, cell: (r) => escapeHtml(fmtAgo(r.updated, now)) },
    ],
    "No sessions recorded yet — run `minima` in a repo to populate the ledger.",
  );
}

function statusPill(status: string): string {
  const cls =
    status === "done" ? "good" : status === "active" ? "" : status === "degraded" ? "warn" : "bad";
  return `<span class="pill ${cls}">${escapeHtml(status)}</span>`;
}

export function runsView(runs: RunSummary[], now: number): string {
  return `<section class="card"><h2>Sessions</h2>${runsTable(runs, now)}</section>`;
}

export function runView(detail: RunDetail, now: number): string {
  const d = detail;
  const tools: BarRow[] = d.tools.map((t) => ({
    label: t.tool,
    value: t.n,
    display: t.errors > 0 ? `${t.n} · ${t.errors} err` : String(t.n),
    hover: `${t.n} calls, ${t.errors} errors`,
  }));
  return `<section class="card">
  <h2>${escapeHtml(d.run.display_name ?? d.run.run_id)}</h2>
  <p class="note"><span class="mono">${escapeHtml(d.run.run_id)}</span> · ${escapeHtml(d.run.project_key)} · ${statusPill(d.run.status)} · updated ${escapeHtml(fmtAgo(d.run.updated, now))}</p>
</section>
<div class="kpis">
  <div class="kpi"><div class="label">Decisions</div><div class="value">${d.run.decisions}</div><div class="note">routed this session</div></div>
  <div class="kpi"><div class="label">Spend</div><div class="value">${escapeHtml(fmtUsd(d.run.cost_usd))}</div><div class="note">realized cost</div></div>
  <div class="kpi"><div class="label">Tool calls</div><div class="value">${d.run.tool_calls}</div><div class="note">${d.run.tool_errors} errored</div></div>
</div>
<section class="card"><h2>Routing decisions</h2>${decisionsTable(d.decisions, now)}</section>
<div class="grid-2">
  <section class="card"><h2>Tool usage</h2>${barChart(tools)}</section>
  <section class="card"><h2>Plans</h2>${plansTable(d.plans)}</section>
</div>`;
}

function decisionsTable(rows: DecisionRecord[], now: number): string {
  return dataTable(
    rows.slice(0, 200),
    [
      { header: "When", numeric: true, cell: (r) => escapeHtml(fmtAgo(r.ts, now)) },
      { header: "Task", cell: (r) => escapeHtml(r.task_type ?? "—") },
      {
        header: "Model",
        cell: (r) => `<span class="mono">${escapeHtml(r.chosen_model ?? "—")}</span>`,
      },
      {
        header: "Basis",
        cell: (r) => `<span class="pill">${escapeHtml(r.decision_basis ?? "—")}</span>`,
      },
      { header: "Routed", cell: (r) => escapeHtml(r.routed) },
      {
        header: "Outcome",
        cell: (r) =>
          r.outcome
            ? `<span class="pill ${outcomeClass(r.outcome)}">${escapeHtml(r.outcome)}</span>`
            : '<span class="pill">unlabeled</span>',
      },
      {
        header: "Quality",
        numeric: true,
        cell: (r) => (r.judged && r.quality !== null ? r.quality.toFixed(2) : "abstain"),
      },
      { header: "Cost", numeric: true, cell: (r) => fmtUsd(r.actual_cost_usd) },
      {
        header: "Latency",
        numeric: true,
        cell: (r) => (r.latency_ms === null ? "—" : `${Math.round(r.latency_ms)}ms`),
      },
    ],
    "No routing decisions recorded.",
  );
}

function outcomeClass(outcome: string): string {
  if (outcome === "success") return "good";
  if (outcome === "partial") return "warn";
  if (outcome === "failure") return "bad";
  return "";
}

export function routingView(
  payload: OverviewPayload,
  decisions: DecisionRecord[],
  now: number,
): string {
  const table = dataTable(
    payload.models,
    [
      { header: "Model", cell: (m) => `<span class="mono">${escapeHtml(m.model)}</span>` },
      { header: "Decisions", numeric: true, cell: (m) => String(m.n) },
      { header: "Share", cell: (m) => meter(m.share) },
      { header: "Spend", numeric: true, cell: (m) => fmtUsd(m.cost_usd) },
      { header: "Cost/call", numeric: true, cell: (m) => fmtUsd(m.costPerCall) },
      {
        header: "Avg quality",
        numeric: true,
        cell: (m) => (m.avgQuality === null ? "—" : `${m.avgQuality.toFixed(2)} (n=${m.judged_n})`),
      },
      {
        header: "Avg latency",
        numeric: true,
        cell: (m) => (m.avgLatencyMs === null ? "—" : `${Math.round(m.avgLatencyMs)}ms`),
      },
    ],
    "No routing decisions recorded yet.",
  );
  return `<section class="card"><h2>Model mix</h2>${table}
  <p class="note">Avg quality is over judged rows only — abstentions are excluded, not counted as zero.</p></section>
<section class="card"><h2>Recent decisions</h2>${decisionsTable(decisions, now)}</section>`;
}

function plansTable(plans: PlanSummary[]): string {
  return dataTable(
    plans,
    [
      { header: "Plan", cell: (p) => escapeHtml(p.title ?? p.id.slice(0, 8)) },
      { header: "Status", cell: (p) => `<span class="pill">${escapeHtml(p.status ?? "—")}</span>` },
      {
        header: "Steps",
        cell: (p) => (p.steps > 0 ? meter(p.done / p.steps) : "—"),
      },
      { header: "Done", numeric: true, cell: (p) => `${p.done}/${p.steps}` },
      { header: "Gates", numeric: true, cell: (p) => String(p.gates) },
      {
        header: "Session",
        cell: (p) =>
          p.session_id
            ? `<a href="/runs/${encodeURIComponent(p.session_id)}" class="mono">${escapeHtml(p.session_id.slice(0, 8))}</a>`
            : "—",
      },
    ],
    "No plans recorded yet.",
  );
}

export function plansView(plans: PlanSummary[], gates: OverviewPayload["gates"]): string {
  return `<section class="card">
  <h2>Verification gate tiers</h2>
  ${statusBar([
    { key: "green", label: "Green (deterministic)", icon: "✔", n: gates.green },
    { key: "yellow", label: "Yellow (flag)", icon: "▲", n: gates.yellow },
    { key: "red", label: "Red (stop)", icon: "✖", n: gates.red },
    { key: "ungraded", label: "Ungraded", icon: "•", n: gates.ungraded },
  ])}
</section>
<section class="card"><h2>Plans</h2>${plansTable(plans)}</section>`;
}

export function memoryView(rows: MemorySummary[], now: number, allowWrites: boolean): string {
  const controls = (m: MemorySummary): string => {
    if (!allowWrites) return '<span class="pill">read-only</span>';
    const btn = (status: string, label: string) =>
      `<button class="ghost" type="submit" name="status" value="${status}">${label}</button>`;
    return `<form method="post" action="/api/v1/memories/${encodeURIComponent(m.id)}/status" style="display:flex;gap:4px">
      ${btn("pinned", "Pin")}${btn("active", "Confirm")}${btn("rejected", "Reject")}
    </form>`;
  };
  const table = dataTable(
    rows,
    [
      { header: "Kind", cell: (m) => `<span class="pill">${escapeHtml(m.kind)}</span>` },
      {
        header: "Status",
        cell: (m) =>
          `<span class="pill ${m.status === "pinned" || m.status === "active" ? "good" : m.status === "rejected" ? "bad" : "warn"}">${escapeHtml(m.status)}</span>`,
      },
      { header: "Content", cell: (m) => `<span class="wrap">${escapeHtml(m.content)}</span>` },
      { header: "Origin", cell: (m) => escapeHtml(`${m.origin}/${m.evidence_source}`) },
      { header: "Updated", numeric: true, cell: (m) => escapeHtml(fmtAgo(m.updated, now)) },
      { header: "", cell: controls },
    ],
    "No memories curated yet.",
  );
  const banner = allowWrites
    ? `<div class="banner">Writes are enabled. Status changes go through the same audited path as <span class="mono">/memory</span> — every change appends a <span class="mono">memory_events</span> row. Deletes are not exposed here.</div>`
    : `<div class="banner">Read-only. Start with <span class="mono">--allow-writes</span> to enable memory status changes from the browser.</div>`;
  return `${banner}<section class="card"><h2>Memory ledger</h2>${table}</section>`;
}

export function costView(payload: OverviewPayload, budgets: BudgetSummary[], now: number): string {
  const spend: AreaPoint[] = payload.spendByDay.map((d) => ({
    label: d.day.slice(5),
    value: d.cost_usd,
    hover: `${d.day}: ${fmtUsd(d.cost_usd)} over ${d.n} decisions`,
  }));
  const budgetTable = dataTable(
    budgets,
    [
      { header: "Scope", cell: (b) => `<span class="mono">${escapeHtml(b.scope_key)}</span>` },
      { header: "Mode", cell: (b) => `<span class="pill">${escapeHtml(b.mode)}</span>` },
      {
        header: "Used",
        cell: (b) => (b.limit_usd > 0 ? meter(Math.min(1, b.spent_usd / b.limit_usd)) : "—"),
      },
      { header: "Spent", numeric: true, cell: (b) => fmtUsd(b.spent_usd) },
      { header: "Reserved", numeric: true, cell: (b) => fmtUsd(b.reserved_usd) },
      { header: "Limit", numeric: true, cell: (b) => fmtUsd(b.limit_usd) },
      { header: "Updated", numeric: true, cell: (b) => escapeHtml(fmtAgo(b.updated, now)) },
    ],
    "No budget scopes recorded.",
  );
  return `${kpiTiles(payload.kpis.filter((k) => k.key !== "runs" && k.key !== "gate_green"))}
<section class="card"><h2>Realized spend per day</h2>${areaChart(spend, { valueFmt: (n) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`) })}</section>
<section class="card"><h2>Budget ledger</h2>${budgetTable}</section>`;
}

export function notFoundView(path: string): string {
  return `<section class="card"><h2>Not found</h2><p class="empty">Nothing at <span class="mono">${escapeHtml(path)}</span>.</p><p class="note"><a href="/">Back to overview</a></p></section>`;
}
