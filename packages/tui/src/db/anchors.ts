/**
 * Anchor repricing — "what would this ledger have cost if one model had answered every turn?"
 *
 * The tiles used to subtract a per-call ESTIMATE from a per-turn REALIZED cost. Those are not the
 * same unit: realized spend on a real ledger runs ~10.75x the routing estimate, because a routed
 * "turn" is a whole agent turn (tool loops, retries, cache writes) while `est_cost_usd` prices one
 * call. Subtracting them made a generous anchor read as a $34 LOSS.
 *
 * `routing_decisions` stores no token columns, so realized tokens cannot be recovered. What it does
 * store makes a price RATIO recoverable, and the ratio is the honest unit:
 *
 *     anchor_realized = actual x (est_anchor / est_chosen)
 *
 * Two tiers, distinguished because they rest on very different amounts of evidence:
 *
 *  - DIRECT   the anchor is in this row's own `ranked[]`, so both estimates were produced by the
 *             same estimator against the same prompt. Needs no price table at all — just two
 *             numbers the ledger already holds. On a real ledger this covers 96% of the money.
 *  - SOLVED   the anchor was not a candidate. Recover an estimated token vector (E_in, E_out) by
 *             least squares over the row's candidates at catalog prices, then price the anchor with
 *             it. Verified: one vector reproduces every candidate's estimate exactly on 375/423
 *             rows (median relative residual 0.0000).
 *
 * Excluded, and COUNTED rather than guessed: fewer than two priced candidates, a degenerate solve
 * (every candidate sharing one input:output price ratio, which leaves the vector underdetermined),
 * a non-physical solution, or no usable chosen-model estimate to divide by.
 *
 * The one assumption, which every caller must surface: the realized input:output mix matches the
 * row's ESTIMATED mix. That is unverifiable from stored data. Sensitivity on a real ledger is
 * about +/-6% on dollars and +/-1pp on the percentage.
 *
 * Pure over row arrays — no Bun, no DB handle — so both the dashboard and the TUI's /cost read the
 * same function and cannot disagree.
 */

import { SEED_MODELS } from "../ai/seed_models.ts";

/** USD per million tokens, the unit the catalog is written in. */
export interface PriceRow {
  input: number;
  output: number;
}

/** The row shape this module needs: a subset of `routing_decisions`. */
export interface AnchorRowLike {
  chosen_model: string | null;
  actual_cost_usd: number | null;
  est_cost_usd: number | null;
  threshold_used: number | null;
  routed: string;
  /** JSON `Ranking[]` as persisted by the router. */
  ranked: string | null;
}

export type AnchorTier = "direct" | "solved" | "excluded";

export interface AnchorTotals {
  modelId: string;
  /** Realized spend repriced onto this model, over the rows it could price. */
  anchorUsd: number;
  /** Realized spend over those SAME rows — the apples-to-apples denominator. */
  actualUsd: number;
  /** anchorUsd - actualUsd. Negative means routing cost more than this model would have. */
  savedUsd: number;
  /** savedUsd / anchorUsd; null when the anchor priced nothing. */
  savedPct: number | null;
  directRows: number;
  solvedRows: number;
  /** Server rows this anchor could NOT price. Counted, never guessed at. */
  excludedRows: number;
  /**
   * Rows where the anchor's own predicted success missed that row's threshold, over the rows where
   * that is knowable (direct tier only — a solved row has no predicted success for the anchor).
   * This is the counterweight to a negative saving: a cheap model "saves" money on turns it would
   * have failed.
   */
  tauMissRows: number;
  tauKnownRows: number;
}

export interface AnchorBoard {
  /** One entry per model this ledger actually routed to, most expensive anchor first. */
  models: AnchorTotals[];
  /** Realized spend over the routed population — the reference line for the chart. */
  realizedUsd: number;
  serverRows: number;
  /** The most-chosen model over the routed population (NOT over all rows — see below). */
  workhorse: string | null;
}

interface Candidate {
  modelId: string;
  estCostUsd: number;
  predictedSuccess: number | null;
}

interface RankedLike {
  modelId?: string;
  estCostUsd?: number;
  predictedSuccess?: number;
}

/** Build a price table from anything catalog-shaped, so tests need no catalog. */
export function pricesFrom(
  models: readonly { id: string; cost: { input: number; output: number } }[],
): Map<string, PriceRow> {
  const out = new Map<string, PriceRow>();
  for (const m of models) out.set(m.id, { input: m.cost.input, output: m.cost.output });
  return out;
}

/** Catalog prices. One table, imported by every caller, so no two screens can disagree. */
export const CATALOG_PRICES: ReadonlyMap<string, PriceRow> = pricesFrom(SEED_MODELS);

/**
 * `anthropic/claude-sonnet-5` and `claude-sonnet-5` are ONE model, and a real ledger contains both
 * spellings. Grouping without this splits one model into two bars and misses the price lookup on
 * the prefixed half.
 *
 * The provider segment is stripped only when the remainder is a model we know, because ids like
 * `moonshotai/kimi-k2.6` and `z-ai/glm-5.2` carry the slash as part of their real id. A merge we
 * cannot verify is not performed.
 */
export function normalizeModelId(
  id: string,
  known: ReadonlySet<string> = new Set(CATALOG_PRICES.keys()),
): string {
  if (known.has(id)) return id;
  const cut = id.indexOf("/");
  if (cut < 0) return id;
  const tail = id.slice(cut + 1);
  return known.has(tail) ? tail : id;
}

function candidatesOf(row: AnchorRowLike, known: ReadonlySet<string>): Candidate[] {
  if (!row.ranked) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.ranked);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Candidate[] = [];
  for (const raw of parsed as RankedLike[]) {
    if (typeof raw?.modelId !== "string" || typeof raw.estCostUsd !== "number") continue;
    if (!Number.isFinite(raw.estCostUsd)) continue;
    out.push({
      modelId: normalizeModelId(raw.modelId, known),
      estCostUsd: raw.estCostUsd,
      predictedSuccess: typeof raw.predictedSuccess === "number" ? raw.predictedSuccess : null,
    });
  }
  return out;
}

/**
 * Least-squares recovery of the row's estimated token vector from its candidates' estimates at
 * catalog prices: each candidate contributes `est_i = a_i * E_in + b_i * E_out`.
 *
 * Returns null rather than a guess when the system is underdetermined (fewer than two priced
 * candidates, or every candidate sharing one input:output ratio) or the solution is non-physical.
 */
function solveTokens(
  cands: readonly Candidate[],
  prices: ReadonlyMap<string, PriceRow>,
): { inTok: number; outTok: number } | null {
  let saa = 0;
  let sab = 0;
  let sbb = 0;
  let sae = 0;
  let sbe = 0;
  let n = 0;
  const ratios = new Set<number>();
  for (const c of cands) {
    const p = prices.get(c.modelId);
    if (!p) continue;
    const a = p.input / 1e6;
    const b = p.output / 1e6;
    if (a <= 0 && b <= 0) continue;
    n += 1;
    ratios.add(b > 0 ? a / b : Number.POSITIVE_INFINITY);
    saa += a * a;
    sab += a * b;
    sbb += b * b;
    sae += a * c.estCostUsd;
    sbe += b * c.estCostUsd;
  }
  // Two distinct price RATIOS are what make the vector identifiable — two candidates that merely
  // differ in level (3/15 and 6/30) span the same line and leave it underdetermined.
  if (n < 2 || ratios.size < 2) return null;
  const det = saa * sbb - sab * sab;
  const scale = saa * sbb;
  if (!(scale > 0) || Math.abs(det) < 1e-12 * scale) return null;
  const inTok = (sae * sbb - sbe * sab) / det;
  const outTok = (sbe * saa - sae * sab) / det;
  if (!Number.isFinite(inTok) || !Number.isFinite(outTok)) return null;
  if (inTok < 0 || outTok < 0) return null;
  return { inTok, outTok };
}

export interface RowReprice {
  tier: AnchorTier;
  /** Realized spend repriced onto the anchor; 0 when excluded. */
  anchorUsd: number;
  /** This row's realized spend, echoed back so callers sum a matching denominator. */
  actualUsd: number;
  /** Whether the anchor's predicted success cleared this row's threshold; null when unknowable. */
  tauCleared: boolean | null;
}

const EXCLUDED: RowReprice = { tier: "excluded", anchorUsd: 0, actualUsd: 0, tauCleared: null };

export function repriceRow(
  row: AnchorRowLike,
  anchorId: string,
  prices: ReadonlyMap<string, PriceRow> = CATALOG_PRICES,
  known: ReadonlySet<string> = new Set(prices.keys()),
): RowReprice {
  const actual = row.actual_cost_usd ?? 0;
  const cands = candidatesOf(row, known);
  const chosenId = row.chosen_model ? normalizeModelId(row.chosen_model, known) : null;
  const chosenEst =
    cands.find((c) => c.modelId === chosenId)?.estCostUsd ?? row.est_cost_usd ?? null;
  // No usable estimate for what actually ran means no ratio, so no honest repricing.
  if (chosenEst === null || !(chosenEst > 0)) return EXCLUDED;

  const direct = cands.find((c) => c.modelId === anchorId);
  if (direct) {
    const tau = row.threshold_used;
    return {
      tier: "direct",
      anchorUsd: actual * (direct.estCostUsd / chosenEst),
      actualUsd: actual,
      tauCleared:
        direct.predictedSuccess === null || tau === null ? null : direct.predictedSuccess >= tau,
    };
  }

  const anchorPrice = prices.get(anchorId);
  if (!anchorPrice) return EXCLUDED;
  const tokens = solveTokens(cands, prices);
  if (!tokens) return EXCLUDED;
  const estAnchor = (tokens.inTok * anchorPrice.input + tokens.outTok * anchorPrice.output) / 1e6;
  if (!Number.isFinite(estAnchor) || estAnchor < 0) return EXCLUDED;
  return {
    tier: "solved",
    anchorUsd: actual * (estAnchor / chosenEst),
    actualUsd: actual,
    tauCleared: null,
  };
}

/** Rows that were actually routed by the service — the only population an anchor can speak for. */
function routedRows(rows: readonly AnchorRowLike[]): AnchorRowLike[] {
  return rows.filter((r) => r.routed === "server");
}

export function anchorTotals(
  rows: readonly AnchorRowLike[],
  anchorId: string,
  prices: ReadonlyMap<string, PriceRow> = CATALOG_PRICES,
): AnchorTotals {
  const known = new Set(prices.keys());
  const out: AnchorTotals = {
    modelId: anchorId,
    anchorUsd: 0,
    actualUsd: 0,
    savedUsd: 0,
    savedPct: null,
    directRows: 0,
    solvedRows: 0,
    excludedRows: 0,
    tauMissRows: 0,
    tauKnownRows: 0,
  };
  for (const row of routedRows(rows)) {
    const r = repriceRow(row, anchorId, prices, known);
    if (r.tier === "excluded") {
      out.excludedRows += 1;
      continue;
    }
    if (r.tier === "direct") out.directRows += 1;
    else out.solvedRows += 1;
    out.anchorUsd += r.anchorUsd;
    out.actualUsd += r.actualUsd;
    if (r.tauCleared !== null) {
      out.tauKnownRows += 1;
      if (!r.tauCleared) out.tauMissRows += 1;
    }
  }
  out.savedUsd = out.anchorUsd - out.actualUsd;
  out.savedPct = out.anchorUsd > 0 ? out.savedUsd / out.anchorUsd : null;
  return out;
}

/**
 * The models this ledger has real evidence for: every model it routed TO, plus every model the
 * router put in a candidate set. Normalized and deduped.
 *
 * Deliberately NOT the 20-entry catalog. The line is direct evidence, not popularity: a model that
 * was a candidate on 413 rows is direct-tier on all 413 even if it was never picked, while a model
 * the router never proposed would be 100% solved-tier — pure inference about something that never
 * entered a decision. On a real ledger both sets are the same 9 models; the union is what makes the
 * generous anchor available on a ledger where routing never chose it.
 */
export function ledgerModels(
  rows: readonly AnchorRowLike[],
  known?: ReadonlySet<string>,
): string[] {
  const ids = known ?? new Set(CATALOG_PRICES.keys());
  const seen = new Set<string>();
  for (const r of routedRows(rows)) {
    if (r.chosen_model) seen.add(normalizeModelId(r.chosen_model, ids));
    for (const c of candidatesOf(r, ids)) seen.add(c.modelId);
  }
  return [...seen].sort();
}

/**
 * The most-chosen model over the ROUTED population, which is not the same as over all rows: on a
 * real ledger `claude-haiku-4-5` is 107 chosen but only 48 routed, so "most chosen" flips with the
 * denominator. Computing it over any other population would label the board with a model chosen
 * mostly by rows the anchors cannot price.
 */
export function workhorse(
  rows: readonly AnchorRowLike[],
  known?: ReadonlySet<string>,
): string | null {
  const ids = known ?? new Set(CATALOG_PRICES.keys());
  const counts = new Map<string, number>();
  for (const r of routedRows(rows)) {
    if (!r.chosen_model) continue;
    const id = normalizeModelId(r.chosen_model, ids);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [id, n] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

export function anchorBoard(
  rows: readonly AnchorRowLike[],
  prices: ReadonlyMap<string, PriceRow> = CATALOG_PRICES,
): AnchorBoard {
  const known = new Set(prices.keys());
  const routed = routedRows(rows);
  const models = ledgerModels(rows, known)
    .map((id) => anchorTotals(rows, id, prices))
    .sort((a, b) => b.anchorUsd - a.anchorUsd || a.modelId.localeCompare(b.modelId));
  return {
    models,
    realizedUsd: routed.reduce((s, r) => s + (r.actual_cost_usd ?? 0), 0),
    serverRows: routed.length,
    workhorse: workhorse(rows, known),
  };
}

/**
 * The anchor a screen shows before the user picks one: the premium Anthropic model when this
 * ledger has it (it is the generous comparison, and the best-evidenced one — 413 of 424 routed
 * rows carry it as a candidate), otherwise the most expensive anchor the ledger can price.
 */
export const PREFERRED_ANCHOR = "claude-opus-4-8";

export function defaultAnchor(board: AnchorBoard): string | null {
  if (board.models.some((m) => m.modelId === PREFERRED_ANCHOR)) return PREFERRED_ANCHOR;
  return board.models[0]?.modelId ?? null;
}

/**
 * Dollar coverage, not row coverage. A `gpt-5.6-luna` row with $0.00 realized is repriced to $0.00
 * however premium the anchor is, so it counts toward rows-priced while contributing nothing to the
 * comparison. "413 of 424 rows" over-claims; the share of MONEY priced is the honest disclosure.
 */
export function dollarCoverage(totals: AnchorTotals, realizedUsd: number): number | null {
  return realizedUsd > 0 ? totals.actualUsd / realizedUsd : null;
}
